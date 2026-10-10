from f1radio.context import build_driver_context, get_track_status_label, normalize_race_control

timing_app_data = {
    "Lines": {
        "1": {"Stints": [{"Compound": "MEDIUM", "TotalLaps": 1}, {"Compound": "SOFT", "TotalLaps": 12}]},
        "16": {"Stints": {"0": {"Compound": "HARD", "TotalLaps": 3}}},
    },
}


def test_build_driver_context_reads_race_position_interval_tyre_and_pit_state():
    timing_data = {
        "Lines": {
            "1": {"Position": "4", "IntervalToPositionAhead": {"Value": "+0.812"}, "InPit": False, "PitOut": True},
            "16": {"Position": "1", "IntervalToPositionAhead": {"Value": ""}},
        },
    }
    context = build_driver_context(timing_data=timing_data, timing_app_data=timing_app_data, track_status={"Status": "4"}, driver_number=1)
    assert context == {
        "position": 4,
        "gapAhead": "+0.812",
        "tyre": {"compound": "SOFT", "letter": "S", "age": 12},
        "pit": "OUT",
        "trackStatus": "SC",
        "driverLap": None,
    }
    leader = build_driver_context(timing_data=timing_data, timing_app_data=timing_app_data, track_status={"Status": "1"}, driver_number=16)
    assert leader["gapAhead"] is None
    assert leader["tyre"] == {"compound": "HARD", "letter": "H", "age": 3}
    assert leader["trackStatus"] is None


def test_build_driver_context_uses_the_qualifying_part_gap_when_there_is_no_race_interval():
    timing_data = {
        "SessionPart": 2,
        "Lines": {"1": {"Position": "6", "InPit": True, "Stats": [{"TimeDifftoPositionAhead": "+0.300"}, {"TimeDifftoPositionAhead": "+0.075"}]}},
    }
    context = build_driver_context(timing_data=timing_data, timing_app_data=timing_app_data, track_status=None, driver_number=1)
    assert context["gapAhead"] == "+0.075"
    assert context["pit"] == "PIT"


def test_build_driver_context_tolerates_missing_timing_for_a_driver():
    assert build_driver_context(timing_data={}, timing_app_data={}, track_status=None, driver_number=99) == {
        "position": None,
        "gapAhead": None,
        "tyre": None,
        "pit": None,
        "trackStatus": None,
        "driverLap": None,
    }


def test_get_track_status_label_names_the_statuses_worth_a_chip():
    assert get_track_status_label({"Status": "5"}) == "RED"
    assert get_track_status_label({"Status": "6"}) == "VSC"
    assert get_track_status_label({"Status": "2"}) is None


def test_normalize_race_control_keeps_car_specific_messages_with_utc_times():
    messages = normalize_race_control({
        "Messages": [
            {"Utc": "2026-10-09T12:53:13", "Category": "Flag", "Message": "FIRST CAR TO TAKE THE FLAG - CAR 18 (STR)", "Flag": "CHEQUERED"},
            {"Utc": "2026-10-09T12:55:03", "Category": "Other", "Message": "START OF SQ2 WILL BE DELAYED"},
            {"Utc": "2026-10-09T12:56:00", "Category": "Other", "Message": "CARS 16 (LEC) AND 44 (HAM) NOTED - UNSAFE RELEASE"},
            {"Utc": "2026-10-09T12:57:00Z", "Category": "Other", "Message": "Penalty", "RacingNumber": "4"},
        ],
    })
    assert [[message["utc"], message["cars"]] for message in messages] == [
        ["2026-10-09T12:53:13.000Z", [18]],
        ["2026-10-09T12:56:00.000Z", [16, 44]],
        ["2026-10-09T12:57:00.000Z", [4]],
    ]


def test_build_driver_context_hides_an_unconfirmed_compound():
    app_data = {"Lines": {"10": {"Stints": [{"Compound": "UNKNOWN", "TotalLaps": 0}]}}}
    context = build_driver_context(timing_data={}, timing_app_data=app_data, track_status=None, driver_number=10)
    assert context["tyre"] is None


def test_build_driver_context_gives_the_lap_being_driven_only_in_races():
    timing_data = {"Lines": {"1": {"Position": "3", "NumberOfLaps": 22}, "2": {"Position": "19", "NumberOfLaps": 21, "Retired": True}}}
    assert build_driver_context(timing_data=timing_data, driver_number=1, is_race=True)["driverLap"] == 23
    assert build_driver_context(timing_data=timing_data, driver_number=1, is_race=False)["driverLap"] is None
    assert build_driver_context(timing_data=timing_data, driver_number=2, is_race=True)["driverLap"] is None
