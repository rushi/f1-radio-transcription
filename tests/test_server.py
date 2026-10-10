import asyncio
import json

import aiohttp
import pytest
from helpers import line

from f1radio.json_file import append_line, write_json_atomic
from f1radio.selection import read_selection
from f1radio.server import create_radio_server


def make_record(clip_id, driver_number=1):
    return {"utc": "2026-10-11T12:00:00Z", "driverNumber": driver_number, "driver": "NOR", "audioFile": f"s1/audio/{clip_id}.mp3", "text": f"text {clip_id}"}


async def raw_get(port: int, raw_path: str) -> int:
    """Sends the path exactly as written; the aiohttp client would normalize dot segments and escapes."""
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"GET {raw_path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode())
    await writer.drain()
    status_line = await reader.readline()
    writer.close()
    await writer.wait_closed()
    return int(status_line.split()[1])


@pytest.fixture
async def radio(tmp_path):
    data_dir = tmp_path / "data"
    web_dir = tmp_path / "web"
    web_dir.mkdir()
    (web_dir / "index.html").write_text("<!doctype html><title>t</title>")
    (web_dir / "format.mjs").write_text("export const x = 1;")
    write_json_atomic(data_dir / "current.json", {"sessionKey": "s1", "updatedAt": "a", "drivers": [{"number": 1, "tla": "NOR"}, {"number": 81, "tla": "PIA"}]})
    (data_dir / "s1" / "audio").mkdir(parents=True)
    (data_dir / "s1" / "transcripts.jsonl").write_text(line(make_record("one")))
    (data_dir / "s1" / "audio" / "one.mp3").write_bytes(b"0123456789")
    server = await create_radio_server(data_dir=data_dir, web_dir=web_dir, host="127.0.0.1", port=0, interval=0.02, keepalive=0.05)
    async with aiohttp.ClientSession(f"http://127.0.0.1:{server.port}") as http:
        yield server, http, data_dir
    await server.close()


async def collect_events(http: aiohttp.ClientSession, path: str, until, timeout: float = 2.0) -> list[dict]:
    """Collects SSE events until `until` returns true."""
    events = []

    async def read() -> None:
        async with http.get(path) as response:
            buffer = ""
            async for chunk in response.content.iter_any():
                buffer += chunk.decode()
                *blocks, buffer = buffer.split("\n\n")
                for block in blocks:
                    fields = dict(row.split(": ", 1) for row in block.split("\n") if ": " in row and not row.startswith(":"))
                    data = fields.get("data")
                    events.append({"event": fields.get("event"), "data": json.loads(data) if data else None, "raw": block})
                if until(events):
                    return

    await asyncio.wait_for(read(), timeout)
    return events


async def get_json(http, path):
    async with http.get(path) as response:
        return await response.json()


async def get_status(http, path, **kwargs):
    async with http.get(path, **kwargs) as response:
        return response.status


async def test_serves_the_page_format_module_session_and_clips(radio):
    _, http, _ = radio
    async with http.get("/") as page:
        assert page.status == 200
        assert "text/html" in page.headers["Content-Type"]
    async with http.get("/format.mjs") as format_module:
        assert "text/javascript" in format_module.headers["Content-Type"]
    assert (await get_json(http, "/api/session"))["sessionKey"] == "s1"
    clips = await get_json(http, "/api/clips")
    assert [clip["id"] for clip in clips] == ["one"]
    first_seq = clips[0]["seq"]
    assert await get_json(http, f"/api/clips?after={first_seq}") == []
    assert [clip["id"] for clip in await get_json(http, f"/api/clips?after={first_seq - 1}")] == ["one"]
    assert await get_status(http, "/nope") == 404


async def test_streams_appended_clips_over_sse(radio):
    _, http, data_dir = radio
    events_task = asyncio.create_task(collect_events(http, "/api/stream", lambda events: any(event["event"] == "clip" for event in events)))
    await asyncio.sleep(0.1)
    append_line(data_dir / "s1" / "transcripts.jsonl", line(make_record("two")))
    events = await events_task
    clip = next(event for event in events if event["event"] == "clip")
    assert clip["data"]["id"] == "two"
    first_seq = (await get_json(http, "/api/clips"))[0]["seq"]
    assert clip["data"]["seq"] == first_seq + 1


async def test_sends_keep_alive_comments(radio):
    _, http, _ = radio
    events = await collect_events(http, "/api/stream", lambda collected: any(": keep-alive" in event["raw"] for event in collected))
    assert any(": keep-alive" in event["raw"] for event in events)


async def test_put_api_selection_validates_writes_the_file_and_broadcasts(radio):
    _, http, data_dir = radio
    events_task = asyncio.create_task(collect_events(http, "/api/stream", lambda events: any(event["event"] == "selection" for event in events)))
    await asyncio.sleep(0.1)
    async with http.put("/api/selection", data='{"drivers":[44]}') as bad:
        assert bad.status == 400
    async with http.put("/api/selection", data='{"drivers":[81,1]}') as good:
        assert good.status == 200
        assert (await good.json())["drivers"] == [1, 81]
    assert read_selection(data_dir)["drivers"] == [1, 81]
    events = await events_task
    assert next(event for event in events if event["event"] == "selection")["data"]["drivers"] == [1, 81]
    assert (await get_json(http, "/api/selection"))["drivers"] == [1, 81]


async def test_put_api_selection_rejects_a_body_over_the_limit(radio):
    _, http, _ = radio
    async with http.put("/api/selection", data="x" * 20_000) as response:
        assert response.status == 413


async def test_serves_audio_with_range_and_head_and_blocks_traversal(radio):
    _, http, _ = radio
    async with http.get("/audio/s1/one.mp3") as full:
        assert full.status == 200
        assert full.headers["Accept-Ranges"] == "bytes"
        assert await full.text() == "0123456789"

    async with http.get("/audio/s1/one.mp3", headers={"Range": "bytes=0-1"}) as partial:
        assert partial.status == 206
        assert partial.headers["Content-Range"] == "bytes 0-1/10"
        assert await partial.text() == "01"

    async with http.head("/audio/s1/one.mp3") as head:
        assert head.status == 200
        assert head.headers["Content-Length"] == "10"

    assert await get_status(http, "/audio/s1/one.mp3", headers={"Range": "bytes=50-"}) == 416
    assert await get_status(http, "/audio/s1/missing.mp3") == 404
    assert await get_status(http, "/audio/%2e%2e/current.json") == 404


async def test_audio_route_rejects_traversal_sent_as_raw_encoded_paths(radio):
    server, _, _ = radio
    assert await raw_get(server.port, "/audio/s1/..%2Fcurrent.json") == 404
    assert await raw_get(server.port, "/audio/..%2Fs1/one.mp3") == 404
    assert await raw_get(server.port, "/audio/%2e%2e/current.json") == 404
    assert await raw_get(server.port, "/audio/s1/one.mp3") == 200


async def test_audio_route_returns_404_for_a_directory_named_like_an_mp3_and_keeps_serving(radio):
    _, http, data_dir = radio
    (data_dir / "s1" / "audio" / "dir.mp3").mkdir()
    assert await get_status(http, "/audio/s1/dir.mp3") == 404
    assert await get_status(http, "/audio/s1/one.mp3") == 200


async def test_malformed_percent_escapes_in_the_audio_route_return_404(radio):
    server, http, _ = radio
    assert await raw_get(server.port, "/audio/%E0%A4%A/x.mp3") == 404
    assert await get_status(http, "/api/session") == 200


async def test_malformed_request_targets_return_400(radio):
    server, _, _ = radio
    assert await raw_get(server.port, "//") == 400
