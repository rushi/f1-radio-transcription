// Pure helpers for the radio page. Loaded by the browser from /format.mjs and by node tests.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

// Flag terms reuse the colors fans already read on the TV graphics. Everything else is bold only,
// so color stays rare enough to mean something.
const TERM_CLASSES = {
    'virtual safety car': 't-flag-y',
    'safety car': 't-flag-y',
    vsc: 't-flag-y',
    'yellow flag': 't-flag-y',
    'double yellow': 't-flag-y',
    yellows: 't-flag-y',
    'red flag': 't-flag-r',
    retire: 't-flag-r',
    retired: 't-flag-r',
    retirement: 't-flag-r',
    crash: 't-flag-r',
    crashed: 't-flag-r',
    box: '',
    boxing: '',
    penalty: '',
    investigation: '',
    issue: '',
    issues: '',
    damage: '',
    puncture: '',
    rain: '',
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest first so "virtual safety car" wins over "safety car"
const toAlternation = (words) =>
    [...words]
        .sort((a, b) => b.length - a.length)
        .map((word) => escapeRegExp(word).replace(/ /g, '\\s+'))
        .join('|');

// "Lando NORRIS" -> ["Lando", "Norris"]. F1 writes the family name in capitals, which also handles "DE VRIES".
export const getNameWords = (fullName) => {
    const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
    const isFamilyName = (word) => word.length > 1 && word === word.toUpperCase();
    const toTitleCase = (word) => word.charAt(0) + word.slice(1).toLowerCase();
    const firstName = parts.filter((word) => !isFamilyName(word)).join(' ');
    const familyName = parts.filter(isFamilyName).map(toTitleCase).join(' ');
    return [firstName, familyName].filter(Boolean);
};

// A pit call is "box" said twice or more ("box box", "Box, box, box"). It gets its own marker
// because it is the one call worth spotting from across the room; a single "box" stays bold only.
const PIT_CALL_SOURCE = 'box(?:[\\s,.!-]+box)+';
const PIT_CALL_PATTERN = new RegExp(`^${PIT_CALL_SOURCE}$`, 'i');

// names: [{ word, driverNumber, color }]. Terms match in any case, names only as capitalised (Whisper and
// MultiViewer capitalise proper nouns), so "max power" never lights up Max. The speaker's own name stays plain.
// Escapes first, then wraps matches. No term or name contains a character that escaping changes.
export const createHighlighter = (names = []) => {
    const nameByWord = new Map(names.map((name) => [name.word, name]));
    const alternation = toAlternation([...Object.keys(TERM_CLASSES), ...nameByWord.keys()]);
    const pattern = new RegExp(`\\b(${PIT_CALL_SOURCE}|${alternation})\\b`, 'gi');
    return (text, { speakerNumber } = {}) => {
        return escapeHtml(text).replace(pattern, (match) => {
            if (PIT_CALL_PATTERN.test(match)) {
                return `<b class="t-pit">${match}</b>`;
            }
            const name = nameByWord.get(match);
            if (name) {
                if (name.driverNumber === speakerNumber) {
                    return match;
                }
                return `<b class="t-name" style="--name:${escapeHtml(name.color)}">${match}</b>`;
            }
            const className = TERM_CLASSES[match.toLowerCase().replace(/\s+/g, ' ')];
            if (className === undefined) {
                return match;
            }
            return className ? `<b class="${className}">${match}</b>` : `<b>${match}</b>`;
        });
    };
};

export const highlightTerms = createHighlighter();

const toLinear = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

// sRGB hex to OKLCH, using Björn Ottosson's OKLab matrices
export const hexToOklch = (hex) => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!match) {
        return null;
    }
    const value = Number.parseInt(match[1], 16);
    const [r, g, b] = [16, 8, 0].map((shift) => toLinear(((value >> shift) & 255) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { l: lightness, c: Math.hypot(a, bAxis), h: ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360 };
};

// L 0.62 is about 5:1 against #0E0F11 and L 0.58 about 3.9:1 against white, both above the 3:1 needed for UI marks
const DARK_MIN_LIGHTNESS = 0.62;
const LIGHT_MAX_LIGHTNESS = 0.58;

export const teamBarColor = (hex, scheme = 'dark') => {
    const color = hexToOklch(hex);
    if (!color) {
        return 'var(--text-2)';
    }
    const isLight = scheme === 'light';
    const lightness = isLight ? Math.min(color.l, LIGHT_MAX_LIGHTNESS) : Math.max(color.l, DARK_MIN_LIGHTNESS);

    return `oklch(${Number(lightness.toFixed(3))} ${color.c.toFixed(3)} ${color.h.toFixed(1)})`;
};

export const relativeTime = (utc, nowMs = Date.now()) => {
    const seconds = Math.max(0, Math.round((nowMs - Date.parse(utc)) / 1000));
    if (seconds < 10) {
        return 'now';
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    return `${Math.floor(seconds / 3600)}h`;
};

const OLD_AFTER_MS = 5 * 60_000;

export const isOld = (utc, nowMs = Date.now()) => nowMs - Date.parse(utc) > OLD_AFTER_MS;
