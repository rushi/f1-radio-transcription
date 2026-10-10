"""Serves the live radio page and pushes new transcripts from data/ over SSE.
Usage: uv run server   (PORT and DATA_DIR env vars override 10303 and ./data)"""

import argparse
import asyncio
import os
import re
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, unquote

from aiohttp import web

from f1radio.cli import DATA_DIR, ROOT, run
from f1radio.clips import clips_after
from f1radio.http_utils import UNSATISFIABLE, parse_range, resolve_audio_path
from f1radio.selection import parse_selection_body, read_selection, write_selection
from f1radio.session_follower import SessionFollower, create_session_follower
from f1radio.values import to_json

DEFAULT_PORT = 10303
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/format.mjs": ("format.mjs", "text/javascript; charset=utf-8"),
}
AUDIO_ROUTE = re.compile(r"/audio/([^/]+)/([^/]+)")
AUDIO_CHUNK_BYTES = 64 * 1024
BODY_LIMIT_BYTES = 10_000
DOT_SEGMENTS = {".", "%2e"}
DOUBLE_DOT_SEGMENTS = {"..", ".%2e", "%2e.", "%2e%2e"}


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def send_json(status: int, body) -> web.Response:
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    return web.Response(status=status, body=to_json(body).encode(), headers=headers)


def normalize_path(raw_path: str) -> str | None:
    """Drops dot segments, encoded ones included, the way a browser URL parser does. None for a target with an
    empty authority like "//"."""
    if raw_path.startswith("//") or not raw_path.startswith("/"):
        return None
    segments = raw_path.split("/")[1:]
    output = []
    for index, segment in enumerate(segments):
        lowered = segment.lower()
        is_last = index == len(segments) - 1
        if lowered in DOUBLE_DOT_SEGMENTS:
            if output:
                output.pop()
        elif lowered not in DOT_SEGMENTS:
            output.append(segment)
            continue
        if is_last:
            output.append("")
    return "/" + "/".join(output)


def safe_decode(part: str) -> str | None:
    """Malformed percent-escapes are a client error, not a server fault."""
    try:
        return unquote(part, errors="strict")
    except UnicodeDecodeError:
        return None


async def read_body(request: web.BaseRequest, limit_bytes: int = BODY_LIMIT_BYTES) -> str:
    chunks = []
    length = 0
    async for chunk in request.content.iter_any():
        length += len(chunk)
        if length > limit_bytes:
            raise HttpError(413, "body too large")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", errors="replace")


@dataclass
class RadioServer:
    runner: web.ServerRunner
    site: web.TCPSite
    follower: SessionFollower
    clients: set[asyncio.Queue]
    keepalive_task: asyncio.Task

    @property
    def port(self) -> int:
        return self.runner.addresses[0][1]

    async def close(self) -> None:
        self.keepalive_task.cancel()
        self.follower.stop()
        for queue in self.clients:
            queue.put_nowait(None)
        await self.runner.cleanup()


async def create_radio_server(
    *,
    data_dir,
    web_dir=ROOT / "web",
    host: str = "0.0.0.0",
    port: int = DEFAULT_PORT,
    interval: float = 1.0,
    keepalive: float = 15.0,
) -> RadioServer:
    # Each SSE client drains its own queue; None tells it to finish
    clients: set[asyncio.Queue] = set()

    def broadcast(event: str, data) -> None:
        payload = f"event: {event}\ndata: {to_json(data)}\n\n"
        for queue in clients:
            queue.put_nowait(payload)

    follower = await create_session_follower(
        data_dir=data_dir,
        interval=interval,
        on_session=lambda session: broadcast("session", session),
        on_clip=lambda clip: broadcast("clip", clip),
        on_reset=lambda: broadcast("reset", {}),
    )

    # Idle Wi-Fi and phone browsers drop silent connections, so the stream always has traffic
    async def send_keepalives() -> None:
        while True:
            await asyncio.sleep(keepalive)
            for queue in clients:
                queue.put_nowait(": keep-alive\n\n")

    def handle_static(file: str, content_type: str) -> web.Response:
        body = (Path(web_dir) / file).read_bytes()
        return web.Response(body=body, headers={"Content-Type": content_type, "Cache-Control": "no-cache"})

    async def handle_stream(request: web.BaseRequest) -> web.StreamResponse:
        headers = {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive"}
        response = web.StreamResponse(headers=headers)
        await response.prepare(request)
        await response.write(b"retry: 3000\n\n")
        queue: asyncio.Queue = asyncio.Queue()
        clients.add(queue)
        try:
            while (payload := await queue.get()) is not None:
                await response.write(payload.encode())
        except ConnectionResetError:
            pass
        finally:
            clients.discard(queue)
        return response

    async def handle_selection_put(request: web.BaseRequest) -> web.Response:
        drivers = (follower.get_session() or {}).get("drivers")
        has_drivers = isinstance(drivers, list) and len(drivers) > 0
        known_numbers = {driver.get("number") for driver in drivers} if has_drivers else None
        result = parse_selection_body(await read_body(request), known_numbers)
        if "error" in result:
            return send_json(400, {"error": result["error"]})
        selection = write_selection(data_dir, result["drivers"])
        broadcast("selection", selection)
        return send_json(200, selection)

    async def handle_audio(request: web.BaseRequest, session_key: str, file_name: str) -> web.StreamResponse:
        file_path = resolve_audio_path(data_dir, session_key, file_name)
        if not file_path or not os.path.isfile(file_path):
            return send_json(404, {"error": "not found"})
        size = os.path.getsize(file_path)
        headers = {"Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"}
        byte_range = parse_range(request.headers.get("Range"), size)
        if byte_range == UNSATISFIABLE:
            return web.Response(status=416, headers={**headers, "Content-Range": f"bytes */{size}"})
        is_partial = byte_range is not None
        start, end = byte_range if is_partial else (0, size - 1)
        if is_partial:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        response = web.StreamResponse(status=206 if is_partial else 200, headers=headers)
        response.content_length = end - start + 1
        await response.prepare(request)
        if request.method == "HEAD":
            await response.write_eof()
            return response
        try:
            with open(file_path, "rb") as handle:
                handle.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = handle.read(min(AUDIO_CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    await response.write(chunk)
            await response.write_eof()
        except ConnectionResetError:
            # The player aborted a range request
            pass
        return response

    async def route(request: web.BaseRequest) -> web.StreamResponse:
        raw_path, _, query = request.raw_path.partition("?")
        pathname = normalize_path(raw_path)
        if pathname is None:
            return send_json(400, {"error": "bad request"})
        method = request.method
        is_read = method in ("GET", "HEAD")

        if is_read and pathname in STATIC_FILES:
            return handle_static(*STATIC_FILES[pathname])
        if is_read and pathname == "/api/session":
            return send_json(200, follower.get_session())
        if is_read and pathname == "/api/clips":
            after = parse_qs(query, keep_blank_values=True).get("after", [None])[0]
            return send_json(200, clips_after(follower.get_clips(), after))
        if is_read and pathname == "/api/selection":
            return send_json(200, read_selection(data_dir))
        if method == "PUT" and pathname == "/api/selection":
            return await handle_selection_put(request)
        if method == "GET" and pathname == "/api/stream":
            return await handle_stream(request)
        audio_match = AUDIO_ROUTE.fullmatch(pathname) if is_read else None
        if audio_match:
            session_key, file_name = (safe_decode(part) for part in audio_match.groups())
            if session_key is None or file_name is None:
                return send_json(404, {"error": "not found"})
            return await handle_audio(request, session_key, file_name)
        return send_json(404, {"error": "not found"})

    async def handle_request(request: web.BaseRequest) -> web.StreamResponse:
        try:
            return await route(request)
        except HttpError as error:
            return send_json(error.status, {"error": str(error)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return send_json(500, {"error": "internal error"})

    # Handlers are cancelled when the client disconnects, which is how an SSE client leaves
    runner = web.ServerRunner(web.Server(handle_request, handler_cancellation=True))
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    keepalive_task = asyncio.get_running_loop().create_task(send_keepalives())
    return RadioServer(runner=runner, site=site, follower=follower, clients=clients, keepalive_task=keepalive_task)


async def serve() -> None:
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    data_dir = Path(os.environ.get("DATA_DIR") or DATA_DIR).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    server = await create_radio_server(data_dir=data_dir, port=port)
    print(f"listening on 0.0.0.0:{port}, data {data_dir}", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await server.close()


def main() -> None:
    argparse.ArgumentParser(description="Serve the live radio page. PORT and DATA_DIR env vars override 10303 and ./data").parse_args()
    run(serve)


if __name__ == "__main__":
    main()
