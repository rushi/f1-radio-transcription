import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRadioServer } from '../server.mjs';
import { writeJsonAtomic } from '../lib/json-file.mjs';
import { readSelection } from '../lib/selection.mjs';
import { makeTempDir, waitFor } from './helpers.mjs';

// http.request keeps the path as written, unlike fetch which normalizes dot segments
const rawGet = (base, rawPath) =>
    new Promise((resolve, reject) => {
        const { hostname, port } = new URL(base);
        const req = http.request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });

const line = (value) => `${JSON.stringify(value)}\n`;
const makeRecord = (id, driverNumber = 1) => ({ utc: '2026-10-11T12:00:00Z', driverNumber, driver: 'NOR', audioFile: `s1/audio/${id}.mp3`, text: `text ${id}` });

const start = async () => {
    const dataDir = await makeTempDir();
    const webDir = await makeTempDir();
    await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>t</title>');
    await fs.writeFile(path.join(webDir, 'format.mjs'), 'export const x = 1;');
    await writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: 's1', updatedAt: 'a', drivers: [{ number: 1, tla: 'NOR' }, { number: 81, tla: 'PIA' }] });
    await fs.mkdir(path.join(dataDir, 's1', 'audio'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('one')));
    await fs.writeFile(path.join(dataDir, 's1', 'audio', 'one.mp3'), Buffer.from('0123456789'));
    const radio = await createRadioServer({ dataDir, webDir, intervalMs: 20, keepaliveMs: 50 });
    await new Promise((resolve) => radio.server.listen(0, '127.0.0.1', resolve));
    const { port } = radio.server.address();
    return { ...radio, dataDir, base: `http://127.0.0.1:${port}` };
};

// Collects SSE events from a streaming fetch until `until` returns true
const collectEvents = async (url, until, timeoutMs = 2000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const events = [];
    try {
        const response = await fetch(url, { signal: controller.signal });
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop();
            for (const block of blocks) {
                const event = block.match(/^event: (.+)$/m)?.[1];
                const data = block.match(/^data: (.+)$/m)?.[1];
                events.push({ event: event ?? null, data: data ? JSON.parse(data) : null, raw: block });
            }
            if (until(events)) {
                break;
            }
        }
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
    return events;
};

test('serves the page, format module, session and clips', async () => {
    const radio = await start();
    try {
        const page = await fetch(`${radio.base}/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        const format = await fetch(`${radio.base}/format.mjs`);
        assert.match(format.headers.get('content-type'), /text\/javascript/);
        assert.equal((await (await fetch(`${radio.base}/api/session`)).json()).sessionKey, 's1');
        const clips = await (await fetch(`${radio.base}/api/clips`)).json();
        assert.deepEqual(clips.map(({ id }) => id), ['one']);
        const [{ seq: firstSeq }] = clips;
        assert.deepEqual(await (await fetch(`${radio.base}/api/clips?after=${firstSeq}`)).json(), []);
        assert.deepEqual((await (await fetch(`${radio.base}/api/clips?after=${firstSeq - 1}`)).json()).map(({ id }) => id), ['one']);
        assert.equal((await fetch(`${radio.base}/nope`)).status, 404);
    } finally {
        await radio.close();
    }
});

test('streams appended clips over SSE', async () => {
    const radio = await start();
    try {
        const eventsPromise = collectEvents(`${radio.base}/api/stream`, (events) => events.some(({ event }) => event === 'clip'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.appendFile(path.join(radio.dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('two')));
        const events = await eventsPromise;
        const clip = events.find(({ event }) => event === 'clip');
        assert.equal(clip.data.id, 'two');
        const [{ seq: firstSeq }] = await (await fetch(`${radio.base}/api/clips`)).json();
        assert.equal(clip.data.seq, firstSeq + 1);
    } finally {
        await radio.close();
    }
});

test('sends keep-alive comments', async () => {
    const radio = await start();
    try {
        const events = await collectEvents(`${radio.base}/api/stream`, (collected) => collected.some(({ raw }) => raw.includes(': keep-alive')));
        assert.ok(events.some(({ raw }) => raw.includes(': keep-alive')));
    } finally {
        await radio.close();
    }
});

test('PUT /api/selection validates, writes the file and broadcasts', async () => {
    const radio = await start();
    try {
        const eventsPromise = collectEvents(`${radio.base}/api/stream`, (events) => events.some(({ event }) => event === 'selection'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const bad = await fetch(`${radio.base}/api/selection`, { method: 'PUT', body: '{"drivers":[44]}' });
        assert.equal(bad.status, 400);
        const good = await fetch(`${radio.base}/api/selection`, { method: 'PUT', body: '{"drivers":[81,1]}' });
        assert.equal(good.status, 200);
        assert.deepEqual((await good.json()).drivers, [1, 81]);
        assert.deepEqual((await readSelection(radio.dataDir)).drivers, [1, 81]);
        const events = await eventsPromise;
        assert.deepEqual(events.find(({ event }) => event === 'selection').data.drivers, [1, 81]);
        assert.deepEqual((await (await fetch(`${radio.base}/api/selection`)).json()).drivers, [1, 81]);
    } finally {
        await radio.close();
    }
});

test('serves audio with Range and HEAD, and blocks traversal', async () => {
    const radio = await start();
    try {
        const full = await fetch(`${radio.base}/audio/s1/one.mp3`);
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('accept-ranges'), 'bytes');
        assert.equal(await full.text(), '0123456789');

        const partial = await fetch(`${radio.base}/audio/s1/one.mp3`, { headers: { Range: 'bytes=0-1' } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get('content-range'), 'bytes 0-1/10');
        assert.equal(await partial.text(), '01');

        const head = await fetch(`${radio.base}/audio/s1/one.mp3`, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-length'), '10');

        assert.equal((await fetch(`${radio.base}/audio/s1/one.mp3`, { headers: { Range: 'bytes=50-' } })).status, 416);
        assert.equal((await fetch(`${radio.base}/audio/s1/missing.mp3`)).status, 404);
        assert.equal((await fetch(`${radio.base}/audio/%2e%2e/current.json`)).status, 404);
    } finally {
        await radio.close();
    }
});

test('audio route rejects traversal sent as raw encoded paths', async () => {
    const radio = await start();
    try {
        assert.equal(await rawGet(radio.base, '/audio/s1/..%2Fcurrent.json'), 404);
        assert.equal(await rawGet(radio.base, '/audio/..%2Fs1/one.mp3'), 404);
        assert.equal(await rawGet(radio.base, '/audio/s1/one.mp3'), 200);
    } finally {
        await radio.close();
    }
});

test('audio route returns 404 for a directory named like an mp3 and keeps serving', async () => {
    const radio = await start();
    try {
        await fs.mkdir(path.join(radio.dataDir, 's1', 'audio', 'dir.mp3'));
        assert.equal((await fetch(`${radio.base}/audio/s1/dir.mp3`)).status, 404);
        assert.equal((await fetch(`${radio.base}/audio/s1/one.mp3`)).status, 200);
    } finally {
        await radio.close();
    }
});

test('malformed percent-escapes in the audio route return 404', async () => {
    const radio = await start();
    try {
        assert.equal(await rawGet(radio.base, '/audio/%E0%A4%A/x.mp3'), 404);
        assert.equal((await fetch(`${radio.base}/api/session`)).status, 200);
    } finally {
        await radio.close();
    }
});

test('malformed request targets return 400', async () => {
    const radio = await start();
    try {
        assert.equal(await rawGet(radio.base, '//'), 400);
    } finally {
        await radio.close();
    }
});
