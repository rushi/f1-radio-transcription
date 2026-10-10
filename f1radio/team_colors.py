import re
from pathlib import Path

from f1radio.json_file import read_json

# MultiViewer keeps the user's team color overrides (Settings > accessibility colors) in its config file
MULTIVIEWER_CONFIG_FILE = Path.home() / "Library" / "Application Support" / "MultiViewer" / "config.json"

HEX_PATTERN = re.compile(r"#?([0-9a-f]{6})", re.ASCII | re.IGNORECASE)


def read_team_color_overrides(config_file=MULTIVIEWER_CONFIG_FILE) -> dict[str, str]:
    """Read on every call so a change in MultiViewer shows up on the next poll; a missing or unreadable file
    means no overrides."""
    config = read_json(config_file, None)
    entries = config.get("colorCustomizations") if isinstance(config, dict) else None
    overrides = {}
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        color_hex = entry.get("colorHex")
        match = HEX_PATTERN.fullmatch(color_hex) if isinstance(color_hex, str) else None
        if entry.get("type") == "team" and entry.get("teamName") and match:
            overrides[entry["teamName"]] = match.group(1).upper()
    return overrides


def apply_team_colors(drivers: list[dict], overrides: dict[str, str]) -> list[dict]:
    return [{**driver, "teamColour": overrides[driver["team"]]} if driver.get("team") in overrides else driver for driver in drivers]
