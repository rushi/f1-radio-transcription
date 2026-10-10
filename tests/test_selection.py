import json

from f1radio.selection import SELECTION_FILE, is_selected, parse_selection_body, pick_clips_to_process, read_selection, write_selection


def test_read_selection_defaults_to_all_drivers_when_the_file_is_missing(tmp_path):
    assert read_selection(tmp_path) == {"drivers": [], "updatedAt": None}


def test_write_selection_round_trips_through_read_selection(tmp_path):
    written = write_selection(tmp_path, [1, 81])
    assert written["drivers"] == [1, 81]
    assert written["updatedAt"]
    assert read_selection(tmp_path) == written


def test_read_selection_drops_non_integer_entries_from_a_hand_edited_file(tmp_path):
    (tmp_path / SELECTION_FILE).write_text(json.dumps({"drivers": [1, "x", 4.5, 16]}))
    assert read_selection(tmp_path)["drivers"] == [1, 16]


def test_parse_selection_body_accepts_known_drivers_dedupes_and_sorts():
    assert parse_selection_body('{"drivers":[81,1,81]}', {1, 81}) == {"drivers": [1, 81]}
    assert parse_selection_body('{"drivers":[]}', {1}) == {"drivers": []}
    assert parse_selection_body('{"drivers":[44]}', None) == {"drivers": [44]}


def test_parse_selection_body_rejects_bad_input():
    assert parse_selection_body("nope", None)["error"]
    assert parse_selection_body('{"drivers":"1"}', None)["error"]
    assert parse_selection_body('{"drivers":[1.5]}', None)["error"]
    assert parse_selection_body('{"drivers":[0]}', None)["error"]
    assert parse_selection_body(json.dumps({"drivers": list(range(1, 32))}), None)["error"]
    assert "unknown drivers: 7" in parse_selection_body('{"drivers":[7]}', {1})["error"]


def test_is_selected_treats_an_empty_selection_as_all_drivers():
    assert is_selected({"drivers": []}, 44) is True
    assert is_selected({"drivers": [1]}, 44) is False
    assert is_selected({"drivers": [1, 44]}, 44) is True


def test_pick_clips_to_process_keeps_unseen_clips_of_selected_drivers_newest_first():
    clips = [
        {"audioUrl": "a", "driverNumber": 1, "utc": "2026-10-11T12:00:00Z"},
        {"audioUrl": "b", "driverNumber": 44, "utc": "2026-10-11T12:05:00Z"},
        {"audioUrl": "c", "driverNumber": 1, "utc": "2026-10-11T12:10:00Z"},
        {"audioUrl": "d", "driverNumber": 1, "utc": "2026-10-11T12:20:00Z"},
    ]
    picked = pick_clips_to_process(clips=clips, seen_urls={"d"}, selection={"drivers": [1]})
    assert [clip["audioUrl"] for clip in picked] == ["c", "a"]


def test_pick_clips_to_process_backfills_a_newly_added_driver():
    clips = [
        {"audioUrl": "a", "driverNumber": 1, "utc": "2026-10-11T12:00:00Z"},
        {"audioUrl": "b", "driverNumber": 44, "utc": "2026-10-11T12:05:00Z"},
    ]
    seen_urls = {"a"}
    assert pick_clips_to_process(clips=clips, seen_urls=seen_urls, selection={"drivers": [1]}) == []
    picked = pick_clips_to_process(clips=clips, seen_urls=seen_urls, selection={"drivers": [1, 44]})
    assert [clip["audioUrl"] for clip in picked] == ["b"]
