import asyncio
import contextlib
import json
import os
import sys
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field

NEWLINE = b"\n"


@dataclass
class JsonlSnapshot:
    records: list = field(default_factory=list)
    size: int = 0
    ino: int = 0


def parse_lines(text: str) -> list:
    records = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        # A malformed line should not hide every record after it
        with contextlib.suppress(ValueError):
            records.append(json.loads(line))
    return records


def read_jsonl(file) -> JsonlSnapshot:
    try:
        with open(file, "rb") as handle:
            ino = os.fstat(handle.fileno()).st_ino
            data = handle.read()
    except FileNotFoundError:
        return JsonlSnapshot()
    size = data.rfind(NEWLINE) + 1
    return JsonlSnapshot(parse_lines(data[:size].decode("utf-8", errors="replace")), size, ino)


def stat_file(file) -> tuple[int, int]:
    try:
        stat = os.stat(file)
    except FileNotFoundError:
        return 0, 0
    return stat.st_size, stat.st_ino


def follow_jsonl(
    *,
    file,
    on_records: Callable[[list], None],
    on_reset: Callable[[], None],
    from_size: int = 0,
    from_ino: int = 0,
    interval: float = 1.0,
) -> Callable[[], None]:
    """Polls the file and emits records appended past from_size. File events are unreliable for appends
    on macOS, so this stats on an interval. Returns a stop function."""
    offset = from_size
    ino = from_ino
    # Kept as bytes so a multibyte character split across two reads is decoded whole
    partial = b""
    is_stopped = False

    def read_new(size: int) -> None:
        nonlocal offset, partial
        with open(file, "rb") as handle:
            handle.seek(offset)
            data = handle.read(size - offset)
        offset += len(data)
        chunk = partial + data
        end = chunk.rfind(NEWLINE) + 1
        partial = chunk[end:]
        records = parse_lines(chunk[:end].decode("utf-8", errors="replace"))
        if records and not is_stopped:
            on_records(records)

    def check() -> None:
        nonlocal offset, ino, partial
        size, current_ino = stat_file(file)
        is_replaced = ino != 0 and current_ino != 0 and current_ino != ino
        if size < offset or is_replaced:
            offset = 0
            ino = current_ino
            partial = b""
            on_reset()
            return
        ino = current_ino or ino
        if size > offset:
            read_new(size)

    # The first check runs at once, so anything written since the caller's read_jsonl is not held back a whole interval
    async def poll() -> None:
        while not is_stopped:
            try:
                check()
            except Exception:
                traceback.print_exc(file=sys.stderr)
            await asyncio.sleep(interval)

    task = asyncio.get_running_loop().create_task(poll())

    def stop() -> None:
        nonlocal is_stopped
        is_stopped = True
        task.cancel()

    return stop
