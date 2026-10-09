import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyTeamColors, readTeamColorOverrides } from '../lib/team-colors.mjs';
import { makeTempDir } from './helpers.mjs';

test('readTeamColorOverrides keeps valid team entries from the MultiViewer config', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({
        colorCustomizations: [
            { type: 'team', colorHex: '#c23055', teamName: 'Red Bull Racing' },
            { type: 'driver', colorHex: '#FFFFFF', teamName: 'Ferrari' },
            { type: 'team', colorHex: 'nope', teamName: 'Alpine' },
        ],
    }));
    assert.deepEqual([...await readTeamColorOverrides(file)], [['Red Bull Racing', 'C23055']]);
    assert.equal((await readTeamColorOverrides(path.join(dir, 'missing.json'))).size, 0);
});

test('applyTeamColors replaces only overridden teams', () => {
    const drivers = [{ number: 1, team: 'McLaren', teamColour: 'F47600' }, { number: 63, team: 'Mercedes', teamColour: '00D7B6' }];
    assert.deepEqual(applyTeamColors(drivers, new Map([['McLaren', 'FF8000']])).map(({ teamColour }) => teamColour), ['FF8000', '00D7B6']);
});
