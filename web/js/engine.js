// engine.js - Pläne laden, Vorschau rendern, Einrastpunkte auslesen und maßstäblich als PDF ausgeben.
// Läuft komplett im Browser: Dateien verlassen den Rechner nie.
//
// Koordinaten: Quelle in PDF-Punkten (pt, 1/72 Zoll) wie angezeigt (y nach unten, Seitendrehung angewendet),
// Blatt in Millimetern (y nach unten). Der Export bleibt vektorbasiert: die Quellseite wird als
// Form-XObject auf das neue Blatt gesetzt.

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import {
  PDFDocument, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

export const MM_PER_PT = 25.4 / 72;
const PT_PER_MM = 72 / 25.4;
const IMAGE_DPI = 96;               // Bilder ohne bekannte Auflösung: "Originalgröße" wie am Bildschirm
const PREVIEW_MAX_DPI = 200;
const PREVIEW_MAX_AREA = 16e6;      // Safari-Grenze für Canvas-Flächen (16,7 Mio. Pixel)
const PREVIEW_MAX_SIDE = 8000;
const SNAP_MAX_POINTS = 400_000;

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

// Affinmatrizen [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f
export const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

async function sha1(buf) {
  const h = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- Laden

export async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const id = await sha1(bytes);
  const isImage = IMAGE_EXT.includes(ext) || file.type.startsWith("image/");
  return isImage ? openImage(file, bytes, id) : openPdf(file.name, bytes, id);
}

async function openPdf(name, bytes, id) {
  let doc;
  try {
    // pdf.js übernimmt den Puffer, daher eine Kopie für den Export behalten
    doc = await pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: VENDOR + "cmaps/", cMapPacked: true,
      standardFontDataUrl: VENDOR + "standard_fonts/",
      wasmUrl: VENDOR + "wasm/",
      isEvalSupported: false, enableXfa: false,
    }).promise;
  } catch (e) {
    if (e && e.name === "PasswordException") throw new Error("Die PDF ist passwortgeschützt.");
    throw new Error("Keine lesbare PDF-Datei.");
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i), vp = p.getViewport({ scale: 1 });
    pages.push({ w: vp.width, h: vp.height });
  }
  return { id, name, kind: "pdf", bytes, doc, pages, _pdfLib: null };
}

async function openImage(file, bytes, id) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error("Dieses Bildformat kann der Browser nicht lesen (PNG oder JPG verwenden)."); }
  const k = 72 / IMAGE_DPI;
  // pdf-lib kann nur PNG und JPG einbetten, alles andere vorher zu PNG wandeln
  let embedBytes = bytes, embedType = /jpe?g/.test(file.type) || /\.jpe?g$/i.test(file.name) ? "jpg" : "png";
  if (!(file.type === "image/png" || /\.png$/i.test(file.name) || embedType === "jpg")) {
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    embedBytes = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/png"))).arrayBuffer());
    embedType = "png";
  }
  return { id, name: file.name, kind: "image", bytes: embedBytes, embedType, bitmap: bmp, pages: [{ w: bmp.width * k, h: bmp.height * k }] };
}

// ---------------------------------------------------------------- Vorschau

// Liefert ein Canvas mit transparentem Hintergrund, das die Seite in Quell-pt (W x H) abbildet.
export async function renderPage(plan, pno) {
  if (plan.kind === "image") return plan.bitmap;
  const page = await plan.doc.getPage(pno + 1);
  const vp1 = page.getViewport({ scale: 1 });
  let zoom = PREVIEW_MAX_DPI / 72;
  zoom = Math.min(zoom, PREVIEW_MAX_SIDE / Math.max(vp1.width, vp1.height));
  zoom = Math.min(zoom, Math.sqrt(PREVIEW_MAX_AREA / (vp1.width * vp1.height)));
  const vp = page.getViewport({ scale: zoom });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, background: "rgba(0,0,0,0)" }).promise;
  return canvas;
}

// ---------------------------------------------------------------- Einrastpunkte

// Endpunkte und Ecken aller Vektorpfade als flache Liste [x0, y0, x1, y1, ...] in Quell-pt.
export async function snapPoints(plan, pno) {
  if (plan.kind !== "pdf") return new Float64Array(0);
  const { OPS } = pdfjs;
  const page = await plan.doc.getPage(pno + 1);
  const T = page.getViewport({ scale: 1 }).transform;
  const ops = await page.getOperatorList();
  const seen = new Set(), out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const add = (x, y) => {
    const m = mul(T, ctm), q = apply(m, [x, y]);
    const key = Math.round(q[0] * 10) * 1e7 + Math.round(q[1] * 10);
    if (!seen.has(key)) { seen.add(key); out.push(q[0], q[1]); }
  };
  for (let i = 0; i < ops.fnArray.length && out.length < SNAP_MAX_POINTS * 2; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const d = args && args[1] && args[1][0];
      if (!d || typeof d.length !== "number") continue;
      for (let j = 0; j < d.length;) {
        switch (d[j++]) {
          case 0: case 1: add(d[j], d[j + 1]); j += 2; break;      // moveTo, lineTo
          case 2: add(d[j + 4], d[j + 5]); j += 6; break;          // curveTo: nur Endpunkt
          case 3: add(d[j + 2], d[j + 3]); j += 4; break;          // quadraticCurveTo
          case 4: break;                                            // closePath
          default: j = d.length;
        }
      }
    }
  }
  return new Float64Array(out);
}

// ---------------------------------------------------------------- Export

function niceBarLength(realPerPaper, targetPaperMm = 60) {
  const raw = targetPaperMm * realPerPaper, exp = 10 ** Math.floor(Math.log10(raw));
  for (const f of [5, 2, 1]) if (f * exp <= raw) return f * exp;
  return exp;
}
function fmtReal(mm) {
  let v = mm, unit = "mm";
  if (mm >= 1000) { v = mm / 1000; unit = "m"; } else if (mm >= 10) { v = mm / 10; unit = "cm"; }
  return `${String(+v.toFixed(2)).replace(".", ",")} ${unit}`;
}

/**
 * layout: { pno, sheetW, sheetH (mm), planMatrix (Quell-pt -> Blatt-mm), margin, frame,
 *           scaleLabel ("" = keine), realPerPaper (>0 = Maßstabsleiste) }
 */
export async function exportPdf(plan, lay) {
  const out = await PDFDocument.create();
  out.setProducer("PlanScale"); out.setCreator("PlanScale");
  const pw = lay.sheetW * PT_PER_MM, ph = lay.sheetH * PT_PER_MM;
  const page = out.addPage([pw, ph]);
  const Q = [PT_PER_MM, 0, 0, -PT_PER_MM, 0, ph];          // Blatt-mm (y unten) -> PDF-pt (y oben)
  const QP = mul(Q, lay.planMatrix);

  let M, name;
  if (plan.kind === "pdf") {
    plan._pdfLib ||= await PDFDocument.load(plan.bytes, { ignoreEncryption: true, updateMetadata: false });
    const src = await plan.doc.getPage(lay.pno + 1);
    const [x0, y0, x1, y1] = src.view;                      // sichtbarer Seitenbereich (CropBox)
    const T = src.getViewport({ scale: 1 }).transform;      // PDF-Nutzerraum -> angezeigte Seite, inkl. Drehung
    const emb = await out.embedPage(plan._pdfLib.getPage(lay.pno), { left: x0, bottom: y0, right: x1, top: y1 }, [1, 0, 0, 1, 0, 0]);
    M = mul(QP, T);
    name = page.node.newXObject("Plan", emb.ref);
  } else {
    const img = plan.embedType === "jpg" ? await out.embedJpg(plan.bytes) : await out.embedPng(plan.bytes);
    const { w, h } = plan.pages[0];
    M = mul(QP, [w, 0, 0, -h, 0, h]);                       // Bild-Einheitsquadrat (y oben) -> Quell-pt
    name = page.node.newXObject("Plan", img.ref);
  }
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M), drawObject(name), popGraphicsState());

  const black = rgb(0, 0, 0), white = rgb(1, 1, 1);
  const m = lay.margin * PT_PER_MM;
  if (lay.frame && m > 0) page.drawRectangle({ x: m, y: m, width: pw - 2 * m, height: ph - 2 * m, borderColor: black, borderWidth: 0.5 });

  const helv = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  const barY = m + 4 * PT_PER_MM;                          // Unterkante der Leiste
  let bx = m + 4 * PT_PER_MM;
  if (lay.realPerPaper > 0) {
    const realLen = niceBarLength(lay.realPerPaper);
    const barLen = realLen / lay.realPerPaper * PT_PER_MM, seg = barLen / 5, bh = 1.6 * PT_PER_MM;
    page.drawRectangle({ x: bx, y: barY, width: barLen, height: bh, color: white });
    for (let i = 0; i < 5; i += 2) page.drawRectangle({ x: bx + i * seg, y: barY, width: seg, height: bh, color: black });
    page.drawRectangle({ x: bx, y: barY, width: barLen, height: bh, borderColor: black, borderWidth: 0.4 });
    page.drawText("0", { x: bx - 1, y: barY + bh + 2, size: 6.5, font: helv });
    const label = fmtReal(realLen), tw = helv.widthOfTextAtSize(label, 6.5);
    page.drawText(label, { x: bx + barLen - tw / 2, y: barY + bh + 2, size: 6.5, font: helv });
    bx += barLen + 6 * PT_PER_MM;
  }
  if (lay.scaleLabel) page.drawText(lay.scaleLabel, { x: bx, y: barY, size: 9, font: bold });

  return out.save();
}
