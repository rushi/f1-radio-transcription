import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionFollower } from '../lib/session-follower.mjs';
import { writeFileAtomic, writeJsonAtomic } from '../lib/json-file.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeTempDir, waitFor } from './helpers.mjs';

const makeRecord = (id, overrides = {}) => ({
    utc: '2026-10-11T12:00:00Z',
    driverNumber: 1,
    driver: 'NOR',
    audioFile: `s1/audio/${id}.mp3`,
    text: `text ${id}`,
    ...overrides,
});
const line = (value) => `${JSON.stringify(value)}\n`;

const setup = async () => {
    const dataDir = await makeTempDir();
    await writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: 's1', updatedAt: 'a', drivers: [] });
    await fs.mkdir(path.join(dataDir, 's1'));
    await fs.writeFile(path.join(dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('one')) + line(makeRecord('skip', { skipped: 'too short', text: null })));
    const events = { sessions: [], clips: [], resets: 0 };
    const follower = await createSessionFollower({
        dataDir,
        intervalMs: 20,
        onSession: (session) => events.sessions.push(session),
        onClip: (clip) => events.clips.push(clip),
        onReset: () => { events.resets += 1; },
    });
    return { dataDir, follower, events };
};

test('loads the current session and its clips on start, without skipped records', async () => {
    const { follower, events } = await setup();
    try {
        assert.equal(follower.getSession().sessionKey, 's1');
        assert.deepEqual(follower.getClips().map(({ id }) => id), ['one']);
        assert.equal(events.clips.length, 0);
    } finally {
        follower.stop();
    }
});

test('emits appended clips with increasing seq', async () => {
    const { dataDir, follower, events } = await setup();
    try {
        await fs.appendFile(path.join(dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('two')));
        await waitFor(() => events.clips.length === 1);
        assert.equal(events.clips[0].id, 'two');
        assert.equal(events.clips[0].seq, follower.getClips()[0].seq + 1);
    } finally {
        follower.stop();
    }
});

test('a restarted follower hands out seqs above everything the previous instance used', async () => {
    const { dataDir, follower, events } = await setup();
    let restarted;
    try {
        await fs.appendFile(path.join(dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('two')));
        await waitFor(() => events.clips.length === 1);
        const maxFirstSeq = Math.max(...follower.getClips().map(({ seq }) => seq));
        follower.stop();

        restarted = await createSessionFollower({ dataDir, intervalMs: 20 });
        const restartedSeqs = restarted.getClips().map(({ seq }) => seq);
        assert.equal(restartedSeqs.length, 2);
        assert.ok(restartedSeqs.every((seq) => seq > maxFirstSeq));
    } finally {
        follower.stop();
        restarted?.stop();
    }
});

test('emits session updates for the same session and switches on a new sessionKey', async () => {
    const { dataDir, follower, events } = await setup();
    try {
        const firstSeq = follower.getClips()[0].seq;
        await writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: 's1', updatedAt: 'b', lap: 4, drivers: [] });
        await waitFor(() => events.sessions.some(({ updatedAt }) => updatedAt === 'b'));
        assert.equal(follower.getClips().length, 1);

        await fs.mkdir(path.join(dataDir, 's2'));
        await fs.writeFile(path.join(dataDir, 's2', 'transcripts.jsonl'), line(makeRecord('fp2', { audioFile: 's2/audio/fp2.mp3' })));
        await writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: 's2', updatedAt: 'c', drivers: [] });
        await waitFor(() => follower.getSession().sessionKey === 's2');
        assert.deepEqual(follower.getClips().map(({ id }) => id), ['fp2']);
        assert.ok(follower.getClips()[0].seq > firstSeq);
    } finally {
        follower.stop();
    }
});

test('reloads and reports reset when the transcript file is replaced', async () => {
    const { dataDir, follower, events } = await setup();
    try {
        await writeFileAtomic(path.join(dataDir, 's1', 'transcripts.jsonl'), line(makeRecord('redo-a')) + line(makeRecord('redo-b')));
        await waitFor(() => events.resets === 1);
        assert.deepEqual(follower.getClips().map(({ id }) => id).sort(), ['redo-a', 'redo-b']);
    } finally {
        follower.stop();
    }
});

test('starts with no session when current.json is missing', async () => {
    const dataDir = await makeTempDir();
    const follower = await createSessionFollower({ dataDir, intervalMs: 20 });
    try {
        assert.equal(follower.getSession(), null);
        assert.deepEqual(follower.getClips(), []);
    } finally {
        follower.stop();
    }
});

test('a transcript reset in the old session never reloads its clips after a session switch', async () => {
    const { dataDir, follower } = await setup();
    try {
        let previous = 's1';
        for (let index = 2; index <= 9; index += 1) {
            const next = `s${index}`;
            await fs.mkdir(path.join(dataDir, next));
            await fs.writeFile(path.join(dataDir, next, 'transcripts.jsonl'), line(makeRecord(`clip-${next}`)));
            // Same poll window: the old tail sees a replaced file while current.json points at the new session
            await Promise.all([
                writeFileAtomic(path.join(dataDir, previous, 'transcripts.jsonl'), line(makeRecord(`redo-${previous}`))),
                writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: next, updatedAt: `u${index}`, drivers: [] }),
            ]);
            await waitFor(() => follower.getSession().sessionKey === next);
            await sleep(100);
            assert.deepEqual(follower.getClips().map(({ id }) => id), [`clip-${next}`]);
            previous = next;
        }
    } finally {
        follower.stop();
    }
});

test('stop() prevents a later session change from starting a new tail', async () => {
    const { dataDir, follower } = await setup();
    follower.stop();
    await fs.mkdir(path.join(dataDir, 's2'));
    await fs.writeFile(path.join(dataDir, 's2', 'transcripts.jsonl'), line(makeRecord('fp2')));
    await writeJsonAtomic(path.join(dataDir, 'current.json'), { sessionKey: 's2', updatedAt: 'c', drivers: [] });
    await sleep(150);
    assert.equal(follower.getSession().sessionKey, 's1');
    assert.deepEqual(follower.getClips().map(({ id }) => id), ['one']);
});

test('a record with a known id replaces the clip and a deleted record removes it', async () => {
    const { dataDir, follower, events } = await setup();
    try {
        const file = path.join(dataDir, 's1', 'transcripts.jsonl');
        const before = follower.getClips()[0];
        await fs.appendFile(file, line({ id: 'mv-9', utc: '2026-10-11T12:00:00Z', driverNumber: 1, text: 'first try' }));
        await waitFor(() => events.clips.length === 1);
        await fs.appendFile(file, line({ id: 'mv-9', utc: '2026-10-11T12:00:00Z', driverNumber: 1, text: 'corrected' }));
        await waitFor(() => events.clips.length === 2);
        assert.equal(events.clips[1].text, 'corrected');
        assert.ok(events.clips[1].seq > events.clips[0].seq);
        assert.equal(follower.getClips().find(({ id }) => id === 'mv-9').text, 'corrected');
        await fs.appendFile(file, line({ id: 'mv-9', deleted: true }));
        await waitFor(() => events.clips.length === 3);
        assert.deepEqual({ id: events.clips[2].id, deleted: events.clips[2].deleted }, { id: 'mv-9', deleted: true });
        assert.deepEqual(follower.getClips().map(({ id }) => id), [before.id]);
    } finally {
        follower.stop();
    }
});
