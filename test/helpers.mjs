import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const makeTempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'radio-test-'));

// Polls until check() returns a truthy value. File watchers fire asynchronously, so tests wait instead of sleeping a fixed time.
export const waitFor = async (check, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) {
            return value;
        }
        await sleep(20);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
};
