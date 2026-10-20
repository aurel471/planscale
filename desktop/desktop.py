"""
desktop.py - Startet die Web-Version von PlanScale in einem eigenen Mac-Fenster (pywebview).
Es gibt nur eine Codebasis: ../web. Hier wird sie lediglich lokal ausgeliefert.
"""
from __future__ import annotations

import functools
import http.server
import os
import socket
import threading

import webview

WEB_DIR = os.environ.get("PLANSCALE_WEB_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
                      ".webmanifest": "application/manifest+json"}

    def log_message(self, *args):
        pass


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


if __name__ == "__main__":
    port = _free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(QuietHandler, directory=WEB_DIR))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    webview.settings["ALLOW_DOWNLOADS"] = True  # PDF-Export landet im Download-Ordner
    webview.create_window("PlanScale", f"http://127.0.0.1:{port}/", width=1560, height=980, min_size=(1100, 720))
    webview.start(private_mode=False, storage_path=os.environ.get("PLANSCALE_DATA_DIR"))
