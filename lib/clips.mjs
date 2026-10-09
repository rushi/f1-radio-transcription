// audioFile is written by the transcriber as "<sessionDir>/audio/<file>.mp3"
const getAudio = (audioFile) => {
    if (typeof audioFile !== 'string') {
        return null;
    }
    const parts = audioFile.split('/');
    if (parts.length !== 3) {
        return null;
    }
    const [sessionDir, , fileName] = parts;
    return { id: fileName.replace(/\.mp3$/, ''), audioSrc: `/audio/${sessionDir}/${fileName}` };
};

// Whisper records are keyed by their MP3; MultiViewer AI records have no audio and carry their own id
export const toClip = (record) => {
    if (!record || record.skipped || !record.text) {
        return null;
    }
    const audio = getAudio(record.audioFile);
    const id = record.id ?? audio?.id;
    if (id == null) {
        return null;
    }
    const utcMs = Date.parse(record.utc);
    if (Number.isNaN(utcMs)) {
        return null;
    }
    return {
        id: String(id),
        // MultiViewer sends 7 fraction digits and OpenF1 a +00:00 offset, so the page always gets one ISO shape
        utc: new Date(utcMs).toISOString(),
        driverNumber: record.driverNumber,
        driver: record.driver ?? null,
        lap: record.lap ?? null,
        text: record.text,
        audioSrc: audio?.audioSrc ?? null,
        context: record.context ?? null,
    };
};

export const clipsAfter = (clips, after) => {
    const afterSeq = Number.parseInt(after, 10);
    const hasAfter = Number.isInteger(afterSeq);
    return clips.filter(({ seq }) => !hasAfter || seq > afterSeq).sort((a, b) => a.seq - b.seq);
};
