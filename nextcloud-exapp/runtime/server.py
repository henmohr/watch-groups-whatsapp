#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


APP_ID = os.environ.get("APP_ID", "watchgroups")
APP_PORT = int(os.environ.get("APP_PORT", "8000"))
APP_HOST = os.environ.get("APP_HOST", "0.0.0.0")
APP_DISPLAY_NAME = os.environ.get("APP_DISPLAY_NAME", "Watch Groups WhatsApp")
APP_VERSION = os.environ.get("APP_VERSION", "0.1.0")
APP_SECRET = os.environ.get("APP_SECRET", "")
PERSISTENT_STORAGE = Path(os.environ.get("APP_PERSISTENT_STORAGE", "/tmp/watchgroups"))


class Handler(BaseHTTPRequestHandler):
    server_version = "WatchGroupsExApp/1.0"

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_text(self, status: int, text: str) -> None:
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/heartbeat":
            self._send_text(200, "ok")
            return

        if self.path == "/":
            self._send_json(
                200,
                {
                    "appId": APP_ID,
                    "displayName": APP_DISPLAY_NAME,
                    "version": APP_VERSION,
                    "status": "running",
                    "persistentStorage": str(PERSISTENT_STORAGE),
                },
            )
            return

        self._send_text(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/init":
            PERSISTENT_STORAGE.mkdir(parents=True, exist_ok=True)
            state_file = PERSISTENT_STORAGE / "state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "appId": APP_ID,
                        "displayName": APP_DISPLAY_NAME,
                        "version": APP_VERSION,
                        "appSecretPresent": bool(APP_SECRET),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            self._send_json(200, {"status": "initialized"})
            return

        self._send_text(404, "not found")

    def do_PUT(self) -> None:  # noqa: N802
        if self.path == "/enabled":
            self._send_json(200, {"status": "enabled"})
            return

        self._send_text(404, "not found")


def main() -> None:
    PERSISTENT_STORAGE.mkdir(parents=True, exist_ok=True)
    print(f"Starting {APP_ID} on {APP_HOST}:{APP_PORT}")
    server = ThreadingHTTPServer((APP_HOST, APP_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
