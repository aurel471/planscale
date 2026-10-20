#!/bin/bash
# Baut PlanScale.app: kopiert den aktuellen Code in die App. Nach Code-Änderungen erneut ausführen.
# Der Code muss in der App liegen -- macOS lässt eine App nicht ohne Weiteres im Schreibtisch-Ordner lesen.
set -e
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$SRC/PlanScale.app}"
PYTHON="${PYTHON:-/Users/julius-aurelhack/.pyenv/versions/3.9.7/bin/python3}"  # gleiche Installation wie PlotPilot
RES="$APP/Contents/Resources"

"$PYTHON" -c "import flask, fitz, webview" || { echo "Fehlende Pakete: $PYTHON -m pip install -r requirements.txt"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/templates"
cp "$SRC"/app.py "$SRC"/core.py "$SRC"/desktop.py "$RES/"
cp "$SRC"/templates/*.html "$RES/templates/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>PlanScale</string>
    <key>CFBundleDisplayName</key><string>PlanScale</string>
    <key>CFBundleIdentifier</key><string>local.julius.planscale</string>
    <key>CFBundleExecutable</key><string>PlanScale</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/PlanScale" <<LAUNCH
#!/bin/bash
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export PLANSCALE_DATA_DIR="\$HOME/Library/Application Support/PlanScale"
mkdir -p "\$PLANSCALE_DATA_DIR"
cd "\$DIR/../Resources"
exec "$PYTHON" desktop.py >> "\$HOME/Library/Logs/PlanScale.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/PlanScale"
echo "Gebaut: $APP (Python: $PYTHON)"
