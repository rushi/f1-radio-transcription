import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { readJson } from './json-file.mjs';
import { readJsonl, followJsonl } from './jsonl.mjs';
import { toClip } from './clips.mjs';

export const CURRENT_FILE = 'current.json';

const noop = () => {};

export const createSessionFollower = async ({ dataDir, intervalMs = 1000, onSession = noop, onClip = noop, onReset = noop }) => {
    const currentFile = path.join(dataDir, CURRENT_FILE);
    let session = null;
    let clips = new Map();
    // seq never restarts within a process, so a page holding an old seq never skips clips after a reset or session change.
    // Seeding from the clock keeps it ahead of every seq a previous process handed out, so a phone that
    // reconnects after a server restart still gets /api/clips?after=<old seq> clips instead of nothing.
    let nextSeq = Date.now();
    let stopTail = noop;
    let chain = Promise.resolve();
    let isStopped = false;
    // Bumped synchronously by each load so a queued reset from a replaced tail can tell it is stale
    let generation = 0;

    const enqueue = (task) => {
        chain = chain.then(task).catch((error) => console.error(error));
        return chain;
    };

    const takeSeq = () => {
        const seq = nextSeq;
        nextSeq += 1;
        return seq;
    };

    // A record with a known id replaces the earlier one (MultiViewer corrects transcriptions), and
    // { id, deleted: true } removes it. Both get a fresh seq so a phone catching up sees the change.
    const addRecords = (records, isLive) => {
        for (const record of records) {
            const isDeletion = record?.deleted === true && record.id != null;
            if (isDeletion) {
                const id = String(record.id);
                const wasKnown = clips.delete(id);
                if (wasKnown && isLive) {
                    onClip({ id, deleted: true, seq: takeSeq() });
                }
                continue;
            }
            const clip = toClip(record);
            if (!clip) {
                continue;
            }
            const existing = clips.get(clip.id);
            if (existing && existing.text === clip.text) {
                continue;
            }
            const clipWithSeq = { ...clip, seq: takeSeq() };
            clips.set(clip.id, clipWithSeq);
            if (isLive) {
                onClip(clipWithSeq);
            }
        }
    };

    const loadSession = async (sessionKey) => {
        generation += 1;
        const loadGeneration = generation;
        stopTail();
        const file = path.join(dataDir, sessionKey, 'transcripts.jsonl');
        const { records, size, ino } = await readJsonl(file);
        // stop() or a newer load may have happened during the read, and starting a tail now would leak it
        if (isStopped || loadGeneration !== generation) {
            return;
        }
        clips = new Map();
        addRecords(records, false);
        stopTail = followJsonl({
            file,
            fromSize: size,
            fromIno: ino,
            intervalMs,
            onRecords: (newRecords) => addRecords(newRecords, true),
            onReset: () => {
                return enqueue(async () => {
                    if (isStopped || loadGeneration !== generation) {
                        return;
                    }
                    await loadSession(sessionKey);
                    onReset();
                });
            },
        });
    };

    const refreshCurrent = async () => {
        if (isStopped) {
            return;
        }
        const next = await readJson(currentFile, null);
        if (!next?.sessionKey) {
            return;
        }
        const isNewSession = String(next.sessionKey) !== String(session?.sessionKey);
        const isUpdated = next.updatedAt !== session?.updatedAt;
        if (!isNewSession && !isUpdated) {
            return;
        }
        if (isNewSession) {
            await loadSession(String(next.sessionKey));
            if (isStopped) {
                return;
            }
        }
        session = next;
        onSession(session);
    };

    await refreshCurrent();
    const handleCurrentChange = () => enqueue(refreshCurrent);
    watchFile(currentFile, { interval: intervalMs }, handleCurrentChange);

    return {
        getSession: () => session,
        getClips: () => [...clips.values()].sort((a, b) => a.seq - b.seq),
        stop: () => {
            isStopped = true;
            unwatchFile(currentFile, handleCurrentChange);
            stopTail();
        },
    };
};
