import fs from 'node:fs/promises';
import path from 'node:path';

export const readJson = async (file, fallback) => {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return fallback;
    }
};

// Rename gives readers either the old file or the new one, never a half-written file.
// It also changes the inode, which followJsonl treats as a reset.
export const writeFileAtomic = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempFile, text);
    await fs.rename(tempFile, file);
};

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
