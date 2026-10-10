import asyncio
import os
import sys
import traceback
from collections.abc import Callable

from f1radio.clips import to_clip
from f1radio.json_file import read_json
from f1radio.jsonl import follow_jsonl, read_jsonl
from f1radio.values import now_ms

CURRENT_FILE = "current.json"


def noop(*_) -> None:
    pass


class SessionFollower:
    """Follows data/current.json and the current session's transcripts.jsonl. File reads are synchronous,
    so every load and record batch runs to completion before another one starts."""

    def __init__(
        self,
        *,
        data_dir,
        interval: float = 1.0,
        on_session: Callable[[dict], None] = noop,
        on_clip: Callable[[dict], None] = noop,
        on_reset: Callable[[], None] = noop,
    ):
        self.data_dir = data_dir
        self.interval = interval
        self.on_session = on_session
        self.on_clip = on_clip
        self.on_reset = on_reset
        self.current_file = os.path.join(data_dir, CURRENT_FILE)
        self.session = None
        self.clips: dict[str, dict] = {}
        # seq never restarts within a process, so a page holding an old seq never skips clips after a reset or session change.
        # Seeding from the clock keeps it ahead of every seq a previous process handed out, so a phone that
        # reconnects after a server restart still gets /api/clips?after=<old seq> clips instead of nothing.
        self.next_seq = now_ms()
        self.stop_tail = noop
        self.is_stopped = False
        # Bumped by each load so a reset from a replaced tail can tell it is stale
        self.generation = 0
        self.poll_task = None

    def start(self) -> None:
        self.refresh_current()
        self.poll_task = asyncio.get_running_loop().create_task(self.poll_current())

    def get_session(self) -> dict | None:
        return self.session

    def get_clips(self) -> list[dict]:
        return sorted(self.clips.values(), key=lambda clip: clip["seq"])

    def stop(self) -> None:
        self.is_stopped = True
        if self.poll_task:
            self.poll_task.cancel()
        self.stop_tail()

    def take_seq(self) -> int:
        seq = self.next_seq
        self.next_seq += 1
        return seq

    def add_records(self, records: list, is_live: bool) -> None:
        """A record with a known id replaces the earlier one (MultiViewer corrects transcriptions), and
        {id, deleted: true} removes it. Both get a fresh seq so a phone catching up sees the change."""
        for record in records:
            is_deletion = isinstance(record, dict) and record.get("deleted") is True and record.get("id") is not None
            if is_deletion:
                clip_id = str(record["id"])
                was_known = self.clips.pop(clip_id, None) is not None
                if was_known and is_live:
                    self.on_clip({"id": clip_id, "deleted": True, "seq": self.take_seq()})
                continue
            clip = to_clip(record)
            if not clip:
                continue
            existing = self.clips.get(clip["id"])
            if existing and existing["text"] == clip["text"]:
                continue
            clip_with_seq = {**clip, "seq": self.take_seq()}
            self.clips[clip["id"]] = clip_with_seq
            if is_live:
                self.on_clip(clip_with_seq)

    def load_session(self, session_key: str) -> None:
        self.generation += 1
        load_generation = self.generation
        self.stop_tail()
        file = os.path.join(self.data_dir, session_key, "transcripts.jsonl")
        snapshot = read_jsonl(file)
        self.clips = {}
        self.add_records(snapshot.records, False)

        def handle_reset() -> None:
            if self.is_stopped or load_generation != self.generation:
                return
            self.load_session(session_key)
            self.on_reset()

        self.stop_tail = follow_jsonl(
            file=file,
            from_size=snapshot.size,
            from_ino=snapshot.ino,
            interval=self.interval,
            on_records=lambda records: self.add_records(records, True),
            on_reset=handle_reset,
        )

    def refresh_current(self) -> None:
        if self.is_stopped:
            return
        next_session = read_json(self.current_file, None)
        if not isinstance(next_session, dict) or not next_session.get("sessionKey"):
            return
        session = self.session or {}
        is_new_session = str(next_session["sessionKey"]) != str(session.get("sessionKey"))
        is_updated = next_session.get("updatedAt") != session.get("updatedAt")
        if not is_new_session and not is_updated:
            return
        if is_new_session:
            self.load_session(str(next_session["sessionKey"]))
        self.session = next_session
        self.on_session(next_session)

    async def poll_current(self) -> None:
        while not self.is_stopped:
            await asyncio.sleep(self.interval)
            try:
                self.refresh_current()
            except Exception:
                traceback.print_exc(file=sys.stderr)


async def create_session_follower(**options) -> SessionFollower:
    follower = SessionFollower(**options)
    follower.start()
    return follower
