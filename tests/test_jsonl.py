import asyncio
import os

from helpers import line, wait_for

from f1radio.json_file import read_json, write_file_atomic, write_json_atomic
from f1radio.jsonl import JsonlSnapshot, follow_jsonl, read_jsonl


def ignore(records) -> None:
    pass


def append(file, data: str | bytes) -> None:
    with open(file, "ab") as handle:
        handle.write(data.encode() if isinstance(data, str) else data)


def test_read_json_returns_fallback_for_missing_or_invalid_files(tmp_path):
    assert read_json(tmp_path / "nope.json", "fallback") == "fallback"
    (tmp_path / "bad.json").write_text("{not json")
    assert read_json(tmp_path / "bad.json", None) is None


def test_write_json_atomic_creates_parent_dirs_and_replaces_the_file(tmp_path):
    file = tmp_path / "nested" / "a.json"
    write_json_atomic(file, {"a": 1})
    first_ino = os.stat(file).st_ino
    write_json_atomic(file, {"a": 2})
    assert read_json(file, None) == {"a": 2}
    assert os.stat(file).st_ino != first_ino
    assert [name for name in os.listdir(file.parent) if name.endswith(".tmp")] == []


def test_read_jsonl_ignores_a_trailing_partial_line_and_malformed_lines(tmp_path):
    file = tmp_path / "t.jsonl"
    complete = line({"n": 1}) + "garbage\n" + line({"n": 2})
    file.write_text(f'{complete}{{"n":3')
    snapshot = read_jsonl(file)
    assert snapshot.records == [{"n": 1}, {"n": 2}]
    assert snapshot.size == len(complete.encode())
    assert snapshot.ino > 0


def test_read_jsonl_returns_empty_for_a_missing_file(tmp_path):
    assert read_jsonl(tmp_path / "missing.jsonl") == JsonlSnapshot(records=[], size=0, ino=0)


async def test_follow_jsonl_emits_appended_records_and_completes_partial_lines(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text(line({"n": 1}))
    snapshot = read_jsonl(file)
    received = []
    stop = follow_jsonl(file=file, from_size=snapshot.size, from_ino=snapshot.ino, interval=0.02, on_records=received.extend, on_reset=lambda: None)
    try:
        append(file, line({"n": 2}) + '{"n":')
        await wait_for(lambda: len(received) == 1)
        append(file, "3}\n")
        await wait_for(lambda: len(received) == 2)
        assert received == [{"n": 2}, {"n": 3}]
    finally:
        stop()


async def test_follow_jsonl_keeps_multibyte_characters_split_across_reads_intact(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text("")
    received = []
    stop = follow_jsonl(file=file, interval=0.02, on_records=received.extend, on_reset=lambda: None)
    try:
        data = '{"text":"Hülkenberg"}\n'.encode()
        split_at = data.index(0xC3) + 1
        append(file, data[:split_at])
        await asyncio.sleep(0.1)
        append(file, data[split_at:])
        await wait_for(lambda: len(received) == 1)
        assert received[0]["text"] == "Hülkenberg"
    finally:
        stop()


async def test_follow_jsonl_reports_reset_when_the_file_shrinks(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text(line({"n": 1}) + line({"n": 2}))
    snapshot = read_jsonl(file)
    resets = []
    stop = follow_jsonl(file=file, from_size=snapshot.size, from_ino=snapshot.ino, interval=0.02, on_records=ignore, on_reset=lambda: resets.append(1))
    try:
        os.truncate(file, 0)
        await wait_for(lambda: len(resets) == 1)
    finally:
        stop()


async def test_follow_jsonl_reports_reset_when_the_file_is_replaced_by_a_larger_one(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text(line({"n": 1}))
    snapshot = read_jsonl(file)
    resets = []
    stop = follow_jsonl(file=file, from_size=snapshot.size, from_ino=snapshot.ino, interval=0.02, on_records=ignore, on_reset=lambda: resets.append(1))
    try:
        write_file_atomic(file, line({"n": 10}) + line({"n": 11}) + line({"n": 12}))
        await wait_for(lambda: len(resets) == 1)
    finally:
        stop()


async def test_follow_jsonl_catches_writes_made_between_read_jsonl_and_follow_jsonl(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text(line({"n": 1}))
    snapshot = read_jsonl(file)
    append(file, line({"n": 2}))
    received = []
    # Long interval: the record must come from the startup check, not from a later poll
    stop = follow_jsonl(file=file, from_size=snapshot.size, from_ino=snapshot.ino, interval=60, on_records=received.extend, on_reset=lambda: None)
    try:
        await wait_for(lambda: len(received) == 1)
        assert received == [{"n": 2}]
    finally:
        stop()


async def test_follow_jsonl_reports_reset_when_the_file_is_truncated_between_read_jsonl_and_follow_jsonl(tmp_path):
    file = tmp_path / "t.jsonl"
    file.write_text(line({"n": 1}) + line({"n": 2}))
    snapshot = read_jsonl(file)
    os.truncate(file, 0)
    resets = []
    stop = follow_jsonl(file=file, from_size=snapshot.size, from_ino=snapshot.ino, interval=60, on_records=ignore, on_reset=lambda: resets.append(1))
    try:
        await wait_for(lambda: len(resets) == 1)
    finally:
        stop()
