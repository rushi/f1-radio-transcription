"""Parsing helpers shared by the feeds, the follower and the server."""

import json
import math
import re
import time
from datetime import UTC, datetime, timedelta

LEADING_INT_PATTERN = re.compile(r"\s*([+-]?[0-9]+)", re.ASCII)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
ONE_MS = timedelta(milliseconds=1)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def parse_time(value) -> int | None:
    """Epoch milliseconds for an ISO 8601 string, or None. A value without a zone is local time."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    # Integer math, since a float timestamp can land a millisecond early. astimezone() reads a naive value as local.
    return (parsed.astimezone(UTC) - EPOCH) // ONE_MS


def to_iso(epoch_ms: int) -> str:
    """Millisecond UTC ISO string with a Z suffix, the one shape the page and data files use."""
    seconds, millis = divmod(epoch_ms, 1000)
    return f"{datetime.fromtimestamp(seconds, UTC):%Y-%m-%dT%H:%M:%S}.{millis:03d}Z"


def now_iso() -> str:
    return to_iso(now_ms())


def to_int(value) -> int | None:
    """Integer from a number or numeric string ("16", 16.0), else None. Live timing sends numbers as strings."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def parse_int(value) -> int | None:
    """Leading integer of a string ("12abc" is 12), else None."""
    if not isinstance(value, str):
        return None
    match = LEADING_INT_PATTERN.match(value)
    return int(match.group(1)) if match else None


def is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def to_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def to_json_line(value) -> str:
    return f"{to_json(value)}\n"
