import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonl, followJsonl } from '../lib/jsonl.mjs';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../lib/json-file.mjs';
import { makeTempDir, waitFor } from './helpers.mjs';

const line = (value) => `${JSON.stringify(value)}\n`;

test('readJson returns fallback for missing or invalid files', async () => {
    const dir = await makeTempDir();
    assert.equal(await readJson(path.join(dir, 'nope.json'), 'fallback'), 'fallback');
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
    assert.equal(await readJson(path.join(dir, 'bad.json'), null), null);
});

test('writeJsonAtomic creates parent dirs and replaces the file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'nested', 'a.json');
    await writeJsonAtomic(file, { a: 1 });
    const { ino: firstIno } = await fs.stat(file);
    await writeJsonAtomic(file, { a: 2 });
    assert.deepEqual(await readJson(file, null), { a: 2 });
    const { ino: secondIno } = await fs.stat(file);
    assert.notEqual(firstIno, secondIno);
    const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
});

test('readJsonl ignores a trailing partial line and malformed lines', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    const complete = line({ n: 1 }) + 'garbage\n' + line({ n: 2 });
    await fs.writeFile(file, `${complete}{"n":3`);
    const { records, size, ino } = await readJsonl(file);
    assert.deepEqual(records, [{ n: 1 }, { n: 2 }]);
    assert.equal(size, Buffer.byteLength(complete));
    assert.ok(ino > 0);
});

test('readJsonl returns empty for a missing file', async () => {
    const dir = await makeTempDir();
    assert.deepEqual(await readJsonl(path.join(dir, 'missing.jsonl')), { records: [], size: 0, ino: 0 });
});

test('followJsonl emits appended records and completes partial lines', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, line({ n: 1 }));
    const { size, ino } = await readJsonl(file);
    const received = [];
    const stop = followJsonl({ file, fromSize: size, fromIno: ino, intervalMs: 20, onRecords: (records) => received.push(...records), onReset: () => {} });
    try {
        await fs.appendFile(file, line({ n: 2 }) + '{"n":');
        await waitFor(() => received.length === 1);
        await fs.appendFile(file, '3}\n');
        await waitFor(() => received.length === 2);
        assert.deepEqual(received, [{ n: 2 }, { n: 3 }]);
    } finally {
        stop();
    }
});

test('followJsonl keeps multibyte characters split across reads intact', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, '');
    const received = [];
    const stop = followJsonl({ file, fromSize: 0, fromIno: 0, intervalMs: 20, onRecords: (records) => received.push(...records), onReset: () => {} });
    try {
        const bytes = Buffer.from(line({ text: 'Hülkenberg' }));
        const splitAt = bytes.indexOf(0xc3) + 1;
        await fs.appendFile(file, bytes.subarray(0, splitAt));
        await new Promise((resolve) => setTimeout(resolve, 100));
        await fs.appendFile(file, bytes.subarray(splitAt));
        await waitFor(() => received.length === 1);
        assert.equal(received[0].text, 'Hülkenberg');
    } finally {
        stop();
    }
});

test('followJsonl reports reset when the file shrinks', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, line({ n: 1 }) + line({ n: 2 }));
    const { size, ino } = await readJsonl(file);
    let resets = 0;
    const stop = followJsonl({ file, fromSize: size, fromIno: ino, intervalMs: 20, onRecords: () => {}, onReset: () => { resets += 1; } });
    try {
        await fs.truncate(file, 0);
        await waitFor(() => resets === 1);
    } finally {
        stop();
    }
});

test('followJsonl reports reset when the file is replaced by a larger one', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, line({ n: 1 }));
    const { size, ino } = await readJsonl(file);
    let resets = 0;
    const stop = followJsonl({ file, fromSize: size, fromIno: ino, intervalMs: 20, onRecords: () => {}, onReset: () => { resets += 1; } });
    try {
        await writeFileAtomic(file, line({ n: 10 }) + line({ n: 11 }) + line({ n: 12 }));
        await waitFor(() => resets === 1);
    } finally {
        stop();
    }
});

test('followJsonl catches writes made between readJsonl and followJsonl', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, line({ n: 1 }));
    const { size, ino } = await readJsonl(file);
    await fs.appendFile(file, line({ n: 2 }));
    const received = [];
    // Long interval: the record must come from the startup check, not from a later poll
    const stop = followJsonl({ file, fromSize: size, fromIno: ino, intervalMs: 60000, onRecords: (records) => received.push(...records), onReset: () => {} });
    try {
        await waitFor(() => received.length === 1);
        assert.deepEqual(received, [{ n: 2 }]);
    } finally {
        stop();
    }
});

test('followJsonl reports reset when the file is truncated between readJsonl and followJsonl', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 't.jsonl');
    await fs.writeFile(file, line({ n: 1 }) + line({ n: 2 }));
    const { size, ino } = await readJsonl(file);
    await fs.truncate(file, 0);
    let resets = 0;
    const stop = followJsonl({ file, fromSize: size, fromIno: ino, intervalMs: 60000, onRecords: () => {}, onReset: () => { resets += 1; } });
    try {
        await waitFor(() => resets === 1);
    } finally {
        stop();
    }
});
