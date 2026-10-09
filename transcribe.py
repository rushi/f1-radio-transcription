"""Transcribe audio files with faster-whisper. Prints one JSON object per file to stdout."""

import argparse
import json
import sys

from faster_whisper import WhisperModel

# Written as radio chatter so Whisper treats it as prior context. Has its own ~224 token budget,
# separate from --hotwords. Keep it under that or the start gets cut.
F1_PROMPT = (
    "Formula 1 team radio. Box box, box this lap. Stay out, box opposite. Copy, understood. "
    "Push now, hammer time. Lift and coast, harvesting, super clipping, Overtake Mode, Boost, "
    "Straight Mode, active aero, MGU-K, ERS, battery, deploy, derate. Understeer, oversteer, snap, "
    "rear locking, front lock-up, bottoming, porpoising, graining, blistering, deg, marbles, dirty air, tow. "
    "Softs, mediums, hards, inters, wets. Brake bias, diff entry, engine braking, strat mode, pit limiter. "
    "Safety car, VSC, yellow flag, blue flags, track limits, lap time deleted. Gap, delta, undercut, overcut, P1, turn one, apex, kerb. "
    "Losing three to four tenths a lap. Two tenths up, five hundredths down."
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+")
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--prompt", default=F1_PROMPT, help='initial_prompt; pass "" to disable')
    parser.add_argument("--min-duration", type=float, default=3.0, help="skip clips shorter than this, in seconds")
    parser.add_argument("--hotwords", default=None, help="space-separated terms to bias decoding toward")
    args = parser.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    for file in args.files:
        try:
            segments, info = model.transcribe(
                file,
                beam_size=5,
                vad_filter=True,
                initial_prompt=args.prompt or None,
                hotwords=args.hotwords or None,
            )
            # segments is lazy, so skipping here avoids decoding short clips
            if info.duration < args.min_duration:
                print(json.dumps({"file": file, "skipped": "too short", "duration": info.duration}), flush=True)
                continue
            text = " ".join(segment.text.strip() for segment in segments).strip()
            print(json.dumps({"file": file, "text": text, "duration": info.duration}), flush=True)
        except Exception as error:
            print(json.dumps({"file": file, "error": str(error)}), flush=True)
            print(f"failed {file}: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
