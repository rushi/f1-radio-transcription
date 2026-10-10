"""Starts the transcriber and the web server together, restarts either one if it crashes,
and prints the URL to open on a phone on the same Wi-Fi.
Usage: uv run race [--source multiviewer-ai|multiviewer|openf1] [--replay <sessionKey>]
Sources: multiviewer-ai (default) streams MultiViewer's own AI transcriptions; multiviewer and openf1
download the official radio clips and transcribe them locally with Whisper."""

import argparse
import asyncio
import contextlib
import os
import socket
import subprocess
import sys
import time

import qrcode

from f1radio.cli import ROOT, run
from f1radio.server import DEFAULT_PORT

FIRST_BACKOFF_SECONDS = 1
MAX_BACKOFF_SECONDS = 30
# A process that stayed up this long crashed for a new reason, so its backoff starts over
STABLE_SECONDS = 60
SHUTDOWN_GRACE_SECONDS = 5
SOURCES = ("multiviewer-ai", "multiviewer", "openf1")


def get_lan_address() -> str:
    # en0 is Wi-Fi on Macs, so prefer it over VPN and bridge interfaces
    try:
        address = subprocess.run(["ipconfig", "getifaddr", "en0"], capture_output=True, text=True, timeout=2).stdout.strip()
        if address:
            return address
    except (OSError, subprocess.SubprocessError):
        pass
    # Connecting a UDP socket sends nothing; it only picks the interface the default route uses
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 80))
            return probe.getsockname()[0]
    except OSError:
        return "localhost"


async def prefix_lines(stream: asyncio.StreamReader, label: str, target) -> None:
    async for raw in stream:
        target.write(f"{label} {raw.decode(errors='replace').rstrip(chr(10))}\n")
        target.flush()


class Supervisor:
    def __init__(self):
        self.children: dict[str, asyncio.subprocess.Process] = {}
        self.tasks: set[asyncio.Task] = set()
        self.is_shutting_down = False

    def start(self, name: str, args: list[str]) -> None:
        task = asyncio.create_task(self.keep_running(name, args))
        self.tasks.add(task)

    async def keep_running(self, name: str, args: list[str]) -> None:
        backoff = FIRST_BACKOFF_SECONDS
        while not self.is_shutting_down:
            started_at = time.monotonic()
            # Children print through pipes, so they need unbuffered output and colors forced on
            env = {**os.environ, "FORCE_COLOR": "1", "PYTHONUNBUFFERED": "1"}
            child = await asyncio.create_subprocess_exec(
                sys.executable, "-m", *args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            self.children[name] = child
            await asyncio.gather(
                prefix_lines(child.stdout, f"[{name}]", sys.stdout),
                prefix_lines(child.stderr, f"[{name}]", sys.stderr),
            )
            code = await child.wait()
            del self.children[name]
            if self.is_shutting_down:
                return
            if name == "replay" and code == 0:
                print("[race] replay finished, server still running", flush=True)
                return
            was_stable = time.monotonic() - started_at > STABLE_SECONDS
            delay = FIRST_BACKOFF_SECONDS if was_stable else backoff
            backoff = FIRST_BACKOFF_SECONDS if was_stable else min(backoff * 2, MAX_BACKOFF_SECONDS)
            print(f"[race] {name} exited ({code}), restarting in {delay}s", file=sys.stderr, flush=True)
            await asyncio.sleep(delay)

    async def shutdown(self) -> None:
        self.is_shutting_down = True
        # A child that already exited raises ProcessLookupError, which must not stop the others from being signalled
        for child in self.children.values():
            with contextlib.suppress(ProcessLookupError):
                child.terminate()
        waits = [child.wait() for child in self.children.values()]
        try:
            await asyncio.wait_for(asyncio.gather(*waits), SHUTDOWN_GRACE_SECONDS)
        except TimeoutError:
            for child in self.children.values():
                with contextlib.suppress(ProcessLookupError):
                    child.kill()
        for task in self.tasks:
            task.cancel()


def print_qr(url: str) -> None:
    code = qrcode.QRCode(border=1)
    code.add_data(url)
    code.print_ascii(invert=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the radio feed and web server")
    parser.add_argument("--source", default="multiviewer-ai", choices=SOURCES)
    parser.add_argument("--replay", metavar="SESSION_KEY", help="replay a recorded session instead of a live feed")
    args = parser.parse_args()

    async def race() -> None:
        supervisor = Supervisor()
        if args.replay:
            supervisor.start("replay", ["f1radio.replay", args.replay])
        elif args.source == "multiviewer-ai":
            supervisor.start("radio", ["f1radio.mv_radio"])
        else:
            supervisor.start("radio", ["f1radio.transcribe_radio", "--interval", "10", "--source", args.source])
        supervisor.start("web", ["f1radio.server"])

        url = f"http://{get_lan_address()}:{DEFAULT_PORT}"
        print(f"\n[race] open {url} on your phone (same Wi-Fi)\n", flush=True)
        print_qr(url)
        try:
            await asyncio.Event().wait()
        finally:
            await supervisor.shutdown()

    run(race)


if __name__ == "__main__":
    main()
