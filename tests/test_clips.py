from f1radio.clips import clips_after, to_clip

record = {
    "utc": "2026-09-26T10:29:20.153000+00:00",
    "driverNumber": 41,
    "driver": "LIN",
    "driverName": "Arvid LINDBLAD",
    "team": "Racing Bulls",
    "audioUrl": "https://livetiming.formula1.com/static/x/LIN_41_20260926_142849.mp3",
    "sessionKey": "11377",
    "audioFile": "11377/audio/LIN_41_20260926_142849.mp3",
    "duration": 12.8,
    "lap": 7,
    "text": "Metallic sound on the rear.",
}


def test_to_clip_maps_a_transcript_record_to_what_the_page_needs():
    assert to_clip(record) == {
        "id": "LIN_41_20260926_142849",
        "utc": "2026-09-26T10:29:20.153Z",
        "driverNumber": 41,
        "driver": "LIN",
        "lap": 7,
        "text": "Metallic sound on the rear.",
        "audioSrc": "/audio/11377/LIN_41_20260926_142849.mp3",
        "context": None,
    }


def test_to_clip_drops_skipped_empty_and_malformed_records():
    assert to_clip({**record, "skipped": "too short", "text": None}) is None
    assert to_clip({**record, "text": ""}) is None
    assert to_clip({**record, "audioFile": "LIN.mp3"}) is None
    assert to_clip(None) is None


def test_to_clip_normalizes_multiviewer_and_openf1_utc_shapes_to_millisecond_iso():
    assert to_clip({**record, "utc": "2026-09-26T10:29:20.1530000Z"})["utc"] == "2026-09-26T10:29:20.153Z"
    assert to_clip({**record, "utc": "2026-09-26T10:29:20+00:00"})["utc"] == "2026-09-26T10:29:20.000Z"


def test_to_clip_drops_records_with_an_unparseable_utc():
    assert to_clip({**record, "utc": "not a date"}) is None
    assert to_clip({**record, "utc": None}) is None


def test_to_clip_defaults_missing_lap_to_none():
    without_lap = {key: value for key, value in record.items() if key != "lap"}
    assert to_clip(without_lap)["lap"] is None


def test_clips_after_filters_and_orders_by_seq():
    clips = [{"id": "c", "seq": 3}, {"id": "a", "seq": 1}, {"id": "b", "seq": 2}]
    assert [clip["id"] for clip in clips_after(clips, "1")] == ["b", "c"]
    assert [clip["id"] for clip in clips_after(clips, None)] == ["a", "b", "c"]
    assert [clip["id"] for clip in clips_after(clips, "junk")] == ["a", "b", "c"]


def test_to_clip_accepts_records_without_audio_when_they_carry_their_own_id():
    clip = to_clip({"id": "mv-1", "utc": "2026-10-09T12:36:03.688000Z", "driverNumber": 16, "driver": "LEC", "text": "Box box"})
    assert clip["id"] == "mv-1"
    assert clip["audioSrc"] is None
    assert clip["utc"] == "2026-10-09T12:36:03.688Z"
