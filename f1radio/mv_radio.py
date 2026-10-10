"""Streams MultiViewer's AI radio transcriptions into data/ for the server, as an alternative to
transcribe_radio. No audio is downloaded and nothing is transcribed locally.
Usage: uv run mv-radio [--out ./data] [--interval 10]
Writes <out>/current.json every poll and appends to <out>/<sessionKey>/transcripts.jsonl."""

import argparse
import asyncio
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass, field

import aiohttp

from f1radio.cli import DATA_DIR, run
from f1radio.context import build_driver_context, normalize_race_control
from f1radio.json_file import append_line, write_json_atomic
from f1radio.jsonl import read_jsonl
from f1radio.laps import lap_at, should_record_lap
from f1radio.multiviewer import query_multiviewer
from f1radio.mv_feed import connect_channel, fetch_history, to_deleted_record, to_record
from f1radio.team_colors import apply_team_colors, read_team_color_overrides
from f1radio.values import now_iso, now_ms, parse_time, to_int, to_json_line

# Timing moves every second, so the snapshot attached to a live message is refreshed far more often than current.json
TIMING_INTERVAL_SECONDS = 2
# MultiViewer delivers transcriptions 20-45s after they were said, so snapshots are kept long enough to
# look up the moment the radio happened rather than the moment it arrived
TIMING_HISTORY_MS = 180_000


@dataclass
class Feed:
    session_key: str
    lap_samples: list
    drivers: dict[int, dict]
    stop: Callable[[], None] = field(default=lambda: None)


def to_driver(entry: dict) -> dict:
    return {
        "number": to_int(entry.get("RacingNumber")),
        "tla": entry.get("Tla"),
        "name": entry.get("FullName"),
        "team": entry.get("TeamName"),
        "teamColour": entry.get("TeamColour"),
    }


def by_number(drivers: list[dict]) -> dict[int, dict]:
    return {driver["number"]: driver for driver in drivers}


class MultiViewerRadio:
    def __init__(self, http: aiohttp.ClientSession, out_dir: str):
        self.http = http
        self.out_dir = out_dir
        self.latest_timing = None
        # [(epoch ms, timing)], oldest first
        self.timing_history: list[tuple[int, dict]] = []
        self.feed: Feed | None = None
        # Strong references, since the event loop only keeps weak ones to running tasks
        self.background_tasks: set[asyncio.Task] = set()

    def remember_timing(self, timing: dict) -> None:
        now = now_ms()
        self.latest_timing = timing
        self.timing_history.append((now, timing))
        self.timing_history = [(at, snapshot) for at, snapshot in self.timing_history if now - at <= TIMING_HISTORY_MS]

    def find_timing_at(self, utc) -> dict | None:
        """Latest snapshot taken at or before the message; none when it predates the buffer."""
        time = parse_time(utc)
        found = None
        for at, timing in self.timing_history:
            if time is not None and at > time:
                break
            found = timing
        return found

    async def fetch_timing(self) -> dict:
        query = "{ f1LiveTimingState { SessionInfo TimingData TimingAppData TrackStatus RaceControlMessages } }"
        response = await query_multiviewer(self.http, query)
        state = (response.get("data") or {}).get("f1LiveTimingState") or {}
        return {
            # Sprint and Grand Prix both report Type "Race"
            "is_race": (state.get("SessionInfo") or {}).get("Type") == "Race",
            "timing_data": state.get("TimingData"),
            "timing_app_data": state.get("TimingAppData"),
            "track_status": state.get("TrackStatus"),
            "race_control": normalize_race_control(state.get("RaceControlMessages")),
        }

    def get_context(self, driver_number: int, utc) -> dict | None:
        timing = self.find_timing_at(utc)
        if not timing:
            return None
        return build_driver_context(
            driver_number=driver_number,
            timing_data=timing["timing_data"],
            timing_app_data=timing["timing_app_data"],
            track_status=timing["track_status"],
            is_race=timing["is_race"],
        )

    async def fetch_session(self) -> dict:
        query = "{ version f1LiveTimingState { SessionInfo DriverList LapCount } }"
        response = await query_multiviewer(self.http, query)
        data = response.get("data") or {}
        state = data.get("f1LiveTimingState") or {}
        session = state.get("SessionInfo")
        if not session:
            raise RuntimeError("MultiViewer has no live timing session loaded")
        driver_list = state.get("DriverList") or {}
        lap_count = state.get("LapCount") or {}
        meeting = session.get("Meeting") or {}
        entries = [entry for entry in driver_list.values() if isinstance(entry, dict) and entry.get("RacingNumber") is not None]
        return {
            "app_version": data.get("version"),
            "session_key": str(session.get("Key")),
            "meeting_key": meeting.get("Key"),
            "session_name": f"{meeting.get('Name') or 'Unknown'} - {session.get('Name')}",
            "lap": lap_count.get("CurrentLap"),
            "total_laps": lap_count.get("TotalLaps"),
            "drivers": [to_driver(entry) for entry in entries],
        }

    def run_in_background(self, coroutine) -> None:
        task = asyncio.create_task(coroutine)
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

    def start_feed(self, *, session_key: str, meeting_key, app_version: str, drivers: list[dict]) -> None:
        if self.feed:
            self.feed.stop()
        session_dir = os.path.join(self.out_dir, session_key)
        os.makedirs(session_dir, exist_ok=True)
        transcript_file = os.path.join(session_dir, "transcripts.jsonl")
        # The channel replays the session's history on every join, so known text is skipped instead of re-appended
        known_text: dict[str, str] = {}
        for record in read_jsonl(transcript_file).records:
            if record.get("deleted"):
                known_text.pop(record.get("id"), None)
                continue
            known_text[record.get("id")] = record.get("text")
        lap_samples = read_jsonl(os.path.join(session_dir, "laps.jsonl")).records
        # Drivers are set before joining because the history replay arrives as soon as the join is accepted
        feed = Feed(session_key=session_key, lap_samples=lap_samples, drivers=by_number(drivers))
        self.feed = feed

        # Appends are synchronous, so records land in the order the socket delivered them
        def handle_event(event: str, payload, is_quiet: bool = False) -> None:
            if event == "transcription_delete":
                deleted = to_deleted_record(payload)
                if not deleted or deleted["id"] not in known_text:
                    return
                del known_text[deleted["id"]]
                append_line(transcript_file, to_json_line(deleted))
                return
            if event not in ("transcription", "transcription_update") or not isinstance(payload, dict):
                return
            lap = lap_at(feed.lap_samples, payload.get("player_ts"))
            record = to_record(payload, session_key=session_key, drivers=feed.drivers, lap=lap)
            if not record:
                return
            record["context"] = self.get_context(record["driverNumber"], record["utc"])
            is_unchanged = known_text.get(record["id"]) == record["text"]
            if not record["text"] or is_unchanged:
                return
            known_text[record["id"]] = record["text"]
            append_line(transcript_file, to_json_line(record))
            if not is_quiet:
                print(f"{record['driver'] or record['driverNumber']}  {record['text']}", flush=True)

        # The channel only pushes new messages, so history is loaded after every join to fill any gap
        async def backfill() -> None:
            if meeting_key is None:
                return
            try:
                before = len(known_text)
                messages = await fetch_history(self.http, meeting_key=meeting_key, session_key=session_key)
                for message in messages:
                    handle_event("transcription", message, is_quiet=True)
                print(f"[{session_key}] history: {len(messages)} messages, {len(known_text) - before} new", flush=True)
            except Exception as error:
                print(f"[{session_key}] {error}", file=sys.stderr, flush=True)

        def handle_status(status: str) -> None:
            print(f"[{session_key}] {status}", flush=True)
            if status == "joined":
                self.run_in_background(backfill())

        feed.stop = connect_channel(session_key=session_key, app_version=app_version, on_event=handle_event, on_status=handle_status)
        print(f"following MultiViewer AI transcriptions for session {session_key} ({len(known_text)} already saved)", flush=True)

    def record_lap(self, session_key: str, lap) -> None:
        if not should_record_lap(self.feed.lap_samples, lap):
            return
        sample = {"utc": now_iso(), "lap": lap}
        self.feed.lap_samples.append(sample)
        append_line(os.path.join(self.out_dir, session_key, "laps.jsonl"), to_json_line(sample))

    async def poll(self) -> None:
        session = await self.fetch_session()
        write_json_atomic(os.path.join(self.out_dir, "current.json"), {
            "sessionKey": session["session_key"],
            "sessionName": session["session_name"],
            "lap": session["lap"],
            "totalLaps": session["total_laps"],
            "drivers": apply_team_colors(session["drivers"], read_team_color_overrides()),
            "raceControl": (self.latest_timing or {}).get("race_control", []),
            "updatedAt": now_iso(),
        })
        if not self.feed or self.feed.session_key != session["session_key"]:
            self.start_feed(
                session_key=session["session_key"],
                meeting_key=session["meeting_key"],
                app_version=session["app_version"],
                drivers=session["drivers"],
            )
        self.feed.drivers = by_number(session["drivers"])
        self.record_lap(session["session_key"], session["lap"])

    async def poll_timing(self) -> None:
        while True:
            try:
                self.remember_timing(await self.fetch_timing())
            except Exception as error:
                print(f"timing: {error}", file=sys.stderr, flush=True)
            await asyncio.sleep(TIMING_INTERVAL_SECONDS)

    async def run(self, interval: float) -> None:
        timing_task = asyncio.create_task(self.poll_timing())
        try:
            while True:
                try:
                    await self.poll()
                except Exception as error:
                    print(error, file=sys.stderr, flush=True)
                await asyncio.sleep(interval)
        finally:
            timing_task.cancel()
            if self.feed:
                self.feed.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream MultiViewer AI radio transcriptions into data/")
    parser.add_argument("--out", default=str(DATA_DIR))
    parser.add_argument("--interval", type=float, default=10, help="seconds between current.json updates")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    async def stream() -> None:
        async with aiohttp.ClientSession() as http:
            await MultiViewerRadio(http, out_dir).run(args.interval)

    run(stream)


if __name__ == "__main__":
    main()
