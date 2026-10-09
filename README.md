# F1 Radio Transcription

A phone-friendly page that shows Formula 1 team radio as text while a session runs, with each driver's position, gap, tyre and race control notes next to the message.

The page runs on your Mac and you open it on your phone over the same Wi-Fi. Transcripts come from MultiViewer's AI radio transcriptions by default. You can also transcribe the official F1 radio clips locally with faster-whisper.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Sources](#sources)
- [The page](#the-page)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Development](#development)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

## Requirements

- macOS (the team color overrides and the Apple speech script are macOS only)
- Node.js 24 (`.node-version` pins `24.18.0`) and pnpm
- [MultiViewer](https://multiviewer.app) running with a live or replayed F1 session open
- For the Whisper sources only: Python 3, [uv](https://docs.astral.sh/uv/) and ffmpeg
- For the OpenF1 source only: an OpenF1 account

## Installation

1. Install the Node dependencies:

   ```bash
   pnpm install
   ```

2. For the Whisper sources, create the Python environment:

   ```bash
   uv venv .venv
   ```

   ```bash
   uv pip install --python .venv/bin/python -r requirements.txt
   ```

3. For the OpenF1 source, add your credentials to `.env`:

   ```bash
   OPEN_F1_USERNAME=you@example.com
   OPEN_F1_PASSWORD=your-password
   ```

Verify the install by running the tests:

```bash
pnpm test
```

## Usage

1. Open the session you want in MultiViewer. Close any replay player, because MultiViewer's timing data follows the session you are watching.
2. Start the transcriber and web server:

   ```bash
   pnpm race
   ```

3. Scan the QR code printed in the terminal with your phone, or open the `http://<mac-ip>:10303` URL it prints. The phone must be on the same Wi-Fi as the Mac.
4. Stop everything with Ctrl-C.

On the first run, macOS asks whether `node` can accept incoming connections. Click Allow, or the phone cannot reach the page. The page cannot keep your phone awake over plain HTTP, so set iOS Auto-Lock to Never for the race.

To test the page without a live session, replay a recorded session from `data/`:

```bash
pnpm replay 11377
```

## Sources

`pnpm race` takes a `--source` flag, for example `pnpm race --source openf1`.

| Source | What it does | Audio | Latency |
| --- | --- | --- | --- |
| `multiviewer-ai` (default) | Streams MultiViewer's AI transcriptions of the full onboard team radio channels | No | About 20 to 45s after the radio |
| `multiviewer` | Downloads the official F1 radio clips listed by MultiViewer and transcribes them with faster-whisper | Yes | 10 to 20s after F1 publishes a clip |
| `openf1` | Same as `multiviewer`, but lists clips from the OpenF1 API | Yes | Same as `multiviewer` |

The default source has far more messages. F1 publishes only a handful of official clips per session, and none at all for some 2026 events. MultiViewer's backend is undocumented and needs no login today, so a MultiViewer update can change or close it. If that happens, run `pnpm race --source multiviewer`.

## The page

Each row shows the driver code, their team color, the transcript, and context captured at the moment the radio was said.

| Element | Example | Notes |
| --- | --- | --- |
| Position and gap | `P4 +0.812` | Race interval to the car ahead, or the qualifying lap gap for the current part |
| Tyre | `● M12` | Compound color and letter, plus tyre age in laps |
| Pit state | `PIT`, `OUT` | Shown while the car is in the pit lane or on an out lap |
| Track status | `SC`, `VSC`, `RED` | Green and yellow flags are not shown |
| Lap | `L23` | In races, the lap that driver is on |
| Race control | `RC CAR 3 (VER) TIME PENALTY` | Stewards' notes naming the driver, from 30s before to 2 min after the radio |

The transcript text highlights a few things:

- "Box box" (two or more boxes in a row) gets a cyan marker.
- Safety car and VSC terms show in yellow, and red flag, retire and crash show in red.
- Other drivers' names show in their team color. The speaker's own name stays plain.

Tap ✎ in the header to open the settings sheet:

- **Drivers:** pick which drivers to show. "All drivers" clears the pick.
- **Feed updates:** `Live`, `5s`, `10s` (default) or `Tap`. New messages wait and arrive in batches, so the feed does not move while you read. In `Tap` mode, messages wait until you tap the "N new · show" pill.
- **Text size:** three sizes.

The phone remembers feed pace and text size. The Mac saves the driver pick in `data/selection.json`, so every phone shares it. With the Whisper sources, the pick also limits which drivers get transcribed.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Source | `pnpm race --source <name>` | `multiviewer-ai` |
| Web server port | `PORT` environment variable for `server.mjs` | `10303` |
| Data directory | `DATA_DIR` environment variable for `server.mjs` | `./data` |
| Whisper model | `node transcribe-radio.mjs --model <name>` | `small.en` |
| Team colors | MultiViewer settings, read from `~/Library/Application Support/MultiViewer/config.json` | Official 2026 team colors |

The page lightens team colors that are too dark to read on the dark background, including your custom ones.

## How it works

```text
MultiViewer (localhost:10101 GraphQL + its backend socket)
        │
        ▼
mv-radio.mjs or transcribe-radio.mjs   writes data/current.json, data/<session>/transcripts.jsonl
        │
        ▼
server.mjs                             follows those files, serves the page, pushes new clips over SSE
        │
        ▼
web/index.html on your phone
```

- `race.mjs` starts the feed and the server together, restarts either one if it crashes, and prints the phone URL and QR code.
- `mv-radio.mjs` joins MultiViewer's `driver_radio_transcriptions:session:<key>` channel, loads the session's history after every join, and polls MultiViewer's live timing every 2s for context.
- `transcribe-radio.mjs` lists radio clips, downloads new ones, and runs `transcribe.py` (faster-whisper with an F1 vocabulary prompt and the session's driver names as hotwords).
- `replay.mjs` replays a recorded session into `data/replay/` for testing.
- `apple-transcribe.swift` transcribes MP3s with macOS's on-device speech recognition. It is a comparison tool, not part of the pipeline.

## Development

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the `node:test` suite in `test/` |
| `pnpm race` | Starts the feed and web server |
| `pnpm replay <sessionKey>` | Replays a recorded session with the web server |
| `node transcribe-radio.mjs --once --source openf1 --session 9896` | Transcribes one past OpenF1 session |
| `node transcribe-radio.mjs --once --redo` | Re-transcribes a session's saved audio |

`data/` holds downloaded audio, transcripts and session state. It is gitignored.

## Limitations

- **Context needs a running feed:** messages loaded from history after a restart, and radio said before the feed started, have no position or tyre context.
- **MultiViewer's backend is undocumented:** the default source can stop working after a MultiViewer update.
- **Same Wi-Fi only:** the server has no authentication and is meant for your local network.
- **Missed deletions:** if MultiViewer deletes a message while your phone is locked, the row stays until you reload the page.

## Contributing

Issues and pull requests are welcome. Before you open a pull request:

1. Run the tests and make sure they pass:

   ```bash
   pnpm test
   ```

2. Keep changes to one concern per pull request.
3. Never commit `.env`, `data/` or anything with real credentials.

## Disclaimer

This is an unofficial fan project. It is not affiliated with, endorsed by or connected to Formula 1, the FIA, Formula One Management, any Formula 1 team, OpenF1 or MultiViewer. F1, FORMULA 1 and related marks are trademarks of Formula One Licensing B.V.

The default source uses MultiViewer's undocumented backend, and team radio audio and timing data belong to their owners. Use this project for personal viewing only, and follow the terms of service of F1 TV, MultiViewer and OpenF1.

## License

[MIT](LICENSE)
