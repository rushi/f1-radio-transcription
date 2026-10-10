import json
import os
from pathlib import Path

from f1radio.values import now_ms


def read_json(file, fallback):
    try:
        return json.loads(Path(file).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_file_atomic(file, content: str | bytes) -> None:
    """Rename gives readers either the old file or the new one, never a half-written file.
    It also changes the inode, which follow_jsonl treats as a reset."""
    path = Path(file)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{now_ms()}.tmp")
    if isinstance(content, bytes):
        temp_path.write_bytes(content)
    else:
        temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(path)


def write_json_atomic(file, value) -> None:
    write_file_atomic(file, f"{json.dumps(value, ensure_ascii=False, indent=2)}\n")


def append_line(file, line: str) -> None:
    with open(file, "a", encoding="utf-8") as handle:
        handle.write(line)
