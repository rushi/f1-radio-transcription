import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClip, clipsAfter } from '../lib/clips.mjs';

const record = {
    utc: '2026-09-26T10:29:20.153000+00:00',
    driverNumber: 41,
    driver: 'LIN',
    driverName: 'Arvid LINDBLAD',
    team: 'Racing Bulls',
    audioUrl: 'https://livetiming.formula1.com/static/x/LIN_41_20260926_142849.mp3',
    sessionKey: '11377',
    audioFile: '11377/audio/LIN_41_20260926_142849.mp3',
    duration: 12.8,
    lap: 7,
    text: 'Metallic sound on the rear.',
};

test('toClip maps a transcript record to what the page needs', () => {
    assert.deepEqual(toClip(record), {
        id: 'LIN_41_20260926_142849',
        utc: '2026-09-26T10:29:20.153Z',
        driverNumber: 41,
        driver: 'LIN',
        lap: 7,
        text: 'Metallic sound on the rear.',
        audioSrc: '/audio/11377/LIN_41_20260926_142849.mp3',
        context: null,
    });
});

test('toClip drops skipped, empty and malformed records', () => {
    assert.equal(toClip({ ...record, skipped: 'too short', text: null }), null);
    assert.equal(toClip({ ...record, text: '' }), null);
    assert.equal(toClip({ ...record, audioFile: 'LIN.mp3' }), null);
    assert.equal(toClip(null), null);
});

test('toClip normalizes MultiViewer and OpenF1 utc shapes to millisecond ISO', () => {
    assert.equal(toClip({ ...record, utc: '2026-09-26T10:29:20.1530000Z' }).utc, '2026-09-26T10:29:20.153Z');
    assert.equal(toClip({ ...record, utc: '2026-09-26T10:29:20+00:00' }).utc, '2026-09-26T10:29:20.000Z');
});

test('toClip drops records with an unparseable utc', () => {
    assert.equal(toClip({ ...record, utc: 'not a date' }), null);
    assert.equal(toClip({ ...record, utc: undefined }), null);
});

test('toClip defaults missing lap to null', () => {
    const { lap, ...withoutLap } = record;
    assert.equal(toClip(withoutLap).lap, null);
});

test('clipsAfter filters and orders by seq', () => {
    const clips = [{ id: 'c', seq: 3 }, { id: 'a', seq: 1 }, { id: 'b', seq: 2 }];
    assert.deepEqual(clipsAfter(clips, '1').map(({ id }) => id), ['b', 'c']);
    assert.deepEqual(clipsAfter(clips, null).map(({ id }) => id), ['a', 'b', 'c']);
    assert.deepEqual(clipsAfter(clips, 'junk').map(({ id }) => id), ['a', 'b', 'c']);
});

test('toClip accepts records without audio when they carry their own id', () => {
    const clip = toClip({ id: 'mv-1', utc: '2026-10-09T12:36:03.688000Z', driverNumber: 16, driver: 'LEC', text: 'Box box' });
    assert.equal(clip.id, 'mv-1');
    assert.equal(clip.audioSrc, null);
    assert.equal(clip.utc, '2026-10-09T12:36:03.688Z');
});
