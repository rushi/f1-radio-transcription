import path from 'node:path';
import { readJson, writeJsonAtomic } from './json-file.mjs';

export const SELECTION_FILE = 'selection.json';
const MAX_DRIVERS = 30;

const isValidNumber = (number) => Number.isInteger(number) && number > 0 && number < 100;

export const readSelection = async (dataDir) => {
    const value = await readJson(path.join(dataDir, SELECTION_FILE), null);
    const drivers = Array.isArray(value?.drivers) ? value.drivers.filter(Number.isInteger) : [];
    return { drivers, updatedAt: value?.updatedAt ?? null };
};

export const writeSelection = async (dataDir, drivers) => {
    const selection = { drivers, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(dataDir, SELECTION_FILE), selection);
    return selection;
};

// knownNumbers is null when no session is loaded yet, so any plausible car number is accepted
export const parseSelectionBody = (text, knownNumbers) => {
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return { error: 'body must be JSON' };
    }
    const drivers = body?.drivers;
    if (!Array.isArray(drivers) || drivers.length > MAX_DRIVERS) {
        return { error: `drivers must be an array of up to ${MAX_DRIVERS} numbers` };
    }
    if (!drivers.every(isValidNumber)) {
        return { error: 'driver numbers must be integers from 1 to 99' };
    }
    const unknown = knownNumbers ? drivers.filter((number) => !knownNumbers.has(number)) : [];
    if (unknown.length > 0) {
        return { error: `unknown drivers: ${unknown.join(', ')}` };
    }
    return { drivers: [...new Set(drivers)].sort((a, b) => a - b) };
};

export const isSelected = (selection, driverNumber) => selection.drivers.length === 0 || selection.drivers.includes(driverNumber);

// Newest first so a backfill of a newly picked driver never delays a live clip
export const pickClipsToProcess = ({ clips, seenUrls, selection }) => {
    return clips
        .filter((clip) => !seenUrls.has(clip.audioUrl) && isSelected(selection, clip.driverNumber))
        .sort((a, b) => Date.parse(b.utc) - Date.parse(a.utc));
};
