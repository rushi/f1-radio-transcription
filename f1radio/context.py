"""Race context captured next to each radio message: where the driver is, on what tyres, and what the track
is doing. Inputs are MultiViewer's F1 live timing topics."""

import re

from f1radio.values import is_int, parse_time, to_int, to_iso

# F1 track status codes; green (1) and yellow (2) are too common to be worth a chip
TRACK_STATUS_LABELS = {4: "SC", 5: "RED", 6: "VSC", 7: "VSC ENDING"}

COMPOUND_LETTERS = {"SOFT": "S", "MEDIUM": "M", "HARD": "H", "INTERMEDIATE": "I", "WET": "W"}

RACE_CONTROL_LIMIT = 150

CARS_PATTERN = re.compile(r"\bCARS?\s+((?:\d+(?:\s*\([A-Z]{3}\))?(?:\s*,\s*|\s+AND\s+)?)+)", re.ASCII)
DIGITS_PATTERN = re.compile(r"\d+", re.ASCII)
ZONE_PATTERN = re.compile(r"(?:Z|[+-]\d{2}:\d{2})$", re.ASCII)


def to_list(value) -> list:
    """Live timing patches can turn arrays into objects keyed "0", "1", ..."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return list(value.values())
    return []


def get_at(items: list, index: int | None):
    return items[index] if index is not None and 0 <= index < len(items) else None


def get_gap_ahead(line: dict, session_part) -> str | None:
    """Race uses IntervalToPositionAhead; qualifying keeps the gap per part in Stats."""
    interval = (line.get("IntervalToPositionAhead") or {}).get("Value")
    if interval:
        return interval

    stats = to_list(line.get("Stats"))
    part_index = session_part - 1 if is_int(session_part) else len(stats) - 1
    stat = get_at(stats, part_index) or {}
    return stat.get("TimeDifftoPositionAhead") or None


def get_tyre(app_line) -> dict | None:
    stints = to_list((app_line or {}).get("Stints"))
    stint = stints[-1] if stints else {}
    compound = stint.get("Compound")
    # F1 sends UNKNOWN (or TEST_UNKNOWN) until the compound is confirmed, which is worth nothing on screen
    if not compound or "UNKNOWN" in compound:
        return None
    total_laps = stint.get("TotalLaps")
    return {
        "compound": compound,
        "letter": COMPOUND_LETTERS.get(compound, compound[0]),
        "age": total_laps if is_int(total_laps) else None,
    }


def get_pit_state(line: dict) -> str | None:
    if line.get("InPit"):
        return "PIT"
    if line.get("PitOut"):
        return "OUT"
    return None


def get_track_status_label(track_status) -> str | None:
    return TRACK_STATUS_LABELS.get(to_int((track_status or {}).get("Status")))


def get_driver_lap(line, is_race: bool) -> int | None:
    """In a race NumberOfLaps counts completed laps, so the lap being driven is one more. Outside races laps are
    not a shared count, so nothing is shown."""
    if not line or not is_race or line.get("Retired") or line.get("Stopped"):
        return None
    completed = to_int(line.get("NumberOfLaps"))
    return None if completed is None else completed + 1


def build_driver_context(*, driver_number: int, timing_data=None, timing_app_data=None, track_status=None, is_race=False) -> dict:
    timing_data = timing_data or {}
    key = str(driver_number)
    line = (timing_data.get("Lines") or {}).get(key)
    position = to_int((line or {}).get("Position"))
    has_position = position is not None and position > 0
    return {
        "position": position if has_position else None,
        "gapAhead": get_gap_ahead(line, timing_data.get("SessionPart")) if line and has_position and position > 1 else None,
        "tyre": get_tyre(((timing_app_data or {}).get("Lines") or {}).get(key)),
        "pit": get_pit_state(line) if line else None,
        "trackStatus": get_track_status_label(track_status),
        "driverLap": get_driver_lap(line, is_race),
    }


def get_cars(message: dict) -> list[int]:
    """"CAR 16 (LEC)" or "CARS 16 AND 44" in the text, or a RacingNumber field on driver-specific messages."""
    cars = {}
    racing_number = to_int(message.get("RacingNumber"))
    if racing_number is not None:
        cars[racing_number] = True
    for match in CARS_PATTERN.finditer(str(message.get("Message") or "")):
        for number in DIGITS_PATTERN.findall(match.group(1)):
            cars[int(number)] = True
    return list(cars)


def to_utc(value) -> str | None:
    """Race control Utc has no zone suffix but is UTC, so it gets a Z before parsing."""
    text = "" if value is None else str(value)
    epoch_ms = parse_time(text if ZONE_PATTERN.search(text) else f"{text}Z")
    return None if epoch_ms is None else to_iso(epoch_ms)


def normalize_race_control(race_control_messages) -> list[dict]:
    messages = []
    for message in to_list((race_control_messages or {}).get("Messages")):
        normalized = {
            "utc": to_utc(message.get("Utc")),
            "message": message.get("Message") or "",
            "category": message.get("Category"),
            "flag": message.get("Flag"),
            "cars": get_cars(message),
        }
        if normalized["utc"] and normalized["cars"]:
            messages.append(normalized)
    return messages[-RACE_CONTROL_LIMIT:]
