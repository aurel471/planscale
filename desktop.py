"""
desktop.py - Startet PlanScale in einem eigenen Fenster (statt im Browser)
"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading

import webview

from app import app, build_export, plan_info
from core import load_plan

OPEN_TYPES = ("Pläne (*.pdf;*.png;*.jpg;*.jpeg;*.tif;*.tiff)", "Alle Dateien (*.*)")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Api:
    """Native Dialoge für die Oberfläche (window.pywebview.api.*)."""

    def open_file(self):
        res = webview.windows[0].create_file_dialog(webview.FileDialog.OPEN, file_types=OPEN_TYPES)
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        with open(path, "rb") as f:
            plan = load_plan(f.read(), os.path.basename(path))
        return plan_info(plan)

    def save_pdf(self, layout: dict):
        res = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE, save_filename=layout.get("filename") or "plan_skaliert.pdf",
            file_types=("PDF (*.pdf)",),
        )
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        if not path.lower().endswith(".pdf"):
            path += ".pdf"
        with open(path, "wb") as f:
            f.write(build_export(layout))
        return path

    def reveal(self, path: str):
        subprocess.run(["open", "-R", path], check=False)


if __name__ == "__main__":
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    port = _free_port()
    threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True),
        daemon=True,
    ).start()
    webview.create_window(
        "PlanScale", f"http://127.0.0.1:{port}", js_api=Api(), width=1560, height=980, min_size=(1100, 720)
    )
    data_dir = os.environ.get("PLANSCALE_DATA_DIR")
    webview.start(private_mode=False, storage_path=data_dir)  # private_mode=False: Einstellungen bleiben erhalten
