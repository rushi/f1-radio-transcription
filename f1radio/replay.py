"""Replays a stored session's transcripts into data/replay/ so the page can be tested without a live session.
Overwrites data/current.json, so don't run it alongside the transcriber. `race --replay` handles that.
Usage: uv run replay <sessionKey> [--speed 10] [--laps 50]"""

import argparse
import asyncio
import math
import sys

from f1radio.cli import DATA_DIR, run
from f1radio.json_file import append_line, write_file_atomic, write_json_atomic
from f1radio.jsonl import read_jsonl
from f1radio.values import now_iso, parse_time, to_json_line

REPLAY_KEY = "replay"
# Gaps between clips can be minutes even at 10x, so they are capped to keep the replay moving
MAX_GAP_SECONDS = 5
# OpenF1 sessions carry no team colours, so the replay uses the 2026 values MultiViewer reports
TEAM_COLOURS = {
    "McLaren": "F47600",
    "Red Bull Racing": "4781D7",
    "Audi": "F50537",
    "Alpine": "00A1E8",
    "Cadillac": "909090",
    "Mercedes": "00D7B6",
    "Aston Martin": "229971",
    "Ferrari": "ED1131",
    "Williams": "1868DB",
    "Racing Bulls": "6C98FF",
    "Haas F1 Team": "9C9FA2",
}


def to_driver(record: dict) -> dict:
    return {
        "number": record.get("driverNumber"),
        "tla": record.get("driver"),
        "name": record.get("driverName"),
        "team": record.get("team"),
        "teamColour": TEAM_COLOURS.get(record.get("team")),
    }


async def replay(session_key: str, speed: float, total_laps: int) -> None:
    records = read_jsonl(DATA_DIR / session_key / "transcripts.jsonl").records
    ordered = sorted((record for record in records if not record.get("skipped")), key=lambda record: parse_time(record.get("utc")) or 0)
    if not ordered:
        raise RuntimeError(f"no transcripts in data/{session_key}")

    drivers = list({record.get("driverNumber"): to_driver(record) for record in ordered}.values())
    replay_file = DATA_DIR / REPLAY_KEY / "transcripts.jsonl"
    write_file_atomic(replay_file, "")

    def write_current(lap: int) -> None:
        write_json_atomic(DATA_DIR / "current.json", {
            "sessionKey": REPLAY_KEY,
            "sessionName": f"Replay of {session_key}",
            "lap": lap,
            "totalLaps": total_laps,
            "drivers": drivers,
            "updatedAt": now_iso(),
        })

    print(f"replaying {len(ordered)} clips from {session_key} at {speed:g}x", flush=True)
    for index, record in enumerate(ordered):
        if index > 0:
            gap_ms = (parse_time(record.get("utc")) or 0) - (parse_time(ordered[index - 1].get("utc")) or 0)
            await asyncio.sleep(min(gap_ms / 1000 / speed, MAX_GAP_SECONDS))
        # Synthetic lap spread across the replay so the header and L-labels have something to show
        lap = record.get("lap")
        if lap is None:
            lap = min(total_laps, 1 + math.floor(index / len(ordered) * total_laps))
        write_current(lap)
        # Fresh utc so the page shows "now" instead of the original race time
        append_line(replay_file, to_json_line({**record, "utc": now_iso(), "lap": lap}))
        print(f"{record.get('driver') or record.get('driverNumber')}  {record.get('text')}", flush=True)
    print("replay finished", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay a stored session into data/replay/")
    parser.add_argument("session_key")
    parser.add_argument("--speed", type=float, default=10)
    parser.add_argument("--laps", type=int, default=50)
    args = parser.parse_args()
    try:
        run(lambda: replay(args.session_key, args.speed, args.laps))
    except Exception as error:
        print(error, file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
