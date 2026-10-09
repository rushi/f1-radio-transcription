import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDriverContext, getTrackStatusLabel, normalizeRaceControl } from '../lib/context.mjs';

const timingAppData = {
    Lines: {
        1: { Stints: [{ Compound: 'MEDIUM', TotalLaps: 1 }, { Compound: 'SOFT', TotalLaps: 12 }] },
        16: { Stints: { 0: { Compound: 'HARD', TotalLaps: 3 } } },
    },
};

test('buildDriverContext reads race position, interval, tyre and pit state', () => {
    const timingData = {
        Lines: {
            1: { Position: '4', IntervalToPositionAhead: { Value: '+0.812' }, InPit: false, PitOut: true },
            16: { Position: '1', IntervalToPositionAhead: { Value: '' } },
        },
    };
    assert.deepEqual(buildDriverContext({ timingData, timingAppData, trackStatus: { Status: '4' }, driverNumber: 1 }), {
        position: 4,
        gapAhead: '+0.812',
        tyre: { compound: 'SOFT', letter: 'S', age: 12 },
        pit: 'OUT',
        trackStatus: 'SC',
        driverLap: null,
    });
    const leader = buildDriverContext({ timingData, timingAppData, trackStatus: { Status: '1' }, driverNumber: 16 });
    assert.equal(leader.gapAhead, null);
    assert.deepEqual(leader.tyre, { compound: 'HARD', letter: 'H', age: 3 });
    assert.equal(leader.trackStatus, null);
});

test('buildDriverContext uses the qualifying part gap when there is no race interval', () => {
    const timingData = {
        SessionPart: 2,
        Lines: { 1: { Position: '6', InPit: true, Stats: [{ TimeDifftoPositionAhead: '+0.300' }, { TimeDifftoPositionAhead: '+0.075' }] } },
    };
    const context = buildDriverContext({ timingData, timingAppData, trackStatus: null, driverNumber: 1 });
    assert.equal(context.gapAhead, '+0.075');
    assert.equal(context.pit, 'PIT');
});

test('buildDriverContext tolerates missing timing for a driver', () => {
    assert.deepEqual(buildDriverContext({ timingData: {}, timingAppData: {}, trackStatus: null, driverNumber: 99 }), {
        position: null,
        gapAhead: null,
        tyre: null,
        pit: null,
        trackStatus: null,
        driverLap: null,
    });
});

test('getTrackStatusLabel names the statuses worth a chip', () => {
    assert.equal(getTrackStatusLabel({ Status: '5' }), 'RED');
    assert.equal(getTrackStatusLabel({ Status: '6' }), 'VSC');
    assert.equal(getTrackStatusLabel({ Status: '2' }), null);
});

test('normalizeRaceControl keeps car-specific messages with UTC times', () => {
    const messages = normalizeRaceControl({
        Messages: [
            { Utc: '2026-10-09T12:53:13', Category: 'Flag', Message: 'FIRST CAR TO TAKE THE FLAG - CAR 18 (STR)', Flag: 'CHEQUERED' },
            { Utc: '2026-10-09T12:55:03', Category: 'Other', Message: 'START OF SQ2 WILL BE DELAYED' },
            { Utc: '2026-10-09T12:56:00', Category: 'Other', Message: 'CARS 16 (LEC) AND 44 (HAM) NOTED - UNSAFE RELEASE' },
            { Utc: '2026-10-09T12:57:00Z', Category: 'Other', Message: 'Penalty', RacingNumber: '4' },
        ],
    });
    assert.deepEqual(messages.map(({ utc, cars }) => [utc, cars]), [
        ['2026-10-09T12:53:13.000Z', [18]],
        ['2026-10-09T12:56:00.000Z', [16, 44]],
        ['2026-10-09T12:57:00.000Z', [4]],
    ]);
});

test('buildDriverContext hides an unconfirmed compound', () => {
    const context = buildDriverContext({ timingData: {}, timingAppData: { Lines: { 10: { Stints: [{ Compound: 'UNKNOWN', TotalLaps: 0 }] } } }, trackStatus: null, driverNumber: 10 });
    assert.equal(context.tyre, null);
});

test('buildDriverContext gives the lap being driven only in races', () => {
    const timingData = { Lines: { 1: { Position: '3', NumberOfLaps: 22 }, 2: { Position: '19', NumberOfLaps: 21, Retired: true } } };
    assert.equal(buildDriverContext({ timingData, driverNumber: 1, isRace: true }).driverLap, 23);
    assert.equal(buildDriverContext({ timingData, driverNumber: 1, isRace: false }).driverLap, null);
    assert.equal(buildDriverContext({ timingData, driverNumber: 2, isRace: true }).driverLap, null);
});
