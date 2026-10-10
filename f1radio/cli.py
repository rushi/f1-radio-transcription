import asyncio
import contextlib
import signal
from collections.abc import Callable, Coroutine
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def run(main: Callable[[], Coroutine]) -> None:
    """Runs an async entry point until it returns or SIGINT/SIGTERM arrives, then exits cleanly."""

    async def run_until_signal() -> None:
        task = asyncio.current_task()
        loop = asyncio.get_running_loop()
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signal_number, task.cancel)
        await main()

    with contextlib.suppress(asyncio.CancelledError):
        asyncio.run(run_until_signal())
