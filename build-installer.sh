#!/bin/bash
# ============================================================
# Lumina FX — Pro Installer Builder
# ============================================================
# Run this on macOS to create a self-contained .app + .dmg
# Usage: ./build-installer.sh
# ============================================================

set -e

VERSION="0.5.0"
APP_NAME="Lumina FX"
BUNDLE_ID="com.lumina.fx"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
DMG_DIR="$BUILD_DIR/dmg"
DMG_NAME="Lumina-FX-${VERSION}-Installer.dmg"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Lumina FX Installer Builder        ║"
echo "║              v${VERSION}                     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ---- Clean previous build ----
echo "→ Cleaning previous build..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ---- Step 1: Detect local Node.js ----
echo "→ Detecting Node.js..."

find_node() {
  for p in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.volta/bin/node"; do
    if [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh"
    which node 2>/dev/null && return 0
  fi
  return 1
}

NODE_BIN=$(find_node)
if [ -z "$NODE_BIN" ]; then
  echo "✗ Node.js not found. Install it first: brew install node"
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" --version)
echo "  Found Node.js $NODE_VERSION at $NODE_BIN"

# ---- Step 2: Build .app bundle ----
echo "→ Building $APP_NAME.app..."

# Create bundle structure
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/Resources/app"
mkdir -p "$APP_DIR/Contents/Resources/node"
mkdir -p "$APP_DIR/Contents/Resources/media/movies"
mkdir -p "$APP_DIR/Contents/Resources/media/pics"

# Copy app files
echo "  Copying application files..."
cp "$SCRIPT_DIR/lighting-server.js" "$APP_DIR/Contents/Resources/app/"
cp "$SCRIPT_DIR/lighting-server-no-dmx-input.js" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/lighting-app.html" "$APP_DIR/Contents/Resources/app/"
cp "$SCRIPT_DIR/lighting-app-no-dmx-input.html" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/fixture-library.json" "$APP_DIR/Contents/Resources/app/"
cp "$SCRIPT_DIR/build-fixture-library.js" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/package.json" "$APP_DIR/Contents/Resources/app/"
cp "$SCRIPT_DIR/package-lock.json" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/test-show.mvr" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/f35-mockup.html" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true
cp "$SCRIPT_DIR/mockup-server.js" "$APP_DIR/Contents/Resources/app/" 2>/dev/null || true

# Copy node_modules
echo "  Bundling dependencies..."
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "  Running npm install first..."
  cd "$SCRIPT_DIR"
  npm install --production
fi
cp -R "$SCRIPT_DIR/node_modules" "$APP_DIR/Contents/Resources/app/node_modules"

# Bundle Node.js binary
echo "  Bundling Node.js runtime..."
cp "$NODE_BIN" "$APP_DIR/Contents/Resources/node/node"
chmod +x "$APP_DIR/Contents/Resources/node/node"

# Copy icon
if [ -f "$SCRIPT_DIR/Lumina FX.app/Contents/Resources/Lumina.icns" ]; then
  cp "$SCRIPT_DIR/Lumina FX.app/Contents/Resources/Lumina.icns" "$APP_DIR/Contents/Resources/Lumina.icns"
  echo "  Icon: Lumina.icns ✓"
fi

# ---- Step 3: Create launcher script ----
echo "  Creating launcher..."
cat > "$APP_DIR/Contents/MacOS/lumina-start" << 'LAUNCHER'
#!/bin/bash
# ============================================================
# Lumina FX — Self-Contained Launcher
# ============================================================

APP_CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
APP_RESOURCES="$APP_CONTENTS/Resources"
NODE_BIN="$APP_RESOURCES/node/node"
SERVER_DIR="$APP_RESOURCES/app"
PORT=3457
SHOWS_DIR="$HOME/Documents/Lumina Shows"

# ---- macOS Helpers ----
notify() {
  osascript -e "display notification \"$1\" with title \"Lumina FX\"" 2>/dev/null
}

alert_error() {
  osascript -e "display alert \"Lumina FX\" message \"$1\" as critical" 2>/dev/null
}

# ---- Verify embedded Node ----
if [ ! -x "$NODE_BIN" ]; then
  # Fallback: try system Node
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && NODE_BIN="$p" && break
  done
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    source "$NVM_DIR/nvm.sh" 2>/dev/null
    NODE_BIN=$(which node 2>/dev/null)
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  alert_error "Node.js runtime not found.\n\nPlease reinstall Lumina FX."
  exit 1
fi

# ---- Create shows directory ----
mkdir -p "$SHOWS_DIR" 2>/dev/null

# ---- Create media directories ----
mkdir -p "$SERVER_DIR/media/movies" 2>/dev/null
mkdir -p "$SERVER_DIR/media/pics" 2>/dev/null

# ---- Kill any existing Lumina server ----
pkill -f "node.*lighting-server.js" 2>/dev/null
sleep 0.3

# ---- Start the server ----
cd "$SERVER_DIR"
"$NODE_BIN" lighting-server.js &
SERVER_PID=$!

# ---- Wait for server ready ----
READY=false
for i in {1..25}; do
  if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.3
done

if [ "$READY" = false ]; then
  alert_error "Server failed to start.\n\nPort $PORT may already be in use.\nTry closing other Lumina instances."
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

# ---- Open in browser ----
open "http://localhost:$PORT"
notify "Lumina FX is running on port $PORT"

# ---- Keep alive ----
wait $SERVER_PID
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/lumina-start"

# ---- Step 4: Create Info.plist ----
echo "  Writing Info.plist..."
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>lumina-start</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>Lumina</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key>
      <string>Lumina Show File</string>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>lumina</string>
      </array>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Owner</string>
    </dict>
    <dict>
      <key>CFBundleTypeName</key>
      <string>MVR File</string>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>mvr</string>
      </array>
      <key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>LSHandlerRank</key>
      <string>Default</string>
    </dict>
  </array>
</dict>
</plist>
PLIST

# ---- Step 5: Create uninstaller ----
echo "→ Creating uninstaller..."
cat > "$BUILD_DIR/Uninstall Lumina FX.command" << 'UNINSTALL'
#!/bin/bash
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║      Lumina FX Uninstaller               ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Stop running server
echo "→ Stopping Lumina FX..."
pkill -f "node.*lighting-server.js" 2>/dev/null

# Remove app
if [ -d "/Applications/Lumina FX.app" ]; then
  echo "→ Removing /Applications/Lumina FX.app..."
  rm -rf "/Applications/Lumina FX.app"
  echo "  ✓ App removed"
else
  echo "  App not found in /Applications"
fi

echo ""
echo "Note: Your show files in ~/Documents/Lumina Shows/ were NOT removed."
echo ""
read -p "Remove show files too? (y/N): " REMOVE_SHOWS
if [ "$REMOVE_SHOWS" = "y" ] || [ "$REMOVE_SHOWS" = "Y" ]; then
  rm -rf "$HOME/Documents/Lumina Shows"
  echo "  ✓ Show files removed"
fi

echo ""
echo "✓ Lumina FX has been uninstalled."
echo ""
UNINSTALL
chmod +x "$BUILD_DIR/Uninstall Lumina FX.command"

# ---- Step 6: Create .dmg ----
echo "→ Creating DMG installer..."

DMG_DIR="$BUILD_DIR/dmg"
mkdir -p "$DMG_DIR"

# Copy .app to dmg staging
cp -R "$APP_DIR" "$DMG_DIR/"

# Create Applications symlink for drag-to-install
ln -s /Applications "$DMG_DIR/Applications"

# Copy uninstaller
cp "$BUILD_DIR/Uninstall Lumina FX.command" "$DMG_DIR/"

# Create a background instructions file
cat > "$DMG_DIR/.background_setup.applescript" << 'APPLESCRIPT'
tell application "Finder"
  tell disk "Lumina FX"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {200, 120, 760, 480}
    set theViewOptions to icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 100
    set position of item "Lumina FX.app" of container window to {140, 180}
    set position of item "Applications" of container window to {420, 180}
    close
  end tell
end tell
APPLESCRIPT

# Create the DMG
DMG_PATH="$BUILD_DIR/$DMG_NAME"
echo "  Creating $DMG_NAME..."

hdiutil create -volname "Lumina FX" \
  -srcfolder "$DMG_DIR" \
  -ov -format UDZO \
  "$DMG_PATH" 2>/dev/null

if [ $? -eq 0 ]; then
  DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║         ✓ Build Complete!                ║"
  echo "╠══════════════════════════════════════════╣"
  echo "║                                          ║"
  echo "  App:  $APP_DIR"
  echo "  DMG:  $DMG_PATH ($DMG_SIZE)"
  echo "║                                          ║"
  echo "║  To install:                             ║"
  echo "║  1. Open the .dmg                        ║"
  echo "║  2. Drag Lumina FX to Applications       ║"
  echo "║  3. Double-click to launch               ║"
  echo "║                                          ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""

  # Open the DMG
  open "$DMG_PATH"
else
  echo ""
  echo "  DMG creation failed. You can still use the .app directly:"
  echo "  $APP_DIR"
  echo ""
  echo "  To install manually:"
  echo "  cp -R \"$APP_DIR\" /Applications/"
  echo ""
fi
