// MultiViewer's AI radio transcriptions come over a Phoenix channel on its own backend. This is the
// same socket the MultiViewer app joins; it is undocumented and may change with any app release.
export const MV_SOCKET_URL = 'wss://api.multiviewer.dev/socket/websocket';

const HEARTBEAT_MS = 30_000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

// The numeric id is on every event, including deletes, so it is the stable key
const getRecordId = (message) => {
    const id = message?.id ?? message?.external_id;
    return id == null ? null : `mv-${id}`;
};

export const toRecord = (message, { sessionKey, drivers, lap }) => {
    const id = getRecordId(message);
    const driverNumber = Number(message?.driver_number);
    if (!id || !Number.isInteger(driverNumber)) {
        return null;
    }
    const driver = drivers.get(driverNumber) ?? {};
    return {
        id,
        utc: message.player_ts,
        driverNumber,
        driver: driver.tla ?? null,
        driverName: driver.name ?? null,
        team: driver.team ?? null,
        sessionKey,
        durationMs: message.duration_ms ?? null,
        lap,
        text: String(message.transcription ?? '').trim(),
        source: 'multiviewer-ai',
    };
};

export const toDeletedRecord = (message) => {
    const id = getRecordId(message);
    return id ? { id, deleted: true } : null;
};

export const MV_API_URL = 'https://api.multiviewer.dev';

// Same endpoint MultiViewer's own panel loads history from
export const fetchHistory = async ({ meetingKey, sessionKey }) => {
    const url = new URL(`/api/v1/meetings/${meetingKey}/sessions/${sessionKey}/driver_radio_transcriptions`, MV_API_URL);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`MultiViewer history HTTP ${response.status}`);
    }
    const messages = await response.json();
    return messages.sort((a, b) => Date.parse(a.player_ts) - Date.parse(b.player_ts));
};

export const channelTopic = (sessionKey) => `driver_radio_transcriptions:session:${sessionKey}`;

// Minimal Phoenix v2 client: join one topic, heartbeat, and rejoin with backoff when the socket drops
export const connectChannel = ({ sessionKey, appVersion, onEvent, onStatus = () => {} }) => {
    const topic = channelTopic(sessionKey);
    let socket = null;
    let ref = 0;
    let heartbeat = null;
    let retryTimer = null;
    let retryMs = FIRST_RETRY_MS;
    let isClosed = false;

    const send = (joinRef, sendTopic, event, payload) => {
        ref += 1;
        socket.send(JSON.stringify([joinRef, String(ref), sendTopic, event, payload]));
    };

    const handleMessage = (event) => {
        const [, , messageTopic, name, payload] = JSON.parse(event.data);
        if (messageTopic !== topic) {
            return;
        }
        if (name === 'phx_reply') {
            onStatus(payload?.status === 'ok' ? 'joined' : `join failed: ${JSON.stringify(payload)}`);
            return;
        }
        if (name === 'phx_error' || name === 'phx_close') {
            socket.close();
            return;
        }
        onEvent(name, payload);
    };

    const open = () => {
        socket = new WebSocket(`${MV_SOCKET_URL}?appVersion=${encodeURIComponent(appVersion)}&vsn=2.0.0`);
        socket.addEventListener('open', () => {
            retryMs = FIRST_RETRY_MS;
            send('1', topic, 'phx_join', {});
            heartbeat = setInterval(() => send(null, 'phoenix', 'heartbeat', {}), HEARTBEAT_MS);
        });
        socket.addEventListener('message', handleMessage);
        socket.addEventListener('close', () => {
            clearInterval(heartbeat);
            if (isClosed) {
                return;
            }
            onStatus(`disconnected, retrying in ${retryMs / 1000}s`);
            retryTimer = setTimeout(open, retryMs);
            retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        });
        // A close event always follows an error, and that is where the retry happens
        socket.addEventListener('error', () => {});
    };

    open();
    return () => {
        isClosed = true;
        clearTimeout(retryTimer);
        clearInterval(heartbeat);
        socket?.close();
    };
};
