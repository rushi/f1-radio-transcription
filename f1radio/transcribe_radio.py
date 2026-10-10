"""Polls F1 team radio clips, downloads new ones, and transcribes them with faster-whisper.

Usage:
  uv run transcribe-radio                      poll MultiViewer every 30s
  uv run transcribe-radio --source openf1      poll OpenF1 (needs OPEN_F1_USERNAME/PASSWORD in .env)
  uv run transcribe-radio --once               single pass, then exit
  uv run transcribe-radio --source openf1 --session 9158 --once   past session from OpenF1

Writes <out>/current.json every pass for the server, and only transcribes drivers listed in
<out>/selection.json (empty or missing means all drivers)."""

import argparse
import asyncio
import os
import posixpath
import re
import sys
from urllib.parse import urlparse

import aiohttp

from f1radio.cli import DATA_DIR, ROOT, run
from f1radio.json_file import append_line, write_file_atomic, write_json_atomic
from f1radio.jsonl import read_jsonl
from f1radio.laps import lap_at, should_record_lap
from f1radio.multiviewer import query_multiviewer
from f1radio.selection import pick_clips_to_process, read_selection
from f1radio.team_colors import apply_team_colors, read_team_color_overrides
from f1radio.values import now_iso, now_ms, parse_time, to_int, to_iso, to_json_line
from f1radio.whisper import DEFAULT_MODEL, Transcriber

LIVETIMING_STATIC_URL = "https://livetiming.formula1.com/static/"
OPENF1_URL = "https://api.openf1.org"
SOURCES = ("multiviewer", "openf1")
ENV_LINE_PATTERN = re.compile(r"\s*([\w.]+)\s*=\s*(.*?)\s*", re.ASCII)
QUOTED_PATTERN = re.compile(r"""(['"])(.*)\1""", re.DOTALL)

# One pass transcribes its whole batch before re-fetching, so a long pass blocks every clip that arrives meanwhile.
# Capping the batch (newest first) keeps a backfill from delaying a live clip by more than one small batch.
MAX_CLIPS_PER_PASS = 4

IS_COLOR = bool(os.environ.get("FORCE_COLOR")) or sys.stdout.isatty()


def paint(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if IS_COLOR else text


def dim(text: str) -> str:
    return paint("2", text)


def cyan(text: str) -> str:
    return paint("36", text)


def yellow(text: str) -> str:
    return paint("33", text)


def red(text: str) -> str:
    return paint("31", text)


def build_hotwords(*, first_names, last_names, teams, circuit) -> str:
    """Racing jargon lives in the whisper prompt. Hotwords carry only per-session names."""
    terms = [*last_names, *first_names, *teams, circuit]
    return " ".join(dict.fromkeys(term for term in terms if term))


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").split("\n"):
        match = ENV_LINE_PATTERN.fullmatch(line)
        if not match or line.strip().startswith("#"):
            continue
        key, raw_value = match.groups()
        quoted = QUOTED_PATTERN.fullmatch(raw_value)
        os.environ.setdefault(key, quoted.group(2) if quoted else raw_value)


def format_clip(record: dict) -> str:
    utc_ms = parse_time(record["utc"])
    clock = to_iso(utc_ms)[11:19] if utc_ms is not None else "--:--:--"
    label = record.get("driver") or f"#{record['driverNumber']}"
    return f"{dim(clock)} {cyan(label.ljust(4))} {record.get('text') or dim('(no speech)')}"


def to_session_driver(*, number, tla, name, team, team_colour) -> dict:
    return {"number": number, "tla": tla, "name": name, "team": team, "teamColour": team_colour}


class RadioTranscriber:
    def __init__(self, http: aiohttp.ClientSession, transcriber: Transcriber, args: argparse.Namespace):
        self.http = http
        self.transcriber = transcriber
        self.source = args.source
        self.out_dir = os.path.abspath(args.out)
        self.session_arg = args.session
        self.use_hotwords = not args.no_hotwords
        self.is_redo_pending = args.redo
        self.openf1_token = None
        self.openf1_token_expires_at = 0

    # ---------- MultiViewer ----------

    async def fetch_multiviewer(self) -> dict:
        query = "{ f1LiveTimingState { TeamRadio SessionInfo DriverList LapCount } }"
        response = await query_multiviewer(self.http, query)
        errors = response.get("errors")
        if errors:
            raise RuntimeError(f"MultiViewer: {errors[0].get('message')}")
        state = (response.get("data") or {}).get("f1LiveTimingState") or {}
        session = state.get("SessionInfo")
        if not session:
            raise RuntimeError("MultiViewer has no live timing session loaded")

        captures = (state.get("TeamRadio") or {}).get("Captures") or []
        driver_list = state.get("DriverList") or {}
        lap_count = state.get("LapCount") or {}
        meeting = session.get("Meeting") or {}
        drivers = [driver for driver in driver_list.values() if isinstance(driver, dict)]
        hotwords = build_hotwords(
            first_names=[driver.get("FirstName") for driver in drivers],
            last_names=[driver.get("LastName") for driver in drivers],
            teams=[driver.get("TeamName") for driver in drivers],
            circuit=(meeting.get("Circuit") or {}).get("ShortName"),
        )

        def to_clip(capture: dict) -> dict:
            driver = driver_list.get(str(capture.get("RacingNumber"))) or {}
            return {
                "utc": capture.get("Utc"),
                "driverNumber": to_int(capture.get("RacingNumber")),
                "driver": driver.get("Tla"),
                "driverName": driver.get("FullName"),
                "team": driver.get("TeamName"),
                "audioUrl": f"{LIVETIMING_STATIC_URL}{session.get('Path')}{capture.get('Path')}",
            }

        return {
            "session_key": str(session.get("Key")),
            "hotwords": hotwords,
            "lap": lap_count.get("CurrentLap"),
            "total_laps": lap_count.get("TotalLaps"),
            "drivers": [
                to_session_driver(
                    number=to_int(driver.get("RacingNumber")),
                    tla=driver.get("Tla"),
                    name=driver.get("FullName"),
                    team=driver.get("TeamName"),
                    team_colour=driver.get("TeamColour"),
                )
                for driver in drivers
                if driver.get("RacingNumber") is not None
            ],
            "session_name": f"{meeting.get('Name') or 'Unknown'} - {session.get('Name')}",
            "clips": [to_clip(capture) for capture in captures],
        }

    # ---------- OpenF1 ----------

    async def get_openf1_token(self) -> str | None:
        is_token_valid = self.openf1_token and now_ms() < self.openf1_token_expires_at - 60_000
        if is_token_valid:
            return self.openf1_token
        username = os.environ.get("OPEN_F1_USERNAME")
        password = os.environ.get("OPEN_F1_PASSWORD")
        if not username or not password:
            return None
        async with self.http.post(f"{OPENF1_URL}/token", data={"username": username, "password": password}) as response:
            if not response.ok:
                raise RuntimeError(f"OpenF1 token HTTP {response.status}: {await response.text()}")
            body = await response.json()
        self.openf1_token = body["access_token"]
        self.openf1_token_expires_at = now_ms() + int(body["expires_in"]) * 1000
        return self.openf1_token

    async def openf1_get(self, endpoint: str, params: dict) -> list:
        token = await self.get_openf1_token()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        async with self.http.get(f"{OPENF1_URL}/v1/{endpoint}", params=params, headers=headers) as response:
            if not response.ok:
                raise RuntimeError(f"OpenF1 {endpoint} HTTP {response.status}: {await response.text()}")
            return await response.json()

    async def fetch_openf1(self) -> dict:
        params = {"session_key": self.session_arg}
        sessions, radios, drivers = await asyncio.gather(
            self.openf1_get("sessions", params),
            self.openf1_get("team_radio", params),
            self.openf1_get("drivers", params),
        )
        if not sessions:
            raise RuntimeError(f"OpenF1 has no session for session_key={self.session_arg}")
        session = sessions[0]
        drivers_by_number = {driver.get("driver_number"): driver for driver in drivers}

        hotwords = build_hotwords(
            first_names=[driver.get("first_name") for driver in drivers],
            last_names=[driver.get("last_name") for driver in drivers],
            teams=[driver.get("team_name") for driver in drivers],
            circuit=session.get("circuit_short_name"),
        )

        def to_clip(radio: dict) -> dict:
            driver = drivers_by_number.get(radio.get("driver_number")) or {}
            return {
                "utc": radio.get("date"),
                "driverNumber": radio.get("driver_number"),
                "driver": driver.get("name_acronym"),
                "driverName": driver.get("full_name"),
                "team": driver.get("team_name"),
                "audioUrl": radio.get("recording_url"),
            }

        return {
            "session_key": str(session.get("session_key")),
            "hotwords": hotwords,
            # OpenF1 has no live lap count
            "lap": None,
            "total_laps": None,
            "drivers": [
                to_session_driver(
                    number=driver.get("driver_number"),
                    tla=driver.get("name_acronym"),
                    name=driver.get("full_name"),
                    team=driver.get("team_name"),
                    team_colour=driver.get("team_colour"),
                )
                for driver in drivers
            ],
            "session_name": f"{session.get('location')} - {session.get('session_name')}",
            "clips": [to_clip(radio) for radio in radios],
        }

    # ---------- Pipeline ----------

    async def download(self, url: str, file: str) -> None:
        if os.path.exists(file):
            return
        async with self.http.get(url) as response:
            if not response.ok:
                raise RuntimeError(f"download HTTP {response.status} for {url}")
            content = await response.read()
        # Atomic so a kill mid-write never leaves a truncated MP3 that a later pass reuses via the exists check
        write_file_atomic(file, content)

    async def download_all(self, clips: list[dict], session_dir: str) -> list[dict]:
        async def download_clip(clip: dict) -> dict:
            file = os.path.join(session_dir, "audio", posixpath.basename(urlparse(clip["audioUrl"]).path))
            await self.download(clip["audioUrl"], file)
            return {**clip, "file": file}

        results = await asyncio.gather(*(download_clip(clip) for clip in clips), return_exceptions=True)
        downloaded = []
        for result in results:
            if isinstance(result, Exception):
                print(yellow(str(result)), file=sys.stderr, flush=True)
                continue
            downloaded.append(result)
        return downloaded

    def record_lap(self, laps_file: str, lap) -> list[dict]:
        samples = read_jsonl(laps_file).records
        if not should_record_lap(samples, lap):
            return samples
        sample = {"utc": now_iso(), "lap": lap}
        append_line(laps_file, to_json_line(sample))
        return [*samples, sample]

    async def run_pass(self) -> bool:
        """True when pending clips remain and this pass made progress, so the loop can skip the sleep."""
        session_data = await (self.fetch_openf1() if self.source == "openf1" else self.fetch_multiviewer())
        session_key = session_data["session_key"]
        session_name = session_data["session_name"]
        clips = session_data["clips"]

        session_dir = os.path.join(self.out_dir, session_key)
        transcript_file = os.path.join(session_dir, "transcripts.jsonl")
        os.makedirs(session_dir, exist_ok=True)
        colored_drivers = apply_team_colors(session_data["drivers"], read_team_color_overrides())
        write_json_atomic(os.path.join(self.out_dir, "current.json"), {
            "sessionKey": session_key,
            "sessionName": session_name,
            "lap": session_data["lap"],
            "totalLaps": session_data["total_laps"],
            "drivers": colored_drivers,
            "updatedAt": now_iso(),
        })
        lap_samples = self.record_lap(os.path.join(session_dir, "laps.jsonl"), session_data["lap"])

        is_redo = self.is_redo_pending
        self.is_redo_pending = False
        if is_redo:
            # A new inode tells the server to reload the session instead of reading past the old end
            write_file_atomic(transcript_file, "")
        seen_urls = set() if is_redo else {record.get("audioUrl") for record in read_jsonl(transcript_file).records}
        selection = read_selection(self.out_dir)
        pending = pick_clips_to_process(clips=clips, seen_urls=seen_urls, selection=selection)

        selection_label = "all drivers" if not selection["drivers"] else f"{len(selection['drivers'])} drivers"
        batch = pending[:MAX_CLIPS_PER_PASS]
        backlog_count = len(pending) - len(batch)
        summary = f"{session_name} ({session_key}): {len(clips)} clips, {len(pending)} to transcribe for {selection_label}"
        print(dim(f"{summary}, {backlog_count} in backlog after this pass"), flush=True)
        if not batch:
            return False

        downloaded = await self.download_all(batch, session_dir)
        if not downloaded:
            return False

        hotwords = session_data["hotwords"] if self.use_hotwords else None
        skipped_count = 0
        recorded_count = 0
        for clip in downloaded:
            file = clip.pop("file")
            # Runs in a thread so SIGINT/SIGTERM still stop the loop mid-batch
            result = await asyncio.to_thread(self.transcriber.transcribe, file, hotwords)
            if "error" in result:
                print(yellow(f"transcription failed for {file}: {result['error']}"), file=sys.stderr, flush=True)
                continue
            skipped = result.get("skipped")
            record = {
                **clip,
                "sessionKey": session_key,
                "audioFile": os.path.relpath(file, self.out_dir),
                "duration": result.get("duration"),
                # Lap comes from the clip's own time, so a backfilled clip still gets the lap it was said on
                "lap": lap_at(lap_samples, clip["utc"]),
                "text": result.get("text"),
            }
            if skipped:
                record["skipped"] = skipped
            # Skipped clips are still recorded so later passes don't retry them
            append_line(transcript_file, to_json_line(record))
            recorded_count += 1
            if skipped:
                skipped_count += 1
                continue
            print(format_clip(record), flush=True)
        if skipped_count > 0:
            print(dim(f"skipped {skipped_count} short clips"), flush=True)
        # Without progress (every download or transcription failed) the same batch would retry in a hot loop
        return backlog_count > 0 and recorded_count > 0

    async def run(self, interval: float, is_once: bool) -> None:
        while True:
            has_backlog = False
            try:
                has_backlog = await self.run_pass()
            except Exception as error:
                if is_once:
                    raise
                print(red(str(error)), file=sys.stderr, flush=True)
            if is_once:
                return
            # A backlog drains back to back so it finishes sooner, each pass still re-fetching so live clips jump the queue
            if not has_backlog:
                await asyncio.sleep(interval)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download and transcribe F1 team radio clips with faster-whisper")
    parser.add_argument("--source", default="multiviewer", choices=SOURCES)
    parser.add_argument("--interval", type=float, default=30, help="seconds between passes")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="whisper model")
    parser.add_argument("--out", default=str(DATA_DIR))
    parser.add_argument("--session", default="latest", help="OpenF1 session key")
    parser.add_argument("--once", action="store_true", help="single pass, then exit")
    parser.add_argument("--no-hotwords", action="store_true", help="skip biasing Whisper toward session driver, team and circuit names")
    parser.add_argument("--redo", action="store_true", help="first pass re-transcribes every clip and replaces transcripts.jsonl; audio is reused")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    load_env()
    os.makedirs(args.out, exist_ok=True)

    async def transcribe(transcriber: Transcriber) -> None:
        async with aiohttp.ClientSession() as http:
            await RadioTranscriber(http, transcriber, args).run(args.interval, args.once)

    try:
        # Loaded before the event loop starts, because asyncio.run waits for executor threads on exit and a
        # Ctrl-C during a first-run model download would otherwise hang until it finished
        transcriber = Transcriber(args.model)
        run(lambda: transcribe(transcriber))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(red(str(error)), file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
