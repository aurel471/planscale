# PlanScale

Architekturpläne über ein Referenzmaß kalibrieren und maßstäblich auf DIN-A/B-Formate
oder ein freies Format in cm setzen. Der Export bleibt bei PDFs vektorbasiert.

**Läuft komplett im Browser.** Pläne werden nicht hochgeladen und verlassen den eigenen
Rechner nicht. Nach dem ersten Besuch funktioniert die App auch offline und lässt sich
installieren (Chrome/Edge: Symbol in der Adressleiste, Safari: Ablage → Zum Dock hinzufügen).

## So geht's

1. **Plan öffnen**: PDF, PNG oder JPG hineinziehen oder ⌘O. CAD-Dateien (DWG/DXF) vorher als PDF exportieren.
2. **Referenzmaß**: Taste **R**, zwei Punkte auf ein bekanntes Maß klicken (z. B. eine Bemaßung), echte Länge eingeben.
   Punkte rasten an Ecken und Linienenden ein. Ist das PDF schon maßstäblich, stattdessen „Maßstab bekannt“.
3. **Arbeitsbereich**: A0–A6, B1–B4, hoch/quer, oder „Frei (cm)“. Rand in mm.
4. **Maßstab**: z. B. 1:50 wählen oder „Auf Blatt einpassen“.
5. **Lage**: Plan mit **V** ziehen (richtet sich an Kanten und Mitte aus), drehen, zentrieren.
6. **PDF exportieren** (⌘S), optional mit Maßstabsleiste und Beschriftung.

> **Beim Drucken „Tatsächliche Größe“ bzw. 100 % wählen**, nicht „An Seite anpassen“, sonst stimmt der Maßstab nicht.

### Tasten

| Taste | Funktion |
|---|---|
| V / H / R / M | Verschieben / Ansicht / Referenz / Messen |
| F / C | Ansicht einpassen / Plan zentrieren |
| Pfeile | Plan 1 mm verschieben (⇧ 10 mm, ⌥ 0,1 mm) |
| ⇧ beim Klicken | waagerecht/senkrecht |
| ⌥ | Einrasten bzw. Ausrichten kurz aus |
| Leertaste + Ziehen, Zwei-Finger-Scrollen | Ansicht bewegen |
| ⌘ + Scrollen, Pinch | Zoom |
| ⌫ | letzte Messung löschen |

Referenz, Maßstab und Lage werden pro Plan im Browser gespeichert.

## Entwicklung

Kein Build-Schritt. Lokal starten:

```bash
python3 -m http.server 8000 -d web
# → http://localhost:8000
```

- `web/js/engine.js`: PDF laden, Vorschau, Einrastpunkte, Export ([pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/))
- `web/js/app.js`: Oberfläche, Ansicht, Werkzeuge
- `web/vendor/`: Bibliotheken lokal eingebunden (pdf.js 6.4.299 Legacy-Build, pdf-lib 1.17.1), kein CDN
- `desktop/`: optionale Mac-App für den Eigengebrauch (pywebview-Fenster um `web/`)

**Neue Version veröffentlichen:** `VERSION` in `web/js/app.js` und `CACHE` in `web/sw.js` hochzählen,
dann auf `main` pushen. GitHub Actions veröffentlicht `web/` automatisch über GitHub Pages
(Repo → Settings → Pages → Source: „GitHub Actions“).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Enthaltene Bibliotheken: pdf.js (Apache-2.0), pdf-lib (MIT),
jeweils mit Lizenzdatei in `web/vendor/`.
