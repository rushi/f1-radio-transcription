from f1radio.values import parse_int, parse_time, to_iso


def get_audio(audio_file) -> dict | None:
    """audioFile is written by the transcriber as "<sessionDir>/audio/<file>.mp3"."""
    if not isinstance(audio_file, str):
        return None
    parts = audio_file.split("/")
    if len(parts) != 3:
        return None
    session_dir, _, file_name = parts
    return {"id": file_name.removesuffix(".mp3"), "audioSrc": f"/audio/{session_dir}/{file_name}"}


def to_clip(record) -> dict | None:
    """Whisper records are keyed by their MP3; MultiViewer AI records have no audio and carry their own id."""
    if not isinstance(record, dict) or record.get("skipped") or not record.get("text"):
        return None
    audio = get_audio(record.get("audioFile"))
    clip_id = record.get("id")
    if clip_id is None and audio:
        clip_id = audio["id"]
    if clip_id is None:
        return None
    utc_ms = parse_time(record.get("utc"))
    if utc_ms is None:
        return None
    return {
        "id": str(clip_id),
        # MultiViewer sends 7 fraction digits and OpenF1 a +00:00 offset, so the page always gets one ISO shape
        "utc": to_iso(utc_ms),
        "driverNumber": record.get("driverNumber"),
        "driver": record.get("driver"),
        "lap": record.get("lap"),
        "text": record["text"],
        "audioSrc": audio["audioSrc"] if audio else None,
        "context": record.get("context"),
    }


def clips_after(clips: list[dict], after) -> list[dict]:
    after_seq = parse_int(after)
    return sorted((clip for clip in clips if after_seq is None or clip["seq"] > after_seq), key=lambda clip: clip["seq"])
