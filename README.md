# PlanScale

Architekturpläne (PDF, PNG, JPG, TIFF) über ein Referenzmaß kalibrieren und
maßstäblich auf DIN-A/B-Formate oder ein freies Format in cm setzen.
Der Export bleibt bei PDFs vektorbasiert.

## Starten

- Als App: `PlanScale.app` doppelklicken (nach Code-Änderungen `./build_app.sh` erneut ausführen)
- Im Browser: `python3 app.py` → http://127.0.0.1:5070

Pakete: `pip install -r requirements.txt` (flask, pymupdf, pywebview)

## Ablauf

1. Plan öffnen (⌘O oder hineinziehen)
2. Referenz: **R**, zwei Punkte auf ein bekanntes Maß klicken, Länge eingeben.
   Alternativ „Maßstab bekannt“, wenn das PDF schon z. B. 1:100 angelegt ist.
3. Blattformat wählen (A0–A6, B1–B4, Hoch/Quer) oder „Frei (cm)“, Rand in mm
4. Zielmaßstab setzen oder „Auf Blatt einpassen“ (rundet auf Normmaßstab)
5. Plan mit **V** verschieben, drehen, zentrieren
6. PDF exportieren (⌘S), optional mit Maßstabsleiste, Beschriftung, Rahmen

## Tasten

V Verschieben · H Ansicht · R Referenz · M Messen · F Ansicht einpassen · C Zentrieren
Pfeile = 1 mm (⇧ 10 mm, ⌥ 0,1 mm) · ⇧ beim Klicken = waagerecht/senkrecht · ⌥ = ohne Einrasten
Leertaste + Ziehen = Ansicht bewegen · ⌘ + Scrollen / Pinch = Zoom · ⌫ letzte Messung löschen

Referenz, Maßstab und Lage werden pro Plan gespeichert und beim erneuten Öffnen wiederhergestellt.
