"""MultiViewer's AI radio transcriptions come over a Phoenix channel on its own backend. This is the
same socket the MultiViewer app joins; it is undocumented and may change with any app release."""

import asyncio
import json
from collections.abc import Callable
from urllib.parse import quote

import aiohttp
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from f1radio.values import parse_time, to_int

MV_SOCKET_URL = "wss://api.multiviewer.dev/socket/websocket"
MV_API_URL = "https://api.multiviewer.dev"

HEARTBEAT_SECONDS = 30
FIRST_RETRY_SECONDS = 1
MAX_RETRY_SECONDS = 30


def get_record_id(message) -> str | None:
    """The numeric id is on every event, including deletes, so it is the stable key."""
    if not isinstance(message, dict):
        return None
    record_id = message.get("id")
    if record_id is None:
        record_id = message.get("external_id")
    return None if record_id is None else f"mv-{record_id}"


def to_record(message, *, session_key: str, drivers: dict[int, dict], lap) -> dict | None:
    record_id = get_record_id(message)
    driver_number = to_int(message.get("driver_number")) if record_id else None
    if driver_number is None:
        return None
    driver = drivers.get(driver_number, {})
    transcription = message.get("transcription")
    return {
        "id": record_id,
        "utc": message.get("player_ts"),
        "driverNumber": driver_number,
        "driver": driver.get("tla"),
        "driverName": driver.get("name"),
        "team": driver.get("team"),
        "sessionKey": session_key,
        "durationMs": message.get("duration_ms"),
        "lap": lap,
        "text": ("" if transcription is None else str(transcription)).strip(),
        "source": "multiviewer-ai",
    }


def to_deleted_record(message) -> dict | None:
    record_id = get_record_id(message)
    return {"id": record_id, "deleted": True} if record_id else None


async def fetch_history(http: aiohttp.ClientSession, *, meeting_key, session_key: str) -> list[dict]:
    """Same endpoint MultiViewer's own panel loads history from."""
    url = f"{MV_API_URL}/api/v1/meetings/{meeting_key}/sessions/{session_key}/driver_radio_transcriptions"
    async with http.get(url) as response:
        if not response.ok:
            raise RuntimeError(f"MultiViewer history HTTP {response.status}")
        messages = await response.json()
    return sorted(messages, key=lambda message: parse_time(message.get("player_ts")) or 0)


def channel_topic(session_key: str) -> str:
    return f"driver_radio_transcriptions:session:{session_key}"


def connect_channel(
    *,
    session_key: str,
    app_version: str,
    on_event: Callable[[str, dict], None],
    on_status: Callable[[str], None] = lambda status: None,
) -> Callable[[], None]:
    """Minimal Phoenix v2 client: join one topic, heartbeat, and rejoin with backoff when the socket drops.
    Returns a stop function."""
    topic = channel_topic(session_key)
    url = f"{MV_SOCKET_URL}?appVersion={quote(app_version, safe='')}&vsn=2.0.0"
    ref = 0

    async def send(socket, join_ref, send_topic: str, event: str, payload: dict) -> None:
        nonlocal ref
        ref += 1
        await socket.send(json.dumps([join_ref, str(ref), send_topic, event, payload]))

    async def heartbeat(socket) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await send(socket, None, "phoenix", "heartbeat", {})

    # Returns False when the server errors or closes the channel, so the caller reconnects
    def handle_message(raw) -> bool:
        try:
            _, _, message_topic, name, payload = json.loads(raw)
        except ValueError:
            return True
        if message_topic != topic:
            return True
        if name == "phx_reply":
            is_ok = (payload or {}).get("status") == "ok"
            on_status("joined" if is_ok else f"join failed: {json.dumps(payload)}")
            return True
        if name in ("phx_error", "phx_close"):
            return False
        on_event(name, payload)
        return True

    async def run() -> None:
        retry_seconds = FIRST_RETRY_SECONDS
        while True:
            try:
                async with connect(url) as socket:
                    retry_seconds = FIRST_RETRY_SECONDS
                    await send(socket, "1", topic, "phx_join", {})
                    heartbeat_task = asyncio.create_task(heartbeat(socket))
                    try:
                        async for raw in socket:
                            if not handle_message(raw):
                                break
                    finally:
                        heartbeat_task.cancel()
            except (OSError, TimeoutError, WebSocketException):
                pass
            on_status(f"disconnected, retrying in {retry_seconds}s")
            await asyncio.sleep(retry_seconds)
            retry_seconds = min(retry_seconds * 2, MAX_RETRY_SECONDS)

    task = asyncio.get_running_loop().create_task(run())
    return task.cancel
