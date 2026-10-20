#!/bin/bash
# Baut PlanScale.app für den eigenen Mac: kopiert ../web in die App und startet sie mit pywebview.
# Nach Änderungen an web/ erneut ausführen. Für die Weitergabe an andere die Web-Version nutzen.
set -e
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$SRC/PlanScale.app}"
PYTHON="${PYTHON:-/Users/julius-aurelhack/.pyenv/versions/3.9.7/bin/python3}"
RES="$APP/Contents/Resources"

"$PYTHON" -c "import webview" || { echo "pywebview fehlt: $PYTHON -m pip install pywebview"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"
cp "$SRC/desktop.py" "$RES/"
cp -R "$SRC/../web" "$RES/web"

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
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/PlanScale" <<LAUNCH
#!/bin/bash
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export PLANSCALE_DATA_DIR="\$HOME/Library/Application Support/PlanScale"
export PLANSCALE_WEB_DIR="\$DIR/../Resources/web"
mkdir -p "\$PLANSCALE_DATA_DIR"
cd "\$DIR/../Resources"
exec "$PYTHON" desktop.py >> "\$HOME/Library/Logs/PlanScale.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/PlanScale"
echo "Gebaut: $APP"
