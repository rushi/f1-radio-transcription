// Serves the live radio page and pushes new transcripts from data/ over SSE.
// Usage: node server.mjs   (PORT and DATA_DIR env vars override 10303 and ./data)

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSessionFollower } from './lib/session-follower.mjs';
import { readSelection, writeSelection, parseSelectionBody } from './lib/selection.mjs';
import { parseRange, resolveAudioPath, readBody } from './lib/http.mjs';
import { clipsAfter } from './lib/clips.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 10303;
const STATIC_FILES = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/format.mjs': { file: 'format.mjs', type: 'text/javascript; charset=utf-8' },
};
const AUDIO_ROUTE = /^\/audio\/([^/]+)\/([^/]+)$/;

const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
};

const parseUrl = (target) => {
    try {
        return new URL(target, 'http://localhost');
    } catch {
        return null;
    }
};

// Malformed percent-escapes are a client error, not a server fault
const safeDecode = (part) => {
    try {
        return decodeURIComponent(part);
    } catch {
        return null;
    }
};

export const createRadioServer = async ({ dataDir, webDir = path.join(ROOT, 'web'), intervalMs = 1000, keepaliveMs = 15_000 }) => {
    const clients = new Set();

    const broadcast = (event, data) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) {
            res.write(payload);
        }
    };

    const follower = await createSessionFollower({
        dataDir,
        intervalMs,
        onSession: (session) => broadcast('session', session),
        onClip: (clip) => broadcast('clip', clip),
        onReset: () => broadcast('reset', {}),
    });

    // Idle Wi-Fi and phone browsers drop silent connections, so the stream always has traffic
    const keepalive = setInterval(() => {
        for (const res of clients) {
            res.write(': keep-alive\n\n');
        }
    }, keepaliveMs);

    const handleStatic = async (res, { file, type }) => {
        const body = await fs.readFile(path.join(webDir, file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(body);
    };

    const handleStream = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
    };

    const handleSelectionPut = async (req, res) => {
        const drivers = follower.getSession()?.drivers;
        const knownNumbers = Array.isArray(drivers) && drivers.length > 0 ? new Set(drivers.map(({ number }) => number)) : null;
        const result = parseSelectionBody(await readBody(req), knownNumbers);
        if (result.error) {
            sendJson(res, 400, { error: result.error });
            return;
        }
        const selection = await writeSelection(dataDir, result.drivers);
        broadcast('selection', selection);
        sendJson(res, 200, selection);
    };

    const handleAudio = async (req, res, sessionKey, fileName) => {
        const filePath = resolveAudioPath(dataDir, sessionKey, fileName);
        const stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
        if (!stat?.isFile()) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
        const range = parseRange(req.headers.range, stat.size);
        if (range === 'unsatisfiable') {
            res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
            res.end();
            return;
        }
        const isPartial = range !== null;
        const { start, end } = range ?? { start: 0, end: stat.size - 1 };
        res.writeHead(isPartial ? 206 : 200, {
            ...headers,
            'Content-Length': end - start + 1,
            ...(isPartial && { 'Content-Range': `bytes ${start}-${end}/${stat.size}` }),
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        // pipeline destroys the file stream when the client aborts a range request and surfaces read errors
        pipeline(createReadStream(filePath, { start, end }), res, (error) => {
            if (!error || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                return;
            }
            console.error(error);
            res.destroy();
        });
    };

    const handleRequest = async (req, res) => {
        const url = parseUrl(req.url);
        if (!url) {
            sendJson(res, 400, { error: 'bad request' });
            return;
        }
        const { pathname } = url;
        const isRead = req.method === 'GET' || req.method === 'HEAD';

        if (isRead && STATIC_FILES[pathname]) {
            await handleStatic(res, STATIC_FILES[pathname]);
            return;
        }
        if (isRead && pathname === '/api/session') {
            sendJson(res, 200, follower.getSession());
            return;
        }
        if (isRead && pathname === '/api/clips') {
            sendJson(res, 200, clipsAfter(follower.getClips(), url.searchParams.get('after')));
            return;
        }
        if (isRead && pathname === '/api/selection') {
            sendJson(res, 200, await readSelection(dataDir));
            return;
        }
        if (req.method === 'PUT' && pathname === '/api/selection') {
            await handleSelectionPut(req, res);
            return;
        }
        if (req.method === 'GET' && pathname === '/api/stream') {
            handleStream(req, res);
            return;
        }
        const audioMatch = isRead ? AUDIO_ROUTE.exec(pathname) : null;
        if (audioMatch) {
            const [, sessionKey, fileName] = audioMatch.map(safeDecode);
            if (sessionKey === null || fileName === null) {
                sendJson(res, 404, { error: 'not found' });
                return;
            }
            await handleAudio(req, res, sessionKey, fileName);
            return;
        }
        sendJson(res, 404, { error: 'not found' });
    };

    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
            const status = error.statusCode ?? 500;
            if (status === 500) {
                console.error(error);
            }
            if (res.headersSent) {
                res.end();
                return;
            }
            sendJson(res, status, { error: status === 500 ? 'internal error' : error.message });
        });
    });

    const close = async () => {
        clearInterval(keepalive);
        follower.stop();
        for (const res of clients) {
            res.end();
        }
        await new Promise((resolve) => server.close(resolve));
    };

    return { server, close };
};

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
    await fs.mkdir(dataDir, { recursive: true });
    const { server } = await createRadioServer({ dataDir });
    server.listen(port, '0.0.0.0', () => console.log(`listening on 0.0.0.0:${port}, data ${dataDir}`));
}
