// Starts the transcriber and the web server together, restarts either one if it crashes,
// and prints the URL to open on a phone on the same Wi-Fi.
// Usage: node race.mjs [--source multiviewer-ai|multiviewer|openf1] [--replay <sessionKey>]
// Sources: multiviewer-ai (default) streams MultiViewer's own AI transcriptions; multiviewer and openf1
// download the official radio clips and transcribe them locally with Whisper.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import qrcode from 'qrcode-terminal';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 10303;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// A process that stayed up this long crashed for a new reason, so its backoff starts over
const STABLE_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5000;
const DEFAULT_SOURCE = 'multiviewer-ai';

const { values: argv } = parseArgs({ options: { source: { type: 'string' }, replay: { type: 'string' } } });

const children = new Map();
const restartTimers = new Set();
let isShuttingDown = false;

const getLanAddress = () => {
    const interfaces = os.networkInterfaces();
    // en0 is Wi-Fi on Macs, so prefer it over VPN and bridge interfaces
    for (const addresses of [interfaces.en0, ...Object.values(interfaces)]) {
        const address = addresses?.find(({ family, internal }) => family === 'IPv4' && !internal);
        if (address) {
            return address.address;
        }
    }
    return 'localhost';
};

const prefixLines = (stream, label, target) => {
    let rest = '';
    stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
            target.write(`${label} ${line}\n`);
        }
    });
};

const run = (name, args, backoffMs = FIRST_BACKOFF_MS) => {
    const startedAt = Date.now();
    const options = { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = spawn(process.execPath, args, options);
    children.set(name, child);
    prefixLines(child.stdout, `[${name}]`, process.stdout);
    prefixLines(child.stderr, `[${name}]`, process.stderr);
    child.on('exit', (code, signal) => {
        children.delete(name);
        if (isShuttingDown) {
            return;
        }
        const isFinishedReplay = name === 'replay' && code === 0;
        if (isFinishedReplay) {
            console.log('[race] replay finished, server still running');
            return;
        }
        const wasStable = Date.now() - startedAt > STABLE_MS;
        const delayMs = wasStable ? FIRST_BACKOFF_MS : backoffMs;
        const nextBackoffMs = wasStable ? FIRST_BACKOFF_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        console.error(`[race] ${name} exited (${signal ?? code}), restarting in ${delayMs / 1000}s`);
        const timer = setTimeout(() => {
            restartTimers.delete(timer);
            run(name, args, nextBackoffMs);
        }, delayMs);
        restartTimers.add(timer);
    });
};

const handleShutdown = () => {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;
    restartTimers.forEach(clearTimeout);
    restartTimers.clear();
    for (const child of children.values()) {
        child.kill('SIGTERM');
    }
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    const waitForChildren = setInterval(() => {
        if (children.size === 0) {
            clearInterval(waitForChildren);
            clearTimeout(forceExit);
            process.exit(0);
        }
    }, 100);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

if (argv.replay) {
    run('replay', ['replay.mjs', argv.replay]);
} else {
    const source = argv.source ?? DEFAULT_SOURCE;
    const radioArgs = source === 'multiviewer-ai'
        ? ['mv-radio.mjs']
        : ['transcribe-radio.mjs', '--interval', '10', '--source', source];
    run('radio', radioArgs);
}
run('web', ['server.mjs']);

const url = `http://${getLanAddress()}:${PORT}`;
console.log(`\n[race] open ${url} on your phone (same Wi-Fi)\n`);
qrcode.generate(url, { small: true });
