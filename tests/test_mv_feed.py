from f1radio.mv_feed import channel_topic, to_deleted_record, to_record

message = {
    "id": 2440575,
    "external_id": "74f0477664a526b3565883ed",
    "driver_number": "16",
    "transcription": "  Box, Charles, box. ",
    "player_ts": "2026-10-09T12:36:03.688000Z",
    "duration_ms": 7208,
}
drivers = {16: {"number": 16, "tla": "LEC", "name": "Charles LECLERC", "team": "Ferrari"}}


def test_to_record_maps_a_multiviewer_transcription_to_a_transcript_record():
    assert to_record(message, session_key="11379", drivers=drivers, lap=3) == {
        "id": "mv-2440575",
        "utc": "2026-10-09T12:36:03.688000Z",
        "driverNumber": 16,
        "driver": "LEC",
        "driverName": "Charles LECLERC",
        "team": "Ferrari",
        "sessionKey": "11379",
        "durationMs": 7208,
        "lap": 3,
        "text": "Box, Charles, box.",
        "source": "multiviewer-ai",
    }


def test_to_record_keeps_unknown_drivers_and_rejects_messages_without_id_or_driver_number():
    assert to_record({**message, "driver_number": "99"}, session_key="s", drivers=drivers, lap=None)["driver"] is None
    assert to_record({**message, "id": None, "external_id": None}, session_key="s", drivers=drivers, lap=None) is None
    assert to_record({**message, "driver_number": "x"}, session_key="s", drivers=drivers, lap=None) is None


def test_to_deleted_record_uses_the_same_id_as_to_record():
    assert to_deleted_record({"id": 2440575}) == {"id": "mv-2440575", "deleted": True}
    assert to_deleted_record({}) is None


def test_channel_topic_names_the_per_session_channel():
    assert channel_topic("11379") == "driver_radio_transcriptions:session:11379"
