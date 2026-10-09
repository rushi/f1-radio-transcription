import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseRange, resolveAudioPath } from '../lib/http.mjs';

test('parseRange handles open, closed and suffix ranges', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 });
    assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
});

test('parseRange rejects ranges past the end and ignores unsupported syntax', () => {
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-2', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
    assert.equal(parseRange('items=0-1', 100), null);
});

test('resolveAudioPath keeps paths inside the session audio folder', () => {
    const dataDir = '/data';
    assert.equal(resolveAudioPath(dataDir, '11377', 'LIN_41_20260926_142849.mp3'), path.join('/data', '11377', 'audio', 'LIN_41_20260926_142849.mp3'));
    assert.equal(resolveAudioPath(dataDir, '..', 'x.mp3'), null);
    assert.equal(resolveAudioPath(dataDir, '11377', '../current.json'), null);
    assert.equal(resolveAudioPath(dataDir, '11377', 'x.wav'), null);
    assert.equal(resolveAudioPath(dataDir, '11377/..', 'x.mp3'), null);
});
