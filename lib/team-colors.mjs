import os from 'node:os';
import path from 'node:path';
import { readJson } from './json-file.mjs';

// MultiViewer keeps the user's team color overrides (Settings > accessibility colors) in its config file
export const MULTIVIEWER_CONFIG_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'MultiViewer', 'config.json');

// Read on every call so a change in MultiViewer shows up on the next poll; a missing or unreadable file means no overrides
export const readTeamColorOverrides = async (configFile = MULTIVIEWER_CONFIG_FILE) => {
    const config = await readJson(configFile, null);
    const overrides = new Map();
    for (const entry of config?.colorCustomizations ?? []) {
        const hex = /^#?([0-9a-f]{6})$/i.exec(entry?.colorHex ?? '')?.[1];
        if (entry?.type === 'team' && entry.teamName && hex) {
            overrides.set(entry.teamName, hex.toUpperCase());
        }
    }
    return overrides;
};

export const applyTeamColors = (drivers, overrides) => {
    return drivers.map((driver) => {
        return overrides.has(driver.team) ? { ...driver, teamColour: overrides.get(driver.team) } : driver;
    });
};
