import json
import os

from f1radio.json_file import read_json, write_json_atomic
from f1radio.values import is_int, now_iso, parse_time

SELECTION_FILE = "selection.json"
MAX_DRIVERS = 30


def to_whole_number(value) -> int | None:
    """JSON 16 and 16.0 are the same number, so both count as an integer."""
    if is_int(value):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def is_valid_number(number) -> bool:
    return number is not None and 0 < number < 100


def read_selection(data_dir) -> dict:
    value = read_json(os.path.join(data_dir, SELECTION_FILE), None)
    value = value if isinstance(value, dict) else {}
    drivers = value.get("drivers")
    numbers = [to_whole_number(driver) for driver in drivers] if isinstance(drivers, list) else []
    return {"drivers": [number for number in numbers if number is not None], "updatedAt": value.get("updatedAt")}


def write_selection(data_dir, drivers: list[int]) -> dict:
    selection = {"drivers": drivers, "updatedAt": now_iso()}
    write_json_atomic(os.path.join(data_dir, SELECTION_FILE), selection)
    return selection


def parse_selection_body(text: str, known_numbers: set[int] | None) -> dict:
    """known_numbers is None when no session is loaded yet, so any plausible car number is accepted."""
    try:
        body = json.loads(text)
    except ValueError:
        return {"error": "body must be JSON"}
    drivers = body.get("drivers") if isinstance(body, dict) else None
    if not isinstance(drivers, list) or len(drivers) > MAX_DRIVERS:
        return {"error": f"drivers must be an array of up to {MAX_DRIVERS} numbers"}
    numbers = [to_whole_number(driver) for driver in drivers]
    if not all(is_valid_number(number) for number in numbers):
        return {"error": "driver numbers must be integers from 1 to 99"}
    unknown = [number for number in numbers if known_numbers is not None and number not in known_numbers]
    if unknown:
        return {"error": f"unknown drivers: {', '.join(map(str, unknown))}"}
    return {"drivers": sorted(set(numbers))}


def is_selected(selection: dict, driver_number) -> bool:
    drivers = selection["drivers"]
    return not drivers or driver_number in drivers


def pick_clips_to_process(*, clips: list[dict], seen_urls: set[str], selection: dict) -> list[dict]:
    """Newest first so a backfill of a newly picked driver never delays a live clip."""
    pending = [clip for clip in clips if clip["audioUrl"] not in seen_urls and is_selected(selection, clip["driverNumber"])]
    return sorted(pending, key=lambda clip: parse_time(clip["utc"]) or 0, reverse=True)
