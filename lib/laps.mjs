// samples are appended in time order, so the last one at or before the clip is the lap in progress
export const lapAt = (samples, utc) => {
    const time = Date.parse(utc);
    let lap = null;
    for (const sample of samples) {
        if (Date.parse(sample.utc) > time) {
            break;
        }
        lap = sample.lap;
    }
    return lap;
};

export const shouldRecordLap = (samples, lap) => Number.isInteger(lap) && samples.at(-1)?.lap !== lap;
