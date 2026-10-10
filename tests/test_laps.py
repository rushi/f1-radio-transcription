from f1radio.laps import lap_at, should_record_lap

samples = [
    {"utc": "2026-10-11T12:00:00.000Z", "lap": 1},
    {"utc": "2026-10-11T12:01:40.000Z", "lap": 2},
    {"utc": "2026-10-11T12:03:20.000Z", "lap": 3},
]


def test_lap_at_returns_the_lap_in_progress_at_the_clip_time():
    assert lap_at(samples, "2026-10-11T12:02:00.000Z") == 2
    assert lap_at(samples, "2026-10-11T12:03:20.000Z") == 3
    assert lap_at(samples, "2026-10-11T13:00:00.000Z") == 3


def test_lap_at_returns_none_before_the_first_sample_or_with_no_samples():
    assert lap_at(samples, "2026-10-11T11:59:59.000Z") is None
    assert lap_at([], "2026-10-11T12:00:00.000Z") is None


def test_lap_at_handles_multiviewer_7_digit_fractions_and_openf1_offsets():
    assert lap_at(samples, "2026-10-11T12:02:00.5490128Z") == 2
    assert lap_at(samples, "2026-10-11T12:02:00.153000+00:00") == 2


def test_should_record_lap_only_records_integer_laps_that_changed():
    assert should_record_lap([], 1) is True
    assert should_record_lap(samples, 3) is False
    assert should_record_lap(samples, 4) is True
    assert should_record_lap(samples, None) is False
