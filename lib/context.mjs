// Race context captured next to each radio message: where the driver is, on what tyres, and what the track
// is doing. Inputs are MultiViewer's F1 live timing topics.

// F1 track status codes; green (1) and yellow (2) are too common to be worth a chip
const TRACK_STATUS_LABELS = { 4: 'SC', 5: 'RED', 6: 'VSC', 7: 'VSC ENDING' };

const COMPOUND_LETTERS = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

const RACE_CONTROL_LIMIT = 150;

// Live timing patches can turn arrays into objects keyed "0", "1", ...
const toList = (value) => (Array.isArray(value) ? value : Object.values(value ?? {}));

// Race uses IntervalToPositionAhead; qualifying keeps the gap per part in Stats
const getGapAhead = (line, sessionPart) => {
    const interval = line.IntervalToPositionAhead?.Value;
    if (interval) {
        return interval;
    }

    const stats = toList(line.Stats);
    const partIndex = Number.isInteger(sessionPart) ? sessionPart - 1 : stats.length - 1;
    return stats[partIndex]?.TimeDifftoPositionAhead || null;
};

const getTyre = (appLine) => {
    const stint = toList(appLine?.Stints).at(-1);
    // F1 sends UNKNOWN (or TEST_UNKNOWN) until the compound is confirmed, which is worth nothing on screen
    if (!stint?.Compound || /UNKNOWN/.test(stint.Compound)) {
        return null;
    }
    return {
        compound: stint.Compound,
        letter: COMPOUND_LETTERS[stint.Compound] ?? stint.Compound.charAt(0),
        age: Number.isInteger(stint.TotalLaps) ? stint.TotalLaps : null,
    };
};

const getPitState = (line) => {
    if (line.InPit) {
        return 'PIT';
    }
    if (line.PitOut) {
        return 'OUT';
    }
    return null;
};

export const getTrackStatusLabel = (trackStatus) => TRACK_STATUS_LABELS[Number(trackStatus?.Status)] ?? null;

// In a race NumberOfLaps counts completed laps, so the lap being driven is one more. Outside races laps are
// not a shared count, so nothing is shown.
const getDriverLap = (line, isRace) => {
    const completed = Number(line?.NumberOfLaps);
    if (!isRace || !Number.isInteger(completed) || line.Retired || line.Stopped) {
        return null;
    }
    return completed + 1;
};

export const buildDriverContext = ({ timingData, timingAppData, trackStatus, driverNumber, isRace = false }) => {
    const line = timingData?.Lines?.[driverNumber];
    const position = Number(line?.Position);
    const hasPosition = Number.isInteger(position) && position > 0;
    return {
        position: hasPosition ? position : null,
        gapAhead: line && hasPosition && position > 1 ? getGapAhead(line, timingData.SessionPart) : null,
        tyre: getTyre(timingAppData?.Lines?.[driverNumber]),
        pit: line ? getPitState(line) : null,
        trackStatus: getTrackStatusLabel(trackStatus),
        driverLap: getDriverLap(line, isRace),
    };
};

// "CAR 16 (LEC)" or "CARS 16 AND 44" in the text, or a RacingNumber field on driver-specific messages
const getCars = (message) => {
    const cars = new Set();
    if (message.RacingNumber != null) {
        cars.add(Number(message.RacingNumber));
    }
    for (const match of String(message.Message ?? '').matchAll(/\bCARS?\s+((?:\d+(?:\s*\([A-Z]{3}\))?(?:\s*,\s*|\s+AND\s+)?)+)/g)) {
        for (const number of match[1].matchAll(/\d+/g)) {
            cars.add(Number(number[0]));
        }
    }
    return [...cars];
};

// Race control Utc has no zone suffix but is UTC, so it gets a Z before parsing
const toUtc = (value) => {
    const text = String(value ?? '');
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(text);
    const time = Date.parse(hasZone ? text : `${text}Z`);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
};

export const normalizeRaceControl = (raceControlMessages) => {
    return toList(raceControlMessages?.Messages)
        .map((message) => ({
            utc: toUtc(message.Utc),
            message: message.Message ?? '',
            category: message.Category ?? null,
            flag: message.Flag ?? null,
            cars: getCars(message),
        }))
        .filter(({ utc, cars }) => utc && cars.length > 0)
        .slice(-RACE_CONTROL_LIMIT);
};
