import os

from f1radio.http_utils import UNSATISFIABLE, parse_range, resolve_audio_path


def test_parse_range_handles_open_closed_and_suffix_ranges():
    assert parse_range(None, 100) is None
    assert parse_range("bytes=0-", 100) == (0, 99)
    assert parse_range("bytes=0-1", 100) == (0, 1)
    assert parse_range("bytes=90-200", 100) == (90, 99)
    assert parse_range("bytes=-10", 100) == (90, 99)


def test_parse_range_rejects_ranges_past_the_end_and_ignores_unsupported_syntax():
    assert parse_range("bytes=100-", 100) == UNSATISFIABLE
    assert parse_range("bytes=5-2", 100) == UNSATISFIABLE
    assert parse_range("bytes=-0", 100) == UNSATISFIABLE
    assert parse_range("bytes=0-1,5-6", 100) is None
    assert parse_range("items=0-1", 100) is None


def test_resolve_audio_path_keeps_paths_inside_the_session_audio_folder():
    data_dir = "/data"
    assert resolve_audio_path(data_dir, "11377", "LIN_41_20260926_142849.mp3") == os.path.join("/data", "11377", "audio", "LIN_41_20260926_142849.mp3")
    assert resolve_audio_path(data_dir, "..", "x.mp3") is None
    assert resolve_audio_path(data_dir, "11377", "../current.json") is None
    assert resolve_audio_path(data_dir, "11377", "x.wav") is None
    assert resolve_audio_path(data_dir, "11377/..", "x.mp3") is None
