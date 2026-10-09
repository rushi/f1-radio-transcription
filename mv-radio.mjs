// Streams MultiViewer's AI radio transcriptions into data/ for server.mjs, as an alternative to
// transcribe-radio.mjs. No audio is downloaded and nothing is transcribed locally.
// Usage: node mv-radio.mjs [--out ./data] [--interval 10]
// Writes <out>/current.json every poll and appends to <out>/<sessionKey>/transcripts.jsonl.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeJsonAtomic } from './lib/json-file.mjs';
import { applyTeamColors, readTeamColorOverrides } from './lib/team-colors.mjs';
import { readJsonl } from './lib/jsonl.mjs';
import { lapAt, shouldRecordLap } from './lib/laps.mjs';
import { connectChannel, fetchHistory, toDeletedRecord, toRecord } from './lib/mv-feed.mjs';
import { queryMultiViewer } from './lib/multiviewer.mjs';
import { buildDriverContext, normalizeRaceControl } from './lib/context.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { values: argv } = parseArgs({ options: { out: { type: 'string' }, interval: { type: 'string' } } });
const outDir = path.resolve(argv.out ?? path.join(ROOT, 'data'));
const intervalMs = (Number(argv.interval) || 10) * 1000;
// Timing moves every second, so the snapshot attached to a live message is refreshed far more often than current.json
const TIMING_INTERVAL_MS = 2000;
// MultiViewer delivers transcriptions 20-45s after they were said, so snapshots are kept long enough to
// look up the moment the radio happened rather than the moment it arrived
const TIMING_HISTORY_MS = 180_000;

let latestTiming = null;
// [{ at: epoch ms, timing }], oldest first
let timingHistory = [];

const rememberTiming = (timing) => {
    const now = Date.now();
    latestTiming = timing;
    timingHistory.push({ at: now, timing });
    timingHistory = timingHistory.filter(({ at }) => now - at <= TIMING_HISTORY_MS);
};

// Latest snapshot taken at or before the message; none when it predates the buffer
const findTimingAt = (utc) => {
    const time = Date.parse(utc);
    let found = null;
    for (const snapshot of timingHistory) {
        if (snapshot.at > time) {
            break;
        }
        found = snapshot.timing;
    }
    return found;
};

const fetchTiming = async () => {
    const query = '{ f1LiveTimingState { SessionInfo TimingData TimingAppData TrackStatus RaceControlMessages } }';
    const { data } = await queryMultiViewer(query);
    const state = data?.f1LiveTimingState ?? {};
    return {
        // Sprint and Grand Prix both report Type "Race"
        isRace: state.SessionInfo?.Type === 'Race',
        timingData: state.TimingData ?? null,
        timingAppData: state.TimingAppData ?? null,
        trackStatus: state.TrackStatus ?? null,
        raceControl: normalizeRaceControl(state.RaceControlMessages),
    };
};

const getContext = (driverNumber, utc) => {
    const timing = findTimingAt(utc);
    if (!timing) {
        return null;
    }
    return buildDriverContext({ ...timing, driverNumber });
};

const fetchSession = async () => {
    const query = '{ version f1LiveTimingState { SessionInfo DriverList LapCount } }';
    const { data } = await queryMultiViewer(query);
    const state = data?.f1LiveTimingState;
    if (!state?.SessionInfo) {
        throw new Error('MultiViewer has no live timing session loaded');
    }
    const { SessionInfo: session, DriverList: driverList = {}, LapCount: lapCount } = state;
    const drivers = Object.values(driverList)
        .filter(({ RacingNumber }) => RacingNumber != null)
        .map(({ RacingNumber, Tla, FullName, TeamName, TeamColour }) => ({
            number: Number(RacingNumber),
            tla: Tla ?? null,
            name: FullName ?? null,
            team: TeamName ?? null,
            teamColour: TeamColour ?? null,
        }));
    return {
        appVersion: data.version,
        sessionKey: String(session.Key),
        meetingKey: session.Meeting?.Key ?? null,
        sessionName: `${session.Meeting?.Name ?? 'Unknown'} - ${session.Name}`,
        lap: lapCount?.CurrentLap ?? null,
        totalLaps: lapCount?.TotalLaps ?? null,
        drivers,
    };
};

let feed = null;
// Appends are chained so records land in the order the socket delivered them
let writeChain = Promise.resolve();

const append = (file, record) => {
    writeChain = writeChain
        .then(() => fs.appendFile(file, `${JSON.stringify(record)}\n`))
        .catch((error) => console.error(error));
};

const startFeed = async ({ sessionKey, meetingKey, appVersion, drivers }) => {
    feed?.stop();
    const sessionDir = path.join(outDir, sessionKey);
    await fs.mkdir(sessionDir, { recursive: true });
    const transcriptFile = path.join(sessionDir, 'transcripts.jsonl');
    // The channel replays the session's history on every join, so known text is skipped instead of re-appended
    const { records } = await readJsonl(transcriptFile);
    const knownText = new Map();
    for (const record of records) {
        if (record.deleted) {
            knownText.delete(record.id);
            continue;
        }
        knownText.set(record.id, record.text);
    }
    const { records: lapSamples } = await readJsonl(path.join(sessionDir, 'laps.jsonl'));
    // Drivers are set before joining because the history replay arrives as soon as the join is accepted
    const driverMap = new Map(drivers.map((driver) => [driver.number, driver]));
    const current = { sessionKey, knownText, lapSamples, drivers: driverMap, stop: () => {} };
    feed = current;

    const handleEvent = (event, payload, { isQuiet = false } = {}) => {
        if (event === 'transcription_delete') {
            const deleted = toDeletedRecord(payload);
            if (!deleted || !knownText.has(deleted.id)) {
                return;
            }
            knownText.delete(deleted.id);
            append(transcriptFile, deleted);
            return;
        }
        if (event !== 'transcription' && event !== 'transcription_update') {
            return;
        }
        const lap = lapAt(current.lapSamples, payload?.player_ts);
        const record = toRecord(payload, { sessionKey, drivers: current.drivers, lap });
        if (!record) {
            return;
        }
        record.context = getContext(record.driverNumber, record.utc);
        const isUnchanged = knownText.get(record.id) === record.text;
        if (!record.text || isUnchanged) {
            return;
        }
        knownText.set(record.id, record.text);
        append(transcriptFile, record);
        if (!isQuiet) {
            console.log(`${record.driver ?? record.driverNumber}  ${record.text}`);
        }
    };

    // The channel only pushes new messages, so history is loaded after every join to fill any gap
    const backfill = async () => {
        if (meetingKey == null) {
            return;
        }
        try {
            const before = knownText.size;
            const messages = await fetchHistory({ meetingKey, sessionKey });
            messages.forEach((message) => handleEvent('transcription', message, { isQuiet: true }));
            console.log(`[${sessionKey}] history: ${messages.length} messages, ${knownText.size - before} new`);
        } catch (error) {
            console.error(`[${sessionKey}] ${error.message}`);
        }
    };

    current.stop = connectChannel({
        sessionKey,
        appVersion,
        onEvent: handleEvent,
        onStatus: (status) => {
            console.log(`[${sessionKey}] ${status}`);
            if (status === 'joined') {
                backfill();
            }
        },
    });
    console.log(`following MultiViewer AI transcriptions for session ${sessionKey} (${knownText.size} already saved)`);
};

const recordLap = async ({ sessionKey, lap }) => {
    const lapsFile = path.join(outDir, sessionKey, 'laps.jsonl');
    if (!shouldRecordLap(feed.lapSamples, lap)) {
        return;
    }
    const sample = { utc: new Date().toISOString(), lap };
    feed.lapSamples.push(sample);
    await fs.appendFile(lapsFile, `${JSON.stringify(sample)}\n`);
};

const poll = async () => {
    const session = await fetchSession();
    await writeJsonAtomic(path.join(outDir, 'current.json'), {
        sessionKey: session.sessionKey,
        sessionName: session.sessionName,
        lap: session.lap,
        totalLaps: session.totalLaps,
        drivers: applyTeamColors(session.drivers, await readTeamColorOverrides()),
        raceControl: latestTiming?.raceControl ?? [],
        updatedAt: new Date().toISOString(),
    });
    if (feed?.sessionKey !== session.sessionKey) {
        await startFeed(session);
    }
    feed.drivers = new Map(session.drivers.map((driver) => [driver.number, driver]));
    await recordLap(session);
};

const handleShutdown = () => {
    feed?.stop();
    process.exit(0);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

await fs.mkdir(outDir, { recursive: true });
const pollTiming = async () => {
    while (true) {
        try {
            rememberTiming(await fetchTiming());
        } catch (error) {
            console.error(`timing: ${error.message}`);
        }
        await sleep(TIMING_INTERVAL_MS);
    }
};

pollTiming();
while (true) {
    try {
        await poll();
    } catch (error) {
        console.error(error.message);
    }
    await sleep(intervalMs);
}
