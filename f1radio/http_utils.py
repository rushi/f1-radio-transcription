import os
import re

SESSION_KEY_PATTERN = re.compile(r"[\w-]{1,64}", re.ASCII)
AUDIO_FILE_PATTERN = re.compile(r"[\w-][\w.-]{0,200}\.mp3", re.ASCII)
RANGE_PATTERN = re.compile(r"bytes=([0-9]*)-([0-9]*)", re.ASCII)

UNSATISFIABLE = "unsatisfiable"


def parse_range(header: str | None, size: int) -> tuple[int, int] | str | None:
    """(start, end) inclusive, UNSATISFIABLE, or None to serve the whole file: no header, or a form we
    don't support (multiple ranges)."""
    if not header:
        return None

    match = RANGE_PATTERN.fullmatch(header.strip())
    if not match:
        return None
    start_text, end_text = match.groups()
    if start_text == "" and end_text == "":
        return None
    if start_text == "":
        suffix_length = int(end_text)
        if suffix_length == 0:
            return UNSATISFIABLE
        return max(size - suffix_length, 0), size - 1

    start = int(start_text)
    end = size - 1 if end_text == "" else min(int(end_text), size - 1)
    if start >= size or start > end:
        return UNSATISFIABLE
    return start, end


def resolve_audio_path(data_dir, session_key: str, file_name: str) -> str | None:
    if not SESSION_KEY_PATTERN.fullmatch(session_key) or not AUDIO_FILE_PATTERN.fullmatch(file_name):
        return None

    root = os.path.abspath(data_dir)
    file_path = os.path.abspath(os.path.join(root, session_key, "audio", file_name))
    return file_path if file_path.startswith(f"{root}{os.sep}") else None
