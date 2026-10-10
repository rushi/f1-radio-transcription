import json

from f1radio.team_colors import apply_team_colors, read_team_color_overrides


def test_read_team_color_overrides_keeps_valid_team_entries_from_the_multiviewer_config(tmp_path):
    file = tmp_path / "config.json"
    file.write_text(json.dumps({
        "colorCustomizations": [
            {"type": "team", "colorHex": "#c23055", "teamName": "Red Bull Racing"},
            {"type": "driver", "colorHex": "#FFFFFF", "teamName": "Ferrari"},
            {"type": "team", "colorHex": "nope", "teamName": "Alpine"},
        ],
    }))
    assert read_team_color_overrides(file) == {"Red Bull Racing": "C23055"}
    assert read_team_color_overrides(tmp_path / "missing.json") == {}


def test_apply_team_colors_replaces_only_overridden_teams():
    drivers = [{"number": 1, "team": "McLaren", "teamColour": "F47600"}, {"number": 63, "team": "Mercedes", "teamColour": "00D7B6"}]
    colored = apply_team_colors(drivers, {"McLaren": "FF8000"})
    assert [driver["teamColour"] for driver in colored] == ["FF8000", "00D7B6"]
