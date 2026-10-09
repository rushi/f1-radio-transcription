import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSelection, writeSelection, parseSelectionBody, isSelected, pickClipsToProcess, SELECTION_FILE } from '../lib/selection.mjs';
import { makeTempDir } from './helpers.mjs';

test('readSelection defaults to all drivers when the file is missing', async () => {
    const dir = await makeTempDir();
    assert.deepEqual(await readSelection(dir), { drivers: [], updatedAt: null });
});

test('writeSelection round-trips through readSelection', async () => {
    const dir = await makeTempDir();
    const written = await writeSelection(dir, [1, 81]);
    assert.deepEqual(written.drivers, [1, 81]);
    assert.ok(written.updatedAt);
    assert.deepEqual(await readSelection(dir), written);
});

test('readSelection drops non-integer entries from a hand-edited file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, SELECTION_FILE), JSON.stringify({ drivers: [1, 'x', 4.5, 16] }));
    assert.deepEqual((await readSelection(dir)).drivers, [1, 16]);
});

test('parseSelectionBody accepts known drivers, dedupes and sorts', () => {
    assert.deepEqual(parseSelectionBody('{"drivers":[81,1,81]}', new Set([1, 81])), { drivers: [1, 81] });
    assert.deepEqual(parseSelectionBody('{"drivers":[]}', new Set([1])), { drivers: [] });
    assert.deepEqual(parseSelectionBody('{"drivers":[44]}', null), { drivers: [44] });
});

test('parseSelectionBody rejects bad input', () => {
    assert.ok(parseSelectionBody('nope', null).error);
    assert.ok(parseSelectionBody('{"drivers":"1"}', null).error);
    assert.ok(parseSelectionBody('{"drivers":[1.5]}', null).error);
    assert.ok(parseSelectionBody('{"drivers":[0]}', null).error);
    assert.ok(parseSelectionBody(JSON.stringify({ drivers: Array.from({ length: 31 }, (_, i) => i + 1) }), null).error);
    assert.match(parseSelectionBody('{"drivers":[7]}', new Set([1])).error, /unknown drivers: 7/);
});

test('isSelected treats an empty selection as all drivers', () => {
    assert.equal(isSelected({ drivers: [] }, 44), true);
    assert.equal(isSelected({ drivers: [1] }, 44), false);
    assert.equal(isSelected({ drivers: [1, 44] }, 44), true);
});

test('pickClipsToProcess keeps unseen clips of selected drivers, newest first', () => {
    const clips = [
        { audioUrl: 'a', driverNumber: 1, utc: '2026-10-11T12:00:00Z' },
        { audioUrl: 'b', driverNumber: 44, utc: '2026-10-11T12:05:00Z' },
        { audioUrl: 'c', driverNumber: 1, utc: '2026-10-11T12:10:00Z' },
        { audioUrl: 'd', driverNumber: 1, utc: '2026-10-11T12:20:00Z' },
    ];
    const picked = pickClipsToProcess({ clips, seenUrls: new Set(['d']), selection: { drivers: [1] } });
    assert.deepEqual(picked.map(({ audioUrl }) => audioUrl), ['c', 'a']);
});

test('pickClipsToProcess backfills a newly added driver', () => {
    const clips = [
        { audioUrl: 'a', driverNumber: 1, utc: '2026-10-11T12:00:00Z' },
        { audioUrl: 'b', driverNumber: 44, utc: '2026-10-11T12:05:00Z' },
    ];
    const seenUrls = new Set(['a']);
    assert.deepEqual(pickClipsToProcess({ clips, seenUrls, selection: { drivers: [1] } }), []);
    assert.deepEqual(pickClipsToProcess({ clips, seenUrls, selection: { drivers: [1, 44] } }).map(({ audioUrl }) => audioUrl), ['b']);
});
