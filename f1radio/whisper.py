"""Transcribes audio files with faster-whisper. The model loads once per Transcriber.
Usage: uv run python -m f1radio.whisper <files...>   prints one JSON object per file"""

import argparse
import sys

from f1radio.values import to_json

# Written as radio chatter so Whisper treats it as prior context. Has its own ~224 token budget,
# separate from hotwords. Keep it under that or the start gets cut.
F1_PROMPT = (
    "Formula 1 team radio. Box box, box this lap. Stay out, box opposite. Copy, understood. "
    "Push now, hammer time. Lift and coast, harvesting, super clipping, Overtake Mode, Boost, "
    "Straight Mode, active aero, MGU-K, ERS, battery, deploy, derate. Understeer, oversteer, snap, "
    "rear locking, front lock-up, bottoming, porpoising, graining, blistering, deg, marbles, dirty air, tow. "
    "Softs, mediums, hards, inters, wets. Brake bias, diff entry, engine braking, strat mode, pit limiter. "
    "Safety car, VSC, yellow flag, blue flags, track limits, lap time deleted. Gap, delta, undercut, overcut, P1, turn one, apex, kerb. "
    "Losing three to four tenths a lap. Two tenths up, five hundredths down."
)
DEFAULT_MODEL = "small.en"
MISSING_WHISPER_MESSAGE = "faster-whisper is not installed, run: uv sync --extra whisper"


class Transcriber:
    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        device: str = "auto",
        compute_type: str = "int8",
        prompt: str = F1_PROMPT,
        min_duration: float = 3.0,
    ):
        # Imported here so the feed, server and tests run without the whisper extra
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise RuntimeError(MISSING_WHISPER_MESSAGE) from error
        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        self.prompt = prompt or None
        self.min_duration = min_duration

    def transcribe(self, file: str, hotwords: str | None = None) -> dict:
        """{file, text, duration}, {file, skipped, duration} for clips under min_duration, or {file, error}."""
        try:
            segments, info = self.model.transcribe(
                file,
                beam_size=5,
                vad_filter=True,
                initial_prompt=self.prompt,
                hotwords=hotwords or None,
            )
            # segments is lazy, so skipping here avoids decoding short clips
            if info.duration < self.min_duration:
                return {"file": file, "skipped": "too short", "duration": info.duration}
            text = " ".join(segment.text.strip() for segment in segments).strip()
            return {"file": file, "text": text, "duration": info.duration}
        except Exception as error:
            return {"file": file, "error": str(error)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe audio files with faster-whisper")
    parser.add_argument("files", nargs="+")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--prompt", default=F1_PROMPT, help='initial_prompt; pass "" to disable')
    parser.add_argument("--min-duration", type=float, default=3.0, help="skip clips shorter than this, in seconds")
    parser.add_argument("--hotwords", default=None, help="space-separated terms to bias decoding toward")
    args = parser.parse_args()

    transcriber = Transcriber(args.model, device=args.device, compute_type=args.compute_type, prompt=args.prompt, min_duration=args.min_duration)
    for file in args.files:
        result = transcriber.transcribe(file, args.hotwords)
        print(to_json(result), flush=True)
        if "error" in result:
            print(f"failed {file}: {result['error']}", file=sys.stderr)


if __name__ == "__main__":
    main()
