import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';

const NEWLINE = 0x0a;

const parseLines = (text) => {
    const records = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            records.push(JSON.parse(line));
        } catch {
            // A malformed line should not hide every record after it
        }
    }
    return records;
};

export const readJsonl = async (file) => {
    let handle;
    try {
        handle = await fs.open(file, 'r');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { records: [], size: 0, ino: 0 };
        }
        throw error;
    }
    try {
        const { ino } = await handle.stat();
        const buffer = await handle.readFile();
        const size = buffer.lastIndexOf(NEWLINE) + 1;
        return { records: parseLines(buffer.subarray(0, size).toString('utf8')), size, ino };
    } finally {
        await handle.close();
    }
};

// fs.watch is unreliable for appends on macOS, so this polls with fs.watchFile.
export const followJsonl = ({ file, fromSize = 0, fromIno = 0, intervalMs = 1000, onRecords, onReset }) => {
    let offset = fromSize;
    let ino = fromIno;
    // Kept as bytes so a multibyte character split across two reads is decoded whole
    let partial = Buffer.alloc(0);
    let isStopped = false;
    let chain = Promise.resolve();

    const readNew = async (size) => {
        const handle = await fs.open(file, 'r');
        try {
            const buffer = Buffer.alloc(size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            offset += bytesRead;
            const chunk = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
            const end = chunk.lastIndexOf(NEWLINE) + 1;
            partial = chunk.subarray(end);
            const records = parseLines(chunk.subarray(0, end).toString('utf8'));
            if (records.length > 0 && !isStopped) {
                onRecords(records);
            }
        } finally {
            await handle.close();
        }
    };

    const check = async (current) => {
        if (isStopped) {
            return;
        }
        const isReplaced = ino !== 0 && current.ino !== 0 && current.ino !== ino;
        if (current.size < offset || isReplaced) {
            offset = 0;
            ino = current.ino;
            partial = Buffer.alloc(0);
            onReset();
            return;
        }
        ino = current.ino || ino;
        if (current.size > offset) {
            await readNew(current.size);
        }
    };

    // Serialized so two quick changes never read the same bytes twice
    const handleChange = (current) => {
        chain = chain.then(() => check(current)).catch((error) => console.error(error));
    };

    watchFile(file, { interval: intervalMs }, handleChange);
    // watchFile only reports changes after its own first stat, so anything written since the caller's readJsonl would wait for the next change
    fs.stat(file)
        .catch((error) => {
            if (error.code === 'ENOENT') {
                return { size: 0, ino: 0 };
            }
            throw error;
        })
        .then(handleChange, (error) => console.error(error));
    return () => {
        isStopped = true;
        unwatchFile(file, handleChange);
    };
};
