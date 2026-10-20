import { openFile, renderPage, snapPoints, exportPdf, mul, apply } from "./engine.js";

const VERSION = "1.0.0";
const MM_PER_PT = 25.4 / 72;
const FORMATS = {
  A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148],
  B1: [707, 1000], B2: [500, 707], B3: [353, 500], B4: [250, 353],
};
const SCALE_CHIPS = [1, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
const NORM_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 25000];
const UNIT_MM = { mm: 1, cm: 10, m: 1000 };
const SNAP_PX = 12;

const $ = (id) => document.getElementById(id);
const num = (s) => { const v = parseFloat(String(s).replace(/\s/g, "").replace(",", ".")); return isFinite(v) ? v : NaN; };
const fmt = (v, d = 1) => isFinite(v) ? v.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: d }) : "–";
const fmtScale = (m) => fmt(m, 2);
function fmtReal(mm) {
  if (Math.abs(mm) >= 1000) return fmt(mm / 1000, 3) + " m";
  if (Math.abs(mm) >= 10) return fmt(mm / 10, 2) + " cm";
  return fmt(mm, 2) + " mm";
}

// ------------------------------------------------------------------ Zustand
const S = {
  plan: null, pno: 0, img: null, W: 0, H: 0,          // Quellseite in pt
  snapPts: null, grids: null,
  calMode: "none", refA: null, refB: null, refLen: NaN, refUnit: "m", srcScale: 100,
  scaleM: 50, percent: 100, rotation: 0, ox: 0, oy: 0,
  format: "A3", orient: "quer", customW: 50, customH: 70, margin: 10,
  optBar: true, optLabel: true, optFrame: false, snapOn: true, roundScale: true,
  tool: "move", measures: [], draft: null,
  view: { z: 1, x: 0, y: 0 },
  hover: null, // {sx, sy, src, snapped}
  guides: [],   // Smart-Align-Hilfslinien beim Ziehen
};

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("planscale:prefs") || "{}");
    for (const k of ["format", "orient", "customW", "customH", "margin", "optBar", "optLabel", "optFrame", "snapOn", "roundScale", "refUnit"])
      if (p[k] !== undefined) S[k] = p[k];
  } catch (e) {}
}
function savePrefs() {
  try {
    const p = {};
    for (const k of ["format", "orient", "customW", "customH", "margin", "optBar", "optLabel", "optFrame", "snapOn", "roundScale", "refUnit"]) p[k] = S[k];
    localStorage.setItem("planscale:prefs", JSON.stringify(p));
  } catch (e) {}
}
const PLAN_KEYS = ["calMode", "refA", "refB", "refLen", "refUnit", "srcScale", "scaleM", "percent", "rotation", "ox", "oy", "measures"];
function planKey() { return S.plan ? `planscale:plan:${S.plan.id}:${S.pno}` : null; }
let saveTimer = null;
function savePlanState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const k = planKey(); if (!k) return;
    try {
      const o = {}; for (const key of PLAN_KEYS) o[key] = S[key];
      o.refLen = isFinite(S.refLen) ? S.refLen : null;
      localStorage.setItem(k, JSON.stringify(o));
    } catch (e) {}
    savePrefs();
  }, 250);
}
function restorePlanState() {
  try {
    const o = JSON.parse(localStorage.getItem(planKey()) || "null");
    if (!o) return false;
    for (const key of PLAN_KEYS) if (o[key] !== undefined && o[key] !== null) S[key] = o[key];
    if (o.refLen === null) S.refLen = NaN;
    return true;
  } catch (e) { return false; }
}

// ------------------------------------------------------------------ Geometrie
function sheetDims() {
  let w, h;
  if (S.format === "frei") { w = S.customW * 10; h = S.customH * 10; }
  else { [w, h] = FORMATS[S.format]; if (S.orient === "quer") [w, h] = [h, w]; }
  return [w, h];
}
function realPerPt() {   // reale mm je Quell-pt, null = nicht kalibriert
  if (S.calMode === "ref" && S.refA && S.refB && S.refLen > 0) {
    const d = Math.hypot(S.refB[0] - S.refA[0], S.refB[1] - S.refA[1]);
    return d > 0 ? S.refLen * UNIT_MM[S.refUnit] / d : null;
  }
  if (S.calMode === "known" && S.srcScale > 0) return S.srcScale * MM_PER_PT;
  return null;
}
function mmPerPt() {
  const rp = realPerPt();
  return rp ? rp / S.scaleM : S.percent / 100 * MM_PER_PT;
}
function boxDims(k = mmPerPt()) {
  const w = S.W * k, h = S.H * k;
  return S.rotation % 180 === 0 ? [w, h] : [h, w];
}
// Quelle (pt) -> Blatt (mm) als Affinmatrix [a b c d e f]
function planMatrix() {
  const k = mmPerPt(), w = S.W * k, h = S.H * k, ox = S.ox, oy = S.oy;
  switch (S.rotation) {
    case 90: return [0, k, -k, 0, ox + h, oy];
    case 180: return [-k, 0, 0, -k, ox + w, oy + h];
    case 270: return [0, -k, k, 0, ox, oy + w];
    default: return [k, 0, 0, k, ox, oy];
  }
}
function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const viewMatrix = () => [S.view.z, 0, 0, S.view.z, S.view.x, S.view.y];
const srcToPaper = (p) => apply(planMatrix(), p);
const paperToSrc = (p) => apply(inv(planMatrix()), p);
const paperToScreen = (p) => apply(viewMatrix(), p);
const screenToPaper = (p) => apply(inv(viewMatrix()), p);
const srcToScreen = (p) => paperToScreen(srcToPaper(p));
const screenToSrc = (p) => paperToSrc(screenToPaper(p));

// Änderung am Maßstab/Drehung: Planmitte bleibt an derselben Stelle auf dem Blatt
function keepCenter(fn) {
  if (!S.plan) { fn(); return; }
  const c = srcToPaper([S.W / 2, S.H / 2]);
  fn();
  const [bw, bh] = boxDims();
  S.ox = c[0] - bw / 2; S.oy = c[1] - bh / 2;
}
function centerPlan() {
  const [sw, sh] = sheetDims(), [bw, bh] = boxDims();
  S.ox = (sw - bw) / 2; S.oy = (sh - bh) / 2;
}
function fitToSheet() {
  if (!S.plan) return;
  const [sw, sh] = sheetDims(), m = Math.max(0, S.margin);
  const [bw, bh] = boxDims(1);
  const k = Math.min((sw - 2 * m) / bw, (sh - 2 * m) / bh);
  if (!(k > 0)) return;
  const rp = realPerPt();
  if (rp) {
    const exact = rp / k;
    S.scaleM = S.roundScale ? (NORM_SCALES.find((s) => s >= exact * 0.9999) || Math.ceil(exact))
                            : Math.ceil(exact * 100) / 100;
  } else {
    S.percent = Math.floor(k / MM_PER_PT * 1000) / 10;
  }
  centerPlan();
}
function nearestNorm(m) {
  return NORM_SCALES.reduce((best, s) => Math.abs(Math.log(s / m)) < Math.abs(Math.log(best / m)) ? s : best, NORM_SCALES[0]);
}

// ------------------------------------------------------------------ Einrasten
function buildGrids(pts) {
  const diag = Math.hypot(S.W, S.H);
  return [diag / 1500, diag / 150, diag / 15].map((c) => {
    const map = new Map();
    for (let i = 0; i < pts.length; i += 2) {
      const key = Math.floor(pts[i] / c) * 100003 + Math.floor(pts[i + 1] / c);
      let arr = map.get(key); if (!arr) map.set(key, arr = []); arr.push(i);
    }
    return { c, map };
  });
}
function findSnap(src, radiusSrc) {
  if (!S.grids) return null;
  const g = S.grids.find((g) => radiusSrc / g.c <= 3);
  if (!g) return null;
  const pts = S.snapPts, gx = Math.floor(src[0] / g.c), gy = Math.floor(src[1] / g.c), n = Math.ceil(radiusSrc / g.c);
  let best = null, bd = radiusSrc * radiusSrc;
  for (let x = gx - n; x <= gx + n; x++) for (let y = gy - n; y <= gy + n; y++) {
    const arr = g.map.get(x * 100003 + y); if (!arr) continue;
    for (const i of arr) {
      const dx = pts[i] - src[0], dy = pts[i + 1] - src[1], d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = [pts[i], pts[i + 1]]; }
    }
  }
  return best;
}
function snapPointsNear(src, radiusSrc, max) {
  const out = [];
  if (!S.grids) return out;
  const g = S.grids.find((g) => radiusSrc / g.c <= 3) || S.grids[S.grids.length - 1];
  const pts = S.snapPts, gx = Math.floor(src[0] / g.c), gy = Math.floor(src[1] / g.c), n = Math.min(4, Math.ceil(radiusSrc / g.c)), r2 = radiusSrc * radiusSrc;
  for (let x = gx - n; x <= gx + n; x++) for (let y = gy - n; y <= gy + n; y++) {
    const arr = g.map.get(x * 100003 + y); if (!arr) continue;
    for (const i of arr) {
      const dx = pts[i] - src[0], dy = pts[i + 1] - src[1];
      if (dx * dx + dy * dy <= r2) { out.push([pts[i], pts[i + 1]]); if (out.length >= max) return out; }
    }
  }
  return out;
}

// Smart Align: Planposition an Blattkanten, Rand und Mittellinien ausrichten
const ALIGN_PX = 8;
function alignAxis(pos, size, targets, thr) {
  let best = null;
  for (const off of [0, size / 2, size]) for (const t of targets) {
    const d = t - (pos + off);
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
  }
  return best ? [pos + best.d, best.t] : [pos, null];
}
function smartAlign(ox, oy) {
  const [sw, sh] = sheetDims(), [bw, bh] = boxDims(), m = S.margin, thr = ALIGN_PX / S.view.z;
  const [ax, gx] = alignAxis(ox, bw, [0, m, sw / 2, sw - m, sw], thr);
  const [ay, gy] = alignAxis(oy, bh, [0, m, sh / 2, sh - m, sh], thr);
  S.guides = [];
  if (gx !== null) S.guides.push({ axis: "x", v: gx });
  if (gy !== null) S.guides.push({ axis: "y", v: gy });
  return [ax, ay];
}

// Bildschirmpunkt -> Quellpunkt, mit Einrasten und ⇧-Ausrichtung zum ersten Punkt
function pickPoint(sx, sy, ev) {
  let src = screenToSrc([sx, sy]), snapped = false;
  if (S.snapOn && !ev.altKey) {
    const r = SNAP_PX / (S.view.z * mmPerPt());
    const s = findSnap(src, r);
    if (s) { src = s; snapped = true; }
  }
  if (ev.shiftKey && S.draft) {
    const a = srcToPaper(S.draft), p = srcToPaper(src);
    if (Math.abs(p[0] - a[0]) > Math.abs(p[1] - a[1])) p[1] = a[1]; else p[0] = a[0];
    src = paperToSrc(p);
  }
  return { src, snapped };
}

// ------------------------------------------------------------------ Zeichnen
const cv = $("cv"), ctx = cv.getContext("2d"), stage = $("stage");
let dpr = 1, needsDraw = false;
function requestDraw() { if (!needsDraw) { needsDraw = true; requestAnimationFrame(draw); } }
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  requestDraw();
}
function fitView() {
  const r = stage.getBoundingClientRect(), [sw, sh] = sheetDims();
  let x0 = 0, y0 = 0, x1 = sw, y1 = sh;
  if (S.plan) {
    const [bw, bh] = boxDims();
    x0 = Math.min(x0, S.ox); y0 = Math.min(y0, S.oy); x1 = Math.max(x1, S.ox + bw); y1 = Math.max(y1, S.oy + bh);
  }
  const pad = 40, z = Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0));
  S.view.z = z;
  S.view.x = (r.width - (x1 - x0) * z) / 2 - x0 * z;
  S.view.y = (r.height - (y1 - y0) * z) / 2 - y0 * z;
  requestDraw();
}

// Blatt + Plan mit gegebener Blatt->Gerät-Matrix
function drawScene(V) {
  const [sw, sh] = sheetDims();
  ctx.setTransform(...V);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(4 / V[0] * dpr, 4 / V[0] * dpr, sw, sh);         // Schatten
  if (S.plan) {
    const [bw, bh] = boxDims();
    ctx.fillStyle = "#8d8b87";                                    // Planfläche außerhalb des Blatts
    ctx.fillRect(S.ox, S.oy, bw, bh);
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sw, sh);
  if (!S.plan || !S.img) return;
  const VP = mul(V, planMatrix());
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.setTransform(...VP); ctx.drawImage(S.img, 0, 0, S.W, S.H);
  ctx.restore();
  ctx.save();
  ctx.setTransform(...V); ctx.beginPath(); ctx.rect(0, 0, sw, sh); ctx.clip();
  ctx.setTransform(...VP); ctx.drawImage(S.img, 0, 0, S.W, S.H);
  ctx.restore();
}

function drawLine(a, b, color, label, sub) {
  const A = srcToScreen(a), B = srcToScreen(b);
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke();
  // Endmarken quer zur Linie
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, nx = -(B[1] - A[1]) / len * 7, ny = (B[0] - A[0]) / len * 7;
  ctx.beginPath();
  for (const P of [A, B]) { ctx.moveTo(P[0] - nx, P[1] - ny); ctx.lineTo(P[0] + nx, P[1] + ny); }
  ctx.stroke();
  if (label) {
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    ctx.font = "600 12px " + getComputedStyle(document.body).fontFamily;
    const w = Math.max(ctx.measureText(label).width, sub ? ctx.measureText(sub).width * 0.85 : 0) + 12;
    const h = sub ? 34 : 20;
    ctx.fillStyle = color; ctx.fillRect(mx - w / 2, my - h - 8, w, h);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, mx, my - h - 8 + 10);
    if (sub) { ctx.font = "10.5px " + getComputedStyle(document.body).fontFamily; ctx.fillText(sub, mx, my - 8 - 9); }
  }
}

function measureLabel(a, b) {
  const dpt = Math.hypot(b[0] - a[0], b[1] - a[1]), rp = realPerPt(), paper = dpt * mmPerPt();
  return rp ? [fmtReal(dpt * rp), `Blatt ${fmt(paper, 1)} mm`] : [`${fmt(paper, 1)} mm`, "auf dem Blatt"];
}

function draw() {
  needsDraw = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const V = viewMatrix().map((v) => v * dpr);
  drawScene(V);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [sw, sh] = sheetDims();
  // Rand
  if (S.margin > 0) {
    const a = paperToScreen([S.margin, S.margin]), b = paperToScreen([sw - S.margin, sh - S.margin]);
    ctx.strokeStyle = "rgba(200,98,74,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1]);
  }
  ctx.setLineDash([]);
  if (S.plan) {
    const [bw, bh] = boxDims(), a = paperToScreen([S.ox, S.oy]), b = paperToScreen([S.ox + bw, S.oy + bh]);
    ctx.strokeStyle = fitsInMargin() ? "rgba(90,90,90,0.9)" : "rgba(200,98,74,0.9)";
    ctx.setLineDash([2, 3]); ctx.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1]); ctx.setLineDash([]);

    for (const m of S.measures) drawLine(m.a, m.b, "#4a8fc8", ...measureLabel(m.a, m.b));
    if (S.calMode === "ref" && S.refA && S.refB) {
      const rp = realPerPt();
      const lab = rp ? `Referenz ${fmtReal(S.refLen * UNIT_MM[S.refUnit])}` : "Referenz";
      const sub = `Blatt ${fmt(Math.hypot(S.refB[0] - S.refA[0], S.refB[1] - S.refA[1]) * mmPerPt(), 1)} mm`;
      drawLine(S.refA, S.refB, "#c8624a", lab, sub);
    }
    if (S.draft && S.hover) {
      const col = S.tool === "ref" ? "#c8624a" : "#4a8fc8";
      drawLine(S.draft, S.hover.src, col, ...(S.tool === "measure" ? measureLabel(S.draft, S.hover.src) : [null]));
    }
    drawGuides();
    const pointTool = S.tool === "ref" || S.tool === "measure";
    if (S.hover && pointTool && S.hover.snapped) {
      const P = srcToScreen(S.hover.src);
      ctx.strokeStyle = "#2fa84f"; ctx.lineWidth = 2; ctx.strokeRect(P[0] - 6, P[1] - 6, 12, 12);
    }
    const want = S.hover && pointTool && !drag && overPlan(S.hover.sx, S.hover.sy) ? 1 : 0;
    if (want) Object.assign(loupe, { sx: S.hover.sx, sy: S.hover.sy, src: S.hover.src, snapped: S.hover.snapped });
    loupe.t += (want - loupe.t) * 0.24;
    if (Math.abs(want - loupe.t) < 0.01) loupe.t = want; else requestDraw();
    if (loupe.t > 0 && loupe.src) drawLoupe(1 - Math.pow(1 - loupe.t, 3));
  }
  positionRefbox();
}

const loupe = { t: 0, sx: 0, sy: 0, src: null, snapped: false };
function overPlan(sx, sy) {
  if (!S.plan) return false;
  const p = screenToPaper([sx, sy]), [bw, bh] = boxDims();
  return p[0] >= S.ox && p[0] <= S.ox + bw && p[1] >= S.oy && p[1] <= S.oy + bh;
}
function drawGuides() {
  if (!S.guides || !S.guides.length) return;
  const r = stage.getBoundingClientRect();
  ctx.strokeStyle = "#e0479e"; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath();
  for (const g of S.guides) {
    if (g.axis === "x") { const x = Math.round(paperToScreen([g.v, 0])[0]) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, r.height); }
    else { const y = Math.round(paperToScreen([0, g.v])[1]) + 0.5; ctx.moveTo(0, y); ctx.lineTo(r.width, y); }
  }
  ctx.stroke();
}

// Lupe: wächst aus dem Cursor heraus (e = 0..1, bereits ge-eased)
function drawLoupe(e) {
  const R0 = 74, LZ = 6, r = stage.getBoundingClientRect(), { sx, sy } = loupe;
  let tx = sx + 100, ty = sy - 100;
  if (tx + R0 > r.width) tx = sx - 100;
  if (ty - R0 < 0) ty = sy + 100;
  const lx = sx + (tx - sx) * e, ly = sy + (ty - sy) * e, R = R0 * (0.35 + 0.65 * e);
  const wp = srcToPaper(loupe.src), z = S.view.z * LZ * (0.5 + 0.5 * e);
  const col = loupe.snapped ? "#2fa84f" : "#c8624a";
  ctx.save();
  ctx.globalAlpha = e;
  ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#1a1a1a"; ctx.fillRect(0, 0, cv.width, cv.height);
  drawScene([z * dpr, 0, 0, z * dpr, (lx - wp[0] * z) * dpr, (ly - wp[1] * z) * dpr]);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // verfügbare Einrastpunkte
  if (S.snapOn && S.snapPts) {
    const k = mmPerPt();
    ctx.fillStyle = "rgba(47,168,79,0.85)";
    for (const p of snapPointsNear(loupe.src, R / (z * k), 400)) {
      const q = srcToPaper(p), x = lx + (q[0] - wp[0]) * z, y = ly + (q[1] - wp[1]) * z;
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.strokeStyle = col; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lx - R, ly); ctx.lineTo(lx - 5, ly); ctx.moveTo(lx + 5, ly); ctx.lineTo(lx + R, ly);
  ctx.moveTo(lx, ly - R); ctx.lineTo(lx, ly - 5); ctx.moveTo(lx, ly + 5); ctx.lineTo(lx, ly + R); ctx.stroke();
  if (loupe.snapped) { ctx.lineWidth = 2; ctx.strokeRect(lx - 7, ly - 7, 14, 14); }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = e;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = loupe.snapped ? col : "#e9e7e2"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.stroke();
  if (loupe.snapped && e > 0.6) {
    ctx.font = "10.5px " + getComputedStyle(document.body).fontFamily; ctx.textAlign = "center"; ctx.textBaseline = "top";
    const w = ctx.measureText("eingerastet").width + 10;
    ctx.fillStyle = col; ctx.fillRect(lx - w / 2, ly + R + 6, w, 16);
    ctx.fillStyle = "#fff"; ctx.fillText("eingerastet", lx, ly + R + 9);
  }
  ctx.restore();
}

function fitsInMargin() {
  const [sw, sh] = sheetDims(), [bw, bh] = boxDims(), m = S.margin, e = 0.05;
  return S.ox >= m - e && S.oy >= m - e && S.ox + bw <= sw - m + e && S.oy + bh <= sh - m + e;
}

// ------------------------------------------------------------------ Referenz-Eingabe am Plan
const refbox = $("refbox");
let refboxOpen = false;
function openRefbox() {
  refboxOpen = true;
  $("refboxLen").value = isFinite(S.refLen) ? fmt(S.refLen, 4) : "";
  $("refboxUnit").value = S.refUnit;
  refbox.classList.remove("hidden");
  positionRefbox();
  setTimeout(() => { $("refboxLen").focus(); $("refboxLen").select(); }, 0);
}
function closeRefbox() { refboxOpen = false; refbox.classList.add("hidden"); }
function positionRefbox() {
  if (!refboxOpen || !S.refA || !S.refB) return;
  const A = srcToScreen(S.refA), B = srcToScreen(S.refB), r = stage.getBoundingClientRect();
  const bw = refbox.offsetWidth, bh = refbox.offsetHeight;
  let x = (A[0] + B[0]) / 2 - bw / 2, y = (A[1] + B[1]) / 2 + 18;
  x = Math.max(8, Math.min(r.width - bw - 8, x)); y = Math.max(8, Math.min(r.height - bh - 8, y));
  refbox.style.left = x + "px"; refbox.style.top = y + "px";
}
function confirmRef(lenStr, unit) {
  const v = num(lenStr);
  if (!(v > 0)) { toast("Bitte eine Länge größer 0 eingeben.", true); return false; }
  const wasCal = !!realPerPt();
  keepCenter(() => {
    const kBefore = mmPerPt();
    S.refLen = v; S.refUnit = unit; S.calMode = "ref";
    if (!wasCal) S.scaleM = nearestNorm(realPerPt() / kBefore);   // ungefähr bisherige Größe beibehalten
  });
  closeRefbox();
  setTool("move");
  sync();
  return true;
}

// ------------------------------------------------------------------ Panel
function setTool(t) {
  S.tool = t; S.draft = null;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  setCursor();
  requestDraw();
}
function setCursor() { cv.style.cursor = { move: "move", hand: "grab", ref: "crosshair", measure: "crosshair" }[S.tool]; }

function buildChips() {
  const fc = $("fmtChips");
  for (const f of [...Object.keys(FORMATS), "frei"]) {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = f === "frei" ? "Frei (cm)" : f; b.dataset.f = f;
    b.onclick = () => { S.format = f; afterSheetChange(); };
    fc.appendChild(b);
  }
  const sc = $("scaleChips");
  for (const m of SCALE_CHIPS) {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = "1:" + m; b.dataset.m = m;
    b.onclick = () => { keepCenter(() => { S.scaleM = m; }); sync(); };
    sc.appendChild(b);
  }
}
function afterSheetChange() {
  // Plan relativ zur Blattmitte halten
  const [w0, h0] = lastSheet;
  const [w1, h1] = sheetDims();
  S.ox += (w1 - w0) / 2; S.oy += (h1 - h0) / 2;
  sync(); fitView();
}
let lastSheet = [0, 0];

function setVal(id, v) { const el = $(id); if (document.activeElement !== el) el.value = v; }

// Zustand -> Oberfläche
function sync() {
  lastSheet = sheetDims();
  const rp = realPerPt();
  document.querySelectorAll("#calSeg button").forEach((b) => b.classList.toggle("on", b.dataset.cal === S.calMode));
  $("calRef").classList.toggle("hidden", S.calMode !== "ref");
  $("calKnown").classList.toggle("hidden", S.calMode !== "known");
  $("calNone").classList.toggle("hidden", S.calMode !== "none");
  setVal("refLen", isFinite(S.refLen) ? fmt(S.refLen, 4) : "");
  $("refUnit").value = S.refUnit;
  setVal("srcScale", fmt(S.srcScale, 2));
  $("refBtn").textContent = S.refA ? "Referenz neu setzen" : "Referenz setzen";
  $("refBtn").classList.toggle("on", S.tool === "ref");

  document.querySelectorAll("#fmtChips .chip").forEach((b) => b.classList.toggle("on", b.dataset.f === S.format));
  document.querySelectorAll("#orientSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.o === S.orient); b.disabled = S.format === "frei";
  });
  $("customRow").classList.toggle("hidden", S.format !== "frei");
  setVal("customW", fmt(S.customW, 2)); setVal("customH", fmt(S.customH, 2));
  setVal("margin", fmt(S.margin, 1));

  $("scaleCal").classList.toggle("hidden", !rp);
  $("scalePct").classList.toggle("hidden", !!rp);
  $("roundWrap").classList.toggle("hidden", !rp);
  setVal("scaleM", fmtScale(S.scaleM));
  document.querySelectorAll("#scaleChips .chip").forEach((b) => b.classList.toggle("on", +b.dataset.m === S.scaleM));
  setVal("percent", fmt(S.percent, 2));
  $("roundScale").checked = S.roundScale;
  setVal("posX", fmt(S.ox, 1)); setVal("posY", fmt(S.oy, 1));
  $("optBar").checked = S.optBar; $("optLabel").checked = S.optLabel; $("optFrame").checked = S.optFrame;
  $("optBar").disabled = $("optLabel").disabled = !rp;
  $("snapOn").checked = S.snapOn;
  $("exportBtn").disabled = !S.plan;

  // Kennzahlen
  const [sw, sh] = sheetDims();
  const fmtName = S.format === "frei" ? `${fmt(S.customW, 2)} × ${fmt(S.customH, 2)} cm` : `${S.format} ${S.orient}`;
  let rows = [["Blatt", `${fmtName} · ${fmt(sw, 0)} × ${fmt(sh, 0)} mm`]];
  if (S.plan) {
    const [bw, bh] = boxDims(), k = mmPerPt(), fits = fitsInMargin();
    rows.push(["Maßstab", rp ? `1 : ${fmtScale(S.scaleM)}` : "unbekannt"]);
    rows.push(["Größe", `${fmt(k / MM_PER_PT * 100, 2)} % vom Original`]);
    rows.push(["Plan", `${fmt(bw, 0)} × ${fmt(bh, 0)} mm`]);
    if (rp) rows.push(["Real", `${fmtReal(S.W * rp)} × ${fmtReal(S.H * rp)}`]);
    rows.push(["Passt", fits ? '<span class="ok">ja, innerhalb Rand</span>' : '<span class="bad">ragt über Rand</span>']);
  }
  $("readout").innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
  updateStatus();
  savePlanState();
  requestDraw();
}

function updateStatus() {
  const parts = [];
  const rp = realPerPt();
  if (S.plan) parts.push(`<b>${S.plan.name}</b>`);
  if (S.hover) {
    const p = screenToPaper([S.hover.sx, S.hover.sy]);
    parts.push(`Blatt x ${fmt(p[0], 1)} · y ${fmt(p[1], 1)} mm`);
  }
  const hints = {
    move: "Plan ziehen, richtet sich an Kanten/Mitte aus (⌥ = frei) · Pfeiltasten · ⌘/Pinch = Zoom",
    hand: "Ansicht ziehen · ⌘/Pinch = Zoom",
    ref: S.draft ? "Zweiten Referenzpunkt anklicken · Esc = abbrechen" : "Ersten Referenzpunkt anklicken",
    measure: S.draft ? "Endpunkt anklicken" : (rp ? "Startpunkt der Messung anklicken" : "Messen zeigt ohne Referenz nur Blatt-mm"),
  };
  parts.push(hints[S.tool]);
  if (S.plan && S.snapPts && S.snapPts.length) parts.push(`${fmt(S.snapPts.length / 2, 0)} Einrastpunkte`);
  $("status").innerHTML = parts.join('<span style="color:var(--line);margin:0 12px">│</span>');
}

// ------------------------------------------------------------------ Laden
async function openPlanInfo(info) {
  S.plan = info; S.measures = []; S.draft = null; closeRefbox();
  const sel = $("pageSel"); sel.innerHTML = "";
  info.pages.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = `${i + 1} / ${info.pages.length}`; sel.appendChild(o); });
  $("pageRow").classList.toggle("hidden", info.pages.length < 2);
  $("drop").classList.add("has-file"); $("drop").textContent = info.name;
  $("empty").classList.add("hidden");
  await loadPage(0);
}
async function loadPage(pno) {
  S.pno = pno; $("pageSel").value = pno;
  const pg = S.plan.pages[pno];
  S.W = pg.w; S.H = pg.h; S.img = null; S.snapPts = null; S.grids = null; S.measures = [];
  // Standard: Originalgröße, ohne Referenz, mittig
  Object.assign(S, { calMode: "none", refA: null, refB: null, refLen: NaN, srcScale: 100, scaleM: 50, percent: 100, rotation: 0 });
  if (!restorePlanState()) {
    centerPlan();
    if (!fitsInMargin()) fitToSheet();
  }
  sync(); fitView();
  toast("Plan wird geladen …");
  const plan = S.plan, current = () => S.plan === plan && S.pno === pno;
  try {
    const img = await renderPage(plan, pno);
    if (!current()) return;
    S.img = img; requestDraw(); hideToast();
  } catch (e) { toast("Vorschau konnte nicht erstellt werden: " + e.message, true); return; }
  try {
    const pts = await snapPoints(plan, pno);
    if (!current()) return;
    S.snapPts = pts; S.grids = pts.length ? buildGrids(pts) : null; updateStatus();
  } catch (e) { console.warn("Einrastpunkte nicht verfügbar", e); }
}
async function uploadFile(file) {
  toast("Öffne " + file.name + " …");
  try { await openPlanInfo(await openFile(file)); }
  catch (e) { toast("Konnte nicht geöffnet werden: " + e.message, true); }
}
function openDialog() { $("fileInput").click(); }

// ------------------------------------------------------------------ Export
function exportLayout() {
  const [sw, sh] = sheetDims(), rp = realPerPt();
  const base = S.plan.name.replace(/\.[^.]+$/, "");
  const fmtName = S.format === "frei" ? `${fmt(S.customW, 1)}x${fmt(S.customH, 1)}cm` : S.format + (S.orient === "quer" ? "-quer" : "");
  const scalePart = rp ? `M1-${fmtScale(S.scaleM)}` : `${fmt(S.percent, 1)}pct`;
  return {
    pno: S.pno, sheetW: sw, sheetH: sh, planMatrix: planMatrix(), margin: S.margin, frame: S.optFrame,
    scaleLabel: rp && S.optLabel ? `M 1:${fmtScale(S.scaleM)}` : "",
    realPerPaper: rp && S.optBar ? S.scaleM : 0,
    filename: `${base}_${scalePart}_${fmtName}.pdf`.replace(/,/g, "-"),
  };
}
let exporting = false;
async function doExport() {
  if (!S.plan || exporting) return;
  exporting = true; $("exportBtn").disabled = true;
  const lay = exportLayout();
  toast("PDF wird erstellt …");
  try {
    const bytes = await exportPdf(S.plan, lay);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); a.download = lay.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(`Gespeichert: ${lay.filename}. Beim Drucken „Tatsächliche Größe / 100 %“ wählen.`);
  } catch (e) { toast("Export fehlgeschlagen: " + e.message, true); }
  finally { exporting = false; $("exportBtn").disabled = !S.plan; }
}

// ------------------------------------------------------------------ Toast
let toastTimer;
function toast(msg, err = false, action = null) {
  const t = $("toast"); t.innerHTML = ""; t.classList.toggle("err", err);
  const s = document.createElement("span"); s.textContent = msg; t.appendChild(s);
  if (action) { const b = document.createElement("button"); b.textContent = action.label; b.onclick = action.fn; t.appendChild(b); }
  t.classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : err ? 6000 : 3500);
}
function hideToast() { $("toast").classList.remove("show"); }

// ------------------------------------------------------------------ Eingaben im Panel
function bindNum(id, apply, { min = -Infinity } = {}) {
  const el = $(id);
  const commit = () => { const v = num(el.value); if (isFinite(v) && v >= min) apply(v); sync(); };
  el.addEventListener("change", commit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); el.blur(); }
    if (e.key === "Escape") { el.blur(); sync(); }
  });
  el.addEventListener("blur", () => sync());
}
bindNum("refLen", (v) => { if (v > 0) { if (S.refA && S.refB) confirmRef(String(v), $("refUnit").value); else S.refLen = v; } });
$("refUnit").onchange = () => { keepCenter(() => { S.refUnit = $("refUnit").value; }); sync(); };
bindNum("srcScale", (v) => { if (v > 0) keepCenter(() => { S.srcScale = v; }); });
bindNum("scaleM", (v) => { if (v > 0) keepCenter(() => { S.scaleM = v; }); });
bindNum("percent", (v) => { if (v > 0) keepCenter(() => { S.percent = v; }); });
bindNum("customW", (v) => { if (v > 0) { S.customW = v; afterSheetChange(); } });
bindNum("customH", (v) => { if (v > 0) { S.customH = v; afterSheetChange(); } });
bindNum("margin", (v) => { S.margin = v; }, { min: 0 });
bindNum("posX", (v) => { S.ox = v; });
bindNum("posY", (v) => { S.oy = v; });

$("calSeg").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  keepCenter(() => {
    const kBefore = mmPerPt(), wasCal = !!realPerPt();
    S.calMode = b.dataset.cal;
    const rp = realPerPt();
    if (rp && !wasCal) S.scaleM = nearestNorm(rp / kBefore);
    if (!rp && wasCal) S.percent = Math.round(kBefore / MM_PER_PT * 1000) / 10;
  });
  if (S.calMode === "ref" && !S.refA && S.plan) setTool("ref");
  sync();
};
$("orientSeg").onclick = (e) => { const b = e.target.closest("button"); if (b && !b.disabled) { S.orient = b.dataset.o; afterSheetChange(); } };
$("refBtn").onclick = () => { if (!S.plan) return; S.calMode = "ref"; setTool("ref"); sync(); };
$("fitBtn").onclick = () => { fitToSheet(); sync(); fitView(); };
$("roundScale").onchange = (e) => { S.roundScale = e.target.checked; sync(); };
$("centerBtn").onclick = () => { centerPlan(); sync(); };
$("rotR").onclick = () => { keepCenter(() => { S.rotation = (S.rotation + 90) % 360; }); sync(); };
$("rotL").onclick = () => { keepCenter(() => { S.rotation = (S.rotation + 270) % 360; }); sync(); };
for (const id of ["optBar", "optLabel", "optFrame"]) $(id).onchange = (e) => { S[id] = e.target.checked; sync(); };
$("snapOn").onchange = (e) => { S.snapOn = e.target.checked; sync(); };
$("clearMeasures").onclick = () => { S.measures = []; S.draft = null; sync(); };
$("fitView").onclick = fitView;
$("exportBtn").onclick = doExport;
$("pageSel").onchange = (e) => loadPage(+e.target.value);
document.querySelectorAll("[data-tool]").forEach((b) => b.onclick = () => setTool(b.dataset.tool));
$("drop").onclick = openDialog;
$("fileInput").onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); e.target.value = ""; };
$("refboxOk").onclick = () => confirmRef($("refboxLen").value, $("refboxUnit").value);
$("refboxLen").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") confirmRef($("refboxLen").value, $("refboxUnit").value);
  if (e.key === "Escape") { closeRefbox(); sync(); }
});

// Drag & Drop
for (const el of [stage, $("drop")]) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); stage.classList.add("dragover"); });
  el.addEventListener("dragleave", () => stage.classList.remove("dragover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); stage.classList.remove("dragover");
    const f = e.dataTransfer.files[0]; if (f) uploadFile(f);
  });
}

// ------------------------------------------------------------------ Maus & Tastatur auf der Ansicht
let drag = null, spaceDown = false;
const localPt = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

cv.addEventListener("pointerdown", (e) => {
  const [sx, sy] = localPt(e);
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || spaceDown || S.tool === "hand" || !S.plan) {
    drag = { kind: "pan", sx, sy, vx: S.view.x, vy: S.view.y }; cv.style.cursor = "grabbing"; return;
  }
  if (S.tool === "move") {
    drag = { kind: "plan", p: screenToPaper([sx, sy]), ox: S.ox, oy: S.oy }; return;
  }
  // Referenz / Messen
  const { src } = pickPoint(sx, sy, e);
  if (!S.draft) { S.draft = src; closeRefbox(); }
  else {
    const a = S.draft; S.draft = null;
    if (Math.hypot(...srcToScreen(src).map((v, i) => v - srcToScreen(a)[i])) < 3) { requestDraw(); return; }
    if (S.tool === "ref") { S.refA = a; S.refB = src; S.calMode = "ref"; sync(); openRefbox(); }
    else { S.measures.push({ a, b: src }); sync(); }
  }
  updateStatus(); requestDraw();
});
cv.addEventListener("pointermove", (e) => {
  const [sx, sy] = localPt(e);
  if (drag && drag.kind === "pan") {
    S.view.x = drag.vx + sx - drag.sx; S.view.y = drag.vy + sy - drag.sy; requestDraw(); positionRefbox(); return;
  }
  if (drag && drag.kind === "plan") {
    const p = screenToPaper([sx, sy]);
    let ox = drag.ox + p[0] - drag.p[0], oy = drag.oy + p[1] - drag.p[1];
    if (e.altKey) S.guides = []; else [ox, oy] = smartAlign(ox, oy);
    S.ox = ox; S.oy = oy;
    sync(); return;
  }
  if (S.plan && (S.tool === "ref" || S.tool === "measure")) {
    const { src, snapped } = pickPoint(sx, sy, e);
    S.hover = { sx, sy, src, snapped };
  } else S.hover = { sx, sy, src: S.plan ? screenToSrc([sx, sy]) : [0, 0], snapped: false };
  updateStatus(); requestDraw();
});
cv.addEventListener("pointerup", () => { if (drag) { drag = null; S.guides = []; setCursor(); requestDraw(); } });
cv.addEventListener("pointerleave", () => { S.hover = null; updateStatus(); requestDraw(); });
cv.addEventListener("contextmenu", (e) => e.preventDefault());

function zoomAt(sx, sy, factor) {
  const z = Math.max(0.02, Math.min(400, S.view.z * factor)), f = z / S.view.z;
  S.view.x = sx - (sx - S.view.x) * f; S.view.y = sy - (sy - S.view.y) * f; S.view.z = z;
  requestDraw();
}
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [sx, sy] = localPt(e);
  const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || mouseWheel) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
  else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; requestDraw(); }
  if (S.hover) { S.hover.sx = sx; S.hover.sy = sy; const p = pickPoint(sx, sy, e); S.hover.src = p.src; S.hover.snapped = p.snapped; }
}, { passive: false });

window.addEventListener("keydown", (e) => {
  const inField = ["INPUT", "SELECT"].includes(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") { e.preventDefault(); openDialog(); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "e")) { e.preventDefault(); doExport(); return; }
  if (inField) return;
  if (e.key === " ") { spaceDown = true; cv.style.cursor = "grab"; e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === "v") setTool("move");
  else if (k === "h") setTool("hand");
  else if (k === "r" && S.plan) { S.calMode = "ref"; setTool("ref"); sync(); }
  else if (k === "m") setTool("measure");
  else if (k === "f") fitView();
  else if (k === "c" && S.plan) { centerPlan(); sync(); }
  else if (k === "+" || k === "=") { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); }
  else if (k === "-") { const r = stage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); }
  else if (e.key === "Escape") { S.draft = null; closeRefbox(); if (S.tool !== "move") setTool("move"); sync(); }
  else if (e.key === "Backspace" || e.key === "Delete") { S.measures.pop(); sync(); }
  else if (e.key.startsWith("Arrow") && S.plan) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    if (e.key === "ArrowLeft") S.ox -= d; if (e.key === "ArrowRight") S.ox += d;
    if (e.key === "ArrowUp") S.oy -= d; if (e.key === "ArrowDown") S.oy += d;
    sync();
  }
});
window.addEventListener("keyup", (e) => { if (e.key === " ") { spaceDown = false; setCursor(); } });
new ResizeObserver(resizeCanvas).observe(stage);

// ------------------------------------------------------------------ Tooltips
const tip = $("tip");
let tipEl = null, tipTimer = null;
function hideTip() { clearTimeout(tipTimer); tip.classList.remove("show"); tipEl = null; }
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el === tipEl) return;
  hideTip();
  if (!el) return;
  tipEl = el;
  tipTimer = setTimeout(() => {
    tip.innerHTML = el.dataset.tip;
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8), y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    tip.style.left = x + "px"; tip.style.top = y + "px";
    tip.classList.add("show");
  }, 550);
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);

// ------------------------------------------------------------------ Start
$("ver").textContent = "v" + VERSION;
if ("serviceWorker" in navigator && location.protocol === "https:")  // lokal kein Cache, damit Änderungen sofort sichtbar sind
  navigator.serviceWorker.register("sw.js").catch(() => {});
loadPrefs();
buildChips();
setTool("move");
sync();
resizeCanvas();
fitView();
