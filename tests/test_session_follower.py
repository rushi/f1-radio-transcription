import asyncio

import pytest
from helpers import line, wait_for

from f1radio.json_file import append_line, write_file_atomic, write_json_atomic
from f1radio.session_follower import create_session_follower


def make_record(clip_id, **overrides):
    return {"utc": "2026-10-11T12:00:00Z", "driverNumber": 1, "driver": "NOR", "audioFile": f"s1/audio/{clip_id}.mp3", "text": f"text {clip_id}", **overrides}


def clip_ids(follower):
    return [clip["id"] for clip in follower.get_clips()]


@pytest.fixture
async def setup(tmp_path):
    write_json_atomic(tmp_path / "current.json", {"sessionKey": "s1", "updatedAt": "a", "drivers": []})
    (tmp_path / "s1").mkdir()
    (tmp_path / "s1" / "transcripts.jsonl").write_text(line(make_record("one")) + line(make_record("skip", skipped="too short", text=None)))
    events = {"sessions": [], "clips": [], "resets": 0}

    def handle_reset():
        events["resets"] += 1

    follower = await create_session_follower(
        data_dir=tmp_path,
        interval=0.02,
        on_session=events["sessions"].append,
        on_clip=events["clips"].append,
        on_reset=handle_reset,
    )
    yield tmp_path, follower, events
    follower.stop()


async def test_loads_the_current_session_and_its_clips_on_start_without_skipped_records(setup):
    _, follower, events = setup
    assert follower.get_session()["sessionKey"] == "s1"
    assert clip_ids(follower) == ["one"]
    assert events["clips"] == []


async def test_emits_appended_clips_with_increasing_seq(setup):
    data_dir, follower, events = setup
    append_line(data_dir / "s1" / "transcripts.jsonl", line(make_record("two")))
    await wait_for(lambda: len(events["clips"]) == 1)
    assert events["clips"][0]["id"] == "two"
    assert events["clips"][0]["seq"] == follower.get_clips()[0]["seq"] + 1


async def test_a_restarted_follower_hands_out_seqs_above_everything_the_previous_instance_used(setup):
    data_dir, follower, events = setup
    append_line(data_dir / "s1" / "transcripts.jsonl", line(make_record("two")))
    await wait_for(lambda: len(events["clips"]) == 1)
    max_first_seq = max(clip["seq"] for clip in follower.get_clips())
    follower.stop()

    restarted = await create_session_follower(data_dir=data_dir, interval=0.02)
    try:
        restarted_seqs = [clip["seq"] for clip in restarted.get_clips()]
        assert len(restarted_seqs) == 2
        assert all(seq > max_first_seq for seq in restarted_seqs)
    finally:
        restarted.stop()


async def test_emits_session_updates_for_the_same_session_and_switches_on_a_new_session_key(setup):
    data_dir, follower, events = setup
    first_seq = follower.get_clips()[0]["seq"]
    write_json_atomic(data_dir / "current.json", {"sessionKey": "s1", "updatedAt": "b", "lap": 4, "drivers": []})
    await wait_for(lambda: any(session["updatedAt"] == "b" for session in events["sessions"]))
    assert len(follower.get_clips()) == 1

    (data_dir / "s2").mkdir()
    (data_dir / "s2" / "transcripts.jsonl").write_text(line(make_record("fp2", audioFile="s2/audio/fp2.mp3")))
    write_json_atomic(data_dir / "current.json", {"sessionKey": "s2", "updatedAt": "c", "drivers": []})
    await wait_for(lambda: follower.get_session()["sessionKey"] == "s2")
    assert clip_ids(follower) == ["fp2"]
    assert follower.get_clips()[0]["seq"] > first_seq


async def test_reloads_and_reports_reset_when_the_transcript_file_is_replaced(setup):
    data_dir, follower, events = setup
    write_file_atomic(data_dir / "s1" / "transcripts.jsonl", line(make_record("redo-a")) + line(make_record("redo-b")))
    await wait_for(lambda: events["resets"] == 1)
    assert sorted(clip_ids(follower)) == ["redo-a", "redo-b"]


async def test_starts_with_no_session_when_current_json_is_missing(tmp_path):
    follower = await create_session_follower(data_dir=tmp_path, interval=0.02)
    try:
        assert follower.get_session() is None
        assert follower.get_clips() == []
    finally:
        follower.stop()


async def test_a_transcript_reset_in_the_old_session_never_reloads_its_clips_after_a_session_switch(setup):
    data_dir, follower, _ = setup
    previous = "s1"
    for index in range(2, 10):
        next_key = f"s{index}"
        (data_dir / next_key).mkdir()
        (data_dir / next_key / "transcripts.jsonl").write_text(line(make_record(f"clip-{next_key}")))
        # Same poll window: the old tail sees a replaced file while current.json points at the new session
        write_file_atomic(data_dir / previous / "transcripts.jsonl", line(make_record(f"redo-{previous}")))
        write_json_atomic(data_dir / "current.json", {"sessionKey": next_key, "updatedAt": f"u{index}", "drivers": []})
        await wait_for(lambda key=next_key: follower.get_session()["sessionKey"] == key)
        await asyncio.sleep(0.1)
        assert clip_ids(follower) == [f"clip-{next_key}"]
        previous = next_key


async def test_stop_prevents_a_later_session_change_from_starting_a_new_tail(setup):
    data_dir, follower, _ = setup
    follower.stop()
    (data_dir / "s2").mkdir()
    (data_dir / "s2" / "transcripts.jsonl").write_text(line(make_record("fp2")))
    write_json_atomic(data_dir / "current.json", {"sessionKey": "s2", "updatedAt": "c", "drivers": []})
    await asyncio.sleep(0.15)
    assert follower.get_session()["sessionKey"] == "s1"
    assert clip_ids(follower) == ["one"]


async def test_a_record_with_a_known_id_replaces_the_clip_and_a_deleted_record_removes_it(setup):
    data_dir, follower, events = setup
    file = data_dir / "s1" / "transcripts.jsonl"
    before = follower.get_clips()[0]
    append_line(file, line({"id": "mv-9", "utc": "2026-10-11T12:00:00Z", "driverNumber": 1, "text": "first try"}))
    await wait_for(lambda: len(events["clips"]) == 1)
    append_line(file, line({"id": "mv-9", "utc": "2026-10-11T12:00:00Z", "driverNumber": 1, "text": "corrected"}))
    await wait_for(lambda: len(events["clips"]) == 2)
    assert events["clips"][1]["text"] == "corrected"
    assert events["clips"][1]["seq"] > events["clips"][0]["seq"]
    assert next(clip for clip in follower.get_clips() if clip["id"] == "mv-9")["text"] == "corrected"
    append_line(file, line({"id": "mv-9", "deleted": True}))
    await wait_for(lambda: len(events["clips"]) == 3)
    assert {"id": events["clips"][2]["id"], "deleted": events["clips"][2]["deleted"]} == {"id": "mv-9", "deleted": True}
    assert clip_ids(follower) == [before["id"]]
