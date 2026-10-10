from f1radio.values import is_int, parse_time


def lap_at(samples: list[dict], utc) -> int | None:
    """Samples are appended in time order, so the last one at or before the clip is the lap in progress."""
    time = parse_time(utc)
    lap = None
    for sample in samples:
        sample_time = parse_time(sample.get("utc"))
        if time is not None and sample_time is not None and sample_time > time:
            break
        lap = sample.get("lap")
    return lap


def should_record_lap(samples: list[dict], lap) -> bool:
    return is_int(lap) and (not samples or samples[-1].get("lap") != lap)
