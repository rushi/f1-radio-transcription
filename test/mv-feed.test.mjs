import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelTopic, toDeletedRecord, toRecord } from '../lib/mv-feed.mjs';

const message = {
    id: 2440575,
    external_id: '74f0477664a526b3565883ed',
    driver_number: '16',
    transcription: '  Box, Charles, box. ',
    player_ts: '2026-10-09T12:36:03.688000Z',
    duration_ms: 7208,
};
const drivers = new Map([[16, { number: 16, tla: 'LEC', name: 'Charles LECLERC', team: 'Ferrari' }]]);

test('toRecord maps a MultiViewer transcription to a transcript record', () => {
    assert.deepEqual(toRecord(message, { sessionKey: '11379', drivers, lap: 3 }), {
        id: 'mv-2440575',
        utc: '2026-10-09T12:36:03.688000Z',
        driverNumber: 16,
        driver: 'LEC',
        driverName: 'Charles LECLERC',
        team: 'Ferrari',
        sessionKey: '11379',
        durationMs: 7208,
        lap: 3,
        text: 'Box, Charles, box.',
        source: 'multiviewer-ai',
    });
});

test('toRecord keeps unknown drivers and rejects messages without id or driver number', () => {
    assert.equal(toRecord({ ...message, driver_number: '99' }, { sessionKey: 's', drivers, lap: null }).driver, null);
    assert.equal(toRecord({ ...message, id: undefined, external_id: undefined }, { sessionKey: 's', drivers, lap: null }), null);
    assert.equal(toRecord({ ...message, driver_number: 'x' }, { sessionKey: 's', drivers, lap: null }), null);
});

test('toDeletedRecord uses the same id as toRecord', () => {
    assert.deepEqual(toDeletedRecord({ id: 2440575 }), { id: 'mv-2440575', deleted: true });
    assert.equal(toDeletedRecord({}), null);
});

test('channelTopic names the per-session channel', () => {
    assert.equal(channelTopic('11379'), 'driver_radio_transcriptions:session:11379');
});
