#!/usr/bin/env npx zx

// Polls F1 team radio clips, downloads new ones, and transcribes them with faster-whisper.
//
// Usage:
//   ./transcribe-radio.mjs                      poll MultiViewer every 30s
//   ./transcribe-radio.mjs --source openf1      poll OpenF1 (needs OPEN_F1_USERNAME/PASSWORD in .env)
//   ./transcribe-radio.mjs --once               single pass, then exit
//   ./transcribe-radio.mjs --source openf1 --session 9158 --once   past session from OpenF1
//
// Options: --interval <seconds> (30), --model <whisper model> (small.en), --out <dir> (./data),
//          --no-hotwords (skip biasing Whisper toward session driver, team and circuit names),
//          --redo (first pass re-transcribes every clip and replaces transcripts.jsonl; audio is reused)
//
// Writes <out>/current.json every pass for server.mjs, and only transcribes drivers listed in
// <out>/selection.json (empty or missing means all drivers).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { $, path, chalk } from 'zx/core';
import { writeFileAtomic, writeJsonAtomic } from './lib/json-file.mjs';
import { applyTeamColors, readTeamColorOverrides } from './lib/team-colors.mjs';
import { queryMultiViewer } from './lib/multiviewer.mjs';
import { readJsonl } from './lib/jsonl.mjs';
import { lapAt, shouldRecordLap } from './lib/laps.mjs';
import { pickClipsToProcess, readSelection } from './lib/selection.mjs';

const { values: argv } = parseArgs({
    allowPositionals: true,
    options: {
        source: { type: 'string' },
        interval: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string' },
        session: { type: 'string' },
        once: { type: 'boolean' },
        'no-hotwords': { type: 'boolean' },
        redo: { type: 'boolean' },
    },
});

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const LIVETIMING_STATIC_URL = 'https://livetiming.formula1.com/static/';
const OPENF1_URL = 'https://api.openf1.org';
const PYTHON = path.join(ROOT, '.venv/bin/python');
const TRANSCRIBER = path.join(ROOT, 'transcribe.py');

const source = argv.source ?? 'multiviewer';
const intervalMs = (Number(argv.interval) || 30) * 1000;
const model = argv.model ?? 'small.en';
const outDir = path.resolve(argv.out ?? path.join(ROOT, 'data'));
const sessionArg = argv.session ?? 'latest';
const useHotwords = !argv['no-hotwords'];
let isRedoPending = Boolean(argv.redo);

// Racing jargon lives in transcribe.py's prompt. Hotwords carry only per-session names.
const buildHotwords = ({ firstNames, lastNames, teams, circuit }) => {
    const terms = new Set([...lastNames, ...firstNames, ...teams, circuit].filter(Boolean));
    return [...terms].join(' ');
};

$.verbose = false;

const loadEnv = async () => {
    const envPath = path.join(ROOT, '.env');
    if (!existsSync(envPath)) {
        return;
    }
    const lines = (await fs.readFile(envPath, 'utf8')).split('\n');
    for (const line of lines) {
        const match = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
        if (!match || line.trim().startsWith('#')) {
            continue;
        }
        const [, key, rawValue] = match;
        process.env[key] ??= rawValue.replace(/^(['"])(.*)\1$/, '$2');
    }
};

// ---------- MultiViewer ----------

const fetchMultiviewer = async () => {
    const query = '{ f1LiveTimingState { TeamRadio SessionInfo DriverList LapCount } }';
    const { data, errors } = await queryMultiViewer(query);
    if (errors?.length) {
        throw new Error(`MultiViewer: ${errors[0].message}`);
    }
    const state = data?.f1LiveTimingState;
    if (!state?.SessionInfo) {
        throw new Error('MultiViewer has no live timing session loaded');
    }

    const { SessionInfo: session, TeamRadio: teamRadio, DriverList: driverList = {}, LapCount: lapCount } = state;
    const captures = teamRadio?.Captures ?? [];

    const drivers = Object.values(driverList);
    const hotwords = buildHotwords({
        firstNames: drivers.map(({ FirstName }) => FirstName),
        lastNames: drivers.map(({ LastName }) => LastName),
        teams: drivers.map(({ TeamName }) => TeamName),
        circuit: session.Meeting?.Circuit?.ShortName,
    });

    return {
        sessionKey: String(session.Key),
        hotwords,
        lap: lapCount?.CurrentLap ?? null,
        totalLaps: lapCount?.TotalLaps ?? null,
        drivers: drivers.filter(({ RacingNumber }) => RacingNumber != null).map(({ RacingNumber, Tla, FullName, TeamName, TeamColour }) => ({
            number: Number(RacingNumber),
            tla: Tla ?? null,
            name: FullName ?? null,
            team: TeamName ?? null,
            teamColour: TeamColour ?? null,
        })),
        sessionName: `${session.Meeting?.Name ?? 'Unknown'} - ${session.Name}`,
        clips: captures.map(({ Path: clipPath, RacingNumber, Utc }) => {
            const driver = driverList[RacingNumber] ?? {};
            return {
                utc: Utc,
                driverNumber: Number(RacingNumber),
                driver: driver.Tla ?? null,
                driverName: driver.FullName ?? null,
                team: driver.TeamName ?? null,
                audioUrl: `${LIVETIMING_STATIC_URL}${session.Path}${clipPath}`,
            };
        }),
    };
};

// ---------- OpenF1 ----------

let openf1Token = null;
let openf1TokenExpiresAt = 0;

const getOpenf1Token = async () => {
    const isTokenValid = openf1Token && Date.now() < openf1TokenExpiresAt - 60_000;
    if (isTokenValid) {
        return openf1Token;
    }
    const { OPEN_F1_USERNAME: username, OPEN_F1_PASSWORD: password } = process.env;
    if (!username || !password) {
        return null;
    }
    const response = await fetch(`${OPENF1_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
    });
    if (!response.ok) {
        throw new Error(`OpenF1 token HTTP ${response.status}: ${await response.text()}`);
    }
    const { access_token: accessToken, expires_in: expiresIn } = await response.json();
    openf1Token = accessToken;
    openf1TokenExpiresAt = Date.now() + Number(expiresIn) * 1000;
    return openf1Token;
};

const openf1Get = async (endpoint, params) => {
    const token = await getOpenf1Token();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const url = `${OPENF1_URL}/v1/${endpoint}?${new URLSearchParams(params)}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`OpenF1 ${endpoint} HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
};

const fetchOpenf1 = async () => {
    const [sessions, radios, drivers] = await Promise.all([
        openf1Get('sessions', { session_key: sessionArg }),
        openf1Get('team_radio', { session_key: sessionArg }),
        openf1Get('drivers', { session_key: sessionArg }),
    ]);
    const session = sessions[0];
    if (!session) {
        throw new Error(`OpenF1 has no session for session_key=${sessionArg}`);
    }
    const driversByNumber = new Map(drivers.map((driver) => [driver.driver_number, driver]));

    const hotwords = buildHotwords({
        firstNames: drivers.map(({ first_name: firstName }) => firstName),
        lastNames: drivers.map(({ last_name: lastName }) => lastName),
        teams: drivers.map(({ team_name: teamName }) => teamName),
        circuit: session.circuit_short_name,
    });

    return {
        sessionKey: String(session.session_key),
        hotwords,
        // OpenF1 has no live lap count
        lap: null,
        totalLaps: null,
        drivers: drivers.map(({ driver_number: number, name_acronym: tla, full_name: name, team_name: team, team_colour: teamColour }) => ({
            number,
            tla: tla ?? null,
            name: name ?? null,
            team: team ?? null,
            teamColour: teamColour ?? null,
        })),
        sessionName: `${session.location} - ${session.session_name}`,
        clips: radios.map(({ date, driver_number: driverNumber, recording_url: audioUrl }) => {
            const driver = driversByNumber.get(driverNumber) ?? {};
            return {
                utc: date,
                driverNumber,
                driver: driver.name_acronym ?? null,
                driverName: driver.full_name ?? null,
                team: driver.team_name ?? null,
                audioUrl,
            };
        }),
    };
};

// ---------- Pipeline ----------

const readSeenUrls = async (transcriptFile) => {
    const { records } = await readJsonl(transcriptFile);
    return new Set(records.map(({ audioUrl }) => audioUrl));
};

const download = async (url, file) => {
    if (existsSync(file)) {
        return;
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download HTTP ${response.status} for ${url}`);
    }
    // Atomic so a kill mid-write never leaves a truncated MP3 that a later pass reuses via the existsSync check
    await writeFileAtomic(file, Buffer.from(await response.arrayBuffer()));
};

async function* transcribeEach(files, hotwords) {
    const hotwordArgs = useHotwords && hotwords ? ['--hotwords', hotwords] : [];
    for await (const line of $`${PYTHON} ${TRANSCRIBER} --model ${model} ${hotwordArgs} ${files}`) {
        if (!line.trim()) {
            continue;
        }
        yield JSON.parse(line);
    }
}

const formatClip = ({ utc, driver, driverNumber, text }) => {
    const time = new Date(utc).toISOString().slice(11, 19);
    const label = driver ?? `#${driverNumber}`;
    return `${chalk.dim(time)} ${chalk.cyan(label.padEnd(4))} ${text || chalk.dim('(no speech)')}`;
};

const recordLap = async (lapsFile, lap) => {
    const { records: samples } = await readJsonl(lapsFile);
    if (!shouldRecordLap(samples, lap)) {
        return samples;
    }
    const sample = { utc: new Date().toISOString(), lap };
    await fs.appendFile(lapsFile, `${JSON.stringify(sample)}\n`);
    return [...samples, sample];
};

const downloadAll = async (clips, sessionDir) => {
    const results = await Promise.allSettled(
        clips.map(async (clip) => {
            const file = path.join(sessionDir, 'audio', path.basename(new URL(clip.audioUrl).pathname));
            await download(clip.audioUrl, file);
            return { ...clip, file };
        }),
    );
    const downloaded = [];
    for (const result of results) {
        if (result.status === 'rejected') {
            console.error(chalk.yellow(result.reason.message));
            continue;
        }
        downloaded.push(result.value);
    }
    return downloaded;
};

// One Python process handles a whole pass, so a long pass blocks every clip that arrives meanwhile.
// Capping the batch (newest first) keeps a backfill from delaying a live clip by more than one small batch.
const MAX_CLIPS_PER_PASS = 4;

// Returns true when pending clips remain and this pass made progress, so main() can skip the sleep
const runPass = async () => {
    const sessionData = source === 'openf1' ? await fetchOpenf1() : await fetchMultiviewer();
    const { sessionKey, sessionName, clips, hotwords, drivers, lap, totalLaps } = sessionData;

    const sessionDir = path.join(outDir, sessionKey);
    const transcriptFile = path.join(sessionDir, 'transcripts.jsonl');
    await fs.mkdir(sessionDir, { recursive: true });
    const updatedAt = new Date().toISOString();
    const currentFile = path.join(outDir, 'current.json');
    const coloredDrivers = applyTeamColors(drivers, await readTeamColorOverrides());
    await writeJsonAtomic(currentFile, { sessionKey, sessionName, lap, totalLaps, drivers: coloredDrivers, updatedAt });
    const lapSamples = await recordLap(path.join(sessionDir, 'laps.jsonl'), lap);

    const isRedo = isRedoPending;
    isRedoPending = false;
    if (isRedo) {
        // A new inode tells server.mjs to reload the session instead of reading past the old end
        await writeFileAtomic(transcriptFile, '');
    }
    const seenUrls = isRedo ? new Set() : await readSeenUrls(transcriptFile);
    const selection = await readSelection(outDir);
    const pending = pickClipsToProcess({ clips, seenUrls, selection });

    const selectionLabel = selection.drivers.length === 0 ? 'all drivers' : `${selection.drivers.length} drivers`;
    const batch = pending.slice(0, MAX_CLIPS_PER_PASS);
    const backlogCount = pending.length - batch.length;
    console.log(chalk.dim(`${sessionName} (${sessionKey}): ${clips.length} clips, ${pending.length} to transcribe for ${selectionLabel}, ${backlogCount} in backlog after this pass`));
    if (batch.length === 0) {
        return false;
    }

    const downloaded = await downloadAll(batch, sessionDir);
    if (downloaded.length === 0) {
        return false;
    }

    const clipsByFile = new Map(downloaded.map((clip) => [clip.file, clip]));
    let skippedCount = 0;
    let recordedCount = 0;
    for await (const result of transcribeEach([...clipsByFile.keys()], hotwords)) {
        const clip = clipsByFile.get(result.file);
        if (!clip) {
            continue;
        }
        if (result.error) {
            console.error(chalk.yellow(`transcription failed for ${result.file}: ${result.error}`));
            continue;
        }
        const { file, ...clipFields } = clip;
        const { text = null, skipped, duration } = result;
        // Lap comes from the clip's own time, so a backfilled clip still gets the lap it was said on
        const clipLap = lapAt(lapSamples, clip.utc);
        const audioFile = path.relative(outDir, file);
        const record = { ...clipFields, sessionKey, audioFile, duration, lap: clipLap, text, ...(skipped && { skipped }) };
        // Skipped clips are still recorded so later passes don't retry them
        await fs.appendFile(transcriptFile, `${JSON.stringify(record)}\n`);
        recordedCount += 1;
        if (skipped) {
            skippedCount += 1;
            continue;
        }
        console.log(formatClip(record));
    }
    if (skippedCount > 0) {
        console.log(chalk.dim(`skipped ${skippedCount} short clips`));
    }
    // Without progress (every download or transcription failed) the same batch would retry in a hot loop
    return backlogCount > 0 && recordedCount > 0;
};

async function main() {
    if (!['multiviewer', 'openf1'].includes(source)) {
        throw new Error(`unknown --source "${source}", use multiviewer or openf1`);
    }
    if (!existsSync(PYTHON)) {
        throw new Error('missing .venv, run: uv venv .venv && uv pip install --python .venv/bin/python faster-whisper');
    }
    await loadEnv();
    await fs.mkdir(outDir, { recursive: true });

    while (true) {
        let hasBacklog = false;
        try {
            hasBacklog = await runPass();
        } catch (error) {
            if (argv.once) {
                throw error;
            }
            console.error(chalk.red(error.message));
        }
        if (argv.once) {
            return;
        }
        // A backlog drains back to back so it finishes sooner, each pass still re-fetching so live clips jump the queue
        if (!hasBacklog) {
            await sleep(intervalMs);
        }
    }
}

main().catch((error) => {
    console.error(chalk.red(error.message));
    process.exit(1);
});
