import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lapAt, shouldRecordLap } from '../lib/laps.mjs';

const samples = [
    { utc: '2026-10-11T12:00:00.000Z', lap: 1 },
    { utc: '2026-10-11T12:01:40.000Z', lap: 2 },
    { utc: '2026-10-11T12:03:20.000Z', lap: 3 },
];

test('lapAt returns the lap in progress at the clip time', () => {
    assert.equal(lapAt(samples, '2026-10-11T12:02:00.000Z'), 2);
    assert.equal(lapAt(samples, '2026-10-11T12:03:20.000Z'), 3);
    assert.equal(lapAt(samples, '2026-10-11T13:00:00.000Z'), 3);
});

test('lapAt returns null before the first sample or with no samples', () => {
    assert.equal(lapAt(samples, '2026-10-11T11:59:59.000Z'), null);
    assert.equal(lapAt([], '2026-10-11T12:00:00.000Z'), null);
});

test('lapAt handles MultiViewer 7-digit fractions and OpenF1 offsets', () => {
    assert.equal(lapAt(samples, '2026-10-11T12:02:00.5490128Z'), 2);
    assert.equal(lapAt(samples, '2026-10-11T12:02:00.153000+00:00'), 2);
});

test('shouldRecordLap only records integer laps that changed', () => {
    assert.equal(shouldRecordLap([], 1), true);
    assert.equal(shouldRecordLap(samples, 3), false);
    assert.equal(shouldRecordLap(samples, 4), true);
    assert.equal(shouldRecordLap(samples, null), false);
});
