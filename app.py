from __future__ import annotations

import io
import json

from flask import Flask, jsonify, render_template, request, send_file

from core import Layout, export_pdf, get_plan, load_plan, plan_info, render_page, snap_points

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 400 * 1024 * 1024


@app.errorhandler(Exception)
def handle_error(err):
    code = getattr(err, "code", 500)
    return jsonify(error=str(err)), code if isinstance(code, int) else 500


@app.route("/")
def index():
    return render_template("index.html")


@app.post("/api/open")
def api_open():
    f = request.files.get("file")
    if not f:
        return jsonify(error="Keine Datei erhalten."), 400
    plan = load_plan(f.read(), f.filename or "plan.pdf")
    return jsonify(plan_info(plan))


@app.get("/api/plan/<plan_id>/<int:pno>/image.png")
def api_image(plan_id, pno):
    png, px_per_pt = render_page(get_plan(plan_id), pno)
    resp = send_file(io.BytesIO(png), mimetype="image/png")
    resp.headers["X-Px-Per-Pt"] = str(px_per_pt)
    resp.headers["Cache-Control"] = "max-age=3600"
    return resp


@app.get("/api/plan/<plan_id>/<int:pno>/snap")
def api_snap(plan_id, pno):
    return jsonify(points=snap_points(get_plan(plan_id), pno))


def layout_from_json(d: dict) -> Layout:
    return Layout(
        pno=int(d["pno"]),
        sheet_w_mm=float(d["sheetW"]),
        sheet_h_mm=float(d["sheetH"]),
        mm_per_pt=float(d["mmPerPt"]),
        rotation=int(d["rotation"]) % 360,
        offset_x_mm=float(d["offsetX"]),
        offset_y_mm=float(d["offsetY"]),
        scale_label=str(d.get("scaleLabel") or ""),
        real_mm_per_paper_mm=float(d.get("realPerPaper") or 0),
        margin_mm=float(d.get("margin") or 0),
        frame=bool(d.get("frame")),
    )


def build_export(d: dict) -> bytes:
    return export_pdf(get_plan(d["planId"]), layout_from_json(d))


@app.post("/api/export")
def api_export():
    d = request.get_json(force=True)
    pdf = build_export(d)
    return send_file(io.BytesIO(pdf), mimetype="application/pdf", as_attachment=True,
                     download_name=d.get("filename") or "plan_skaliert.pdf")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5070, debug=True)
