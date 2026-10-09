import path from 'node:path';

const SESSION_KEY_PATTERN = /^[\w-]{1,64}$/;
const AUDIO_FILE_PATTERN = /^[\w-][\w.-]{0,200}\.mp3$/;

// Returns null to serve the whole file: no header, or a form we don't support (multiple ranges).
export const parseRange = (header, size) => {
    if (!header) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return null;
    }
    const [, startText, endText] = match;
    if (startText === '' && endText === '') {
        return null;
    }
    if (startText === '') {
        const suffixLength = Number(endText);
        if (suffixLength === 0) {
            return 'unsatisfiable';
        }
        return { start: Math.max(size - suffixLength, 0), end: size - 1 };
    }

    const start = Number(startText);
    const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
    if (start >= size || start > end) {
        return 'unsatisfiable';
    }
    return { start, end };
};

export const resolveAudioPath = (dataDir, sessionKey, fileName) => {
    if (!SESSION_KEY_PATTERN.test(sessionKey) || !AUDIO_FILE_PATTERN.test(fileName)) {
        return null;
    }

    const root = path.resolve(dataDir);
    const filePath = path.resolve(root, sessionKey, 'audio', fileName);
    return filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
};

export const readBody = (req, limitBytes = 10_000) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        req.on('data', (chunk) => {
            length += chunk.length;
            if (length > limitBytes) {
                const error = new Error('body too large');
                error.statusCode = 413;
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
};
