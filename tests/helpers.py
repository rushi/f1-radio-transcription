import asyncio
import inspect
import json
import time


def line(value) -> str:
    return f"{json.dumps(value, separators=(',', ':'))}\n"


async def wait_for(check, timeout: float = 2.0):
    """Polls until check() returns a truthy value. File watchers fire asynchronously, so tests wait instead of sleeping a fixed time."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if inspect.isawaitable(value):
            value = await value
        if value:
            return value
        await asyncio.sleep(0.02)
    raise TimeoutError(f"wait_for timed out after {timeout}s")
