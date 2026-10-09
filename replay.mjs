// Replays a stored session's transcripts into data/replay/ so the page can be tested without a live session.
// Overwrites data/current.json, so don't run it alongside the transcriber. race.mjs --replay handles that.
// Usage: node replay.mjs <sessionKey> [--speed 10] [--laps 50]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { readJsonl } from './lib/jsonl.mjs';
import { writeFileAtomic, writeJsonAtomic } from './lib/json-file.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const REPLAY_KEY = 'replay';
// Gaps between clips can be minutes even at 10x, so they are capped to keep the replay moving
const MAX_GAP_MS = 5000;
// OpenF1 sessions carry no team colours, so the replay uses the 2026 values MultiViewer reports
const TEAM_COLOURS = {
    McLaren: 'F47600',
    'Red Bull Racing': '4781D7',
    Audi: 'F50537',
    Alpine: '00A1E8',
    Cadillac: '909090',
    Mercedes: '00D7B6',
    'Aston Martin': '229971',
    Ferrari: 'ED1131',
    Williams: '1868DB',
    'Racing Bulls': '6C98FF',
    'Haas F1 Team': '9C9FA2',
};

const { values: argv, positionals } = parseArgs({
    allowPositionals: true,
    options: { speed: { type: 'string' }, laps: { type: 'string' } },
});
const [sessionKey] = positionals;
const speed = Number(argv.speed) || 10;
const totalLaps = Number(argv.laps) || 50;

const main = async () => {
    if (!sessionKey) {
        throw new Error('usage: node replay.mjs <sessionKey> [--speed 10] [--laps 50]');
    }
    const { records } = await readJsonl(path.join(DATA_DIR, sessionKey, 'transcripts.jsonl'));
    const ordered = records.filter(({ skipped }) => !skipped).sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc));
    if (ordered.length === 0) {
        throw new Error(`no transcripts in data/${sessionKey}`);
    }

    const toDriver = (record) => ({
        number: record.driverNumber,
        tla: record.driver,
        name: record.driverName,
        team: record.team,
        teamColour: TEAM_COLOURS[record.team] ?? null,
    });
    const driversByNumber = new Map(ordered.map((record) => [record.driverNumber, toDriver(record)]));
    const drivers = [...driversByNumber.values()];

    const replayFile = path.join(DATA_DIR, REPLAY_KEY, 'transcripts.jsonl');
    await writeFileAtomic(replayFile, '');
    const writeCurrent = (lap) => writeJsonAtomic(path.join(DATA_DIR, 'current.json'), {
        sessionKey: REPLAY_KEY,
        sessionName: `Replay of ${sessionKey}`,
        lap,
        totalLaps,
        drivers,
        updatedAt: new Date().toISOString(),
    });

    console.log(`replaying ${ordered.length} clips from ${sessionKey} at ${speed}x`);
    for (const [index, record] of ordered.entries()) {
        const previous = ordered[index - 1];
        const gapMs = previous ? Math.min((Date.parse(record.utc) - Date.parse(previous.utc)) / speed, MAX_GAP_MS) : 0;
        await sleep(gapMs);
        // Synthetic lap spread across the replay so the header and L-labels have something to show
        const lap = record.lap ?? Math.min(totalLaps, 1 + Math.floor((index / ordered.length) * totalLaps));
        await writeCurrent(lap);
        // Fresh utc so the page shows "now" instead of the original race time
        const replayed = { ...record, utc: new Date().toISOString(), lap };
        await fs.appendFile(replayFile, `${JSON.stringify(replayed)}\n`);
        console.log(`${record.driver ?? record.driverNumber}  ${record.text}`);
    }
    console.log('replay finished');
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
