# fake-flipctl

## What is this project

A web application that simulates the Flipper One LCD screen user interface. It renders a 256x144 monochrome (black/white/grayscale) display using HTML5 Canvas and runs inside the Cog web browser on the actual Flipper One hardware.

## Tech Stack

- **Vanilla JS + CSS** — no frameworks, no bundlers, no client-side dependencies
- **Node.js server** (`server.js`) — static file server + JSON API endpoints, requires root
- **HTML5 Canvas** — pixel-perfect 256x144 rendering
- **Cog browser** — minimal WebKit-based browser (Wayland)

## Architecture

### Server (`server.js`)
- Static file server on port **8899** (binds `0.0.0.0`), requires root
- Serves JSON API endpoints (all return `application/json`):
  - **`/api/modem`** — aggregates `mmcli -m 0 -J`, `qmicli --nas-get-serving-system`, `--nas-get-cell-location-info`, `--nas-get-signal-strength` for RM530N-GL modem via `/dev/cdc-wdm0`; also reads sysfs byte counters on the modem net interface for live bandwidth
  - **`/api/wifi`** — queries the active NetworkManager connection (`nmcli c show --active`) for an `802-11-wireless` link, then resolves the bound `iface` and pulls SSID + signal via `iw dev <iface> link` (with a scan-list fallback). Returns `{ connected, quality (0-100), ssid, iface, ip4: string[], ip6: string[] }` — `ip4`/`ip6` come from `nmcli -t device show <iface>` (same source `/api/ethernet` uses), so the Desktop's Wi-Fi card can reuse `drawEthCard` without a schema fork. Empty `ip4`/`ip6` and `connected: false` when there's no active wireless.
  - **`/api/power`** — reads sysfs `/sys/class/power_supply/bq28z610-0` (voltage, current, capacity, charge, temp, time estimates)
  - **`/api/disk`** — reads `df` for `/dev/mmcblk0p2` usage (eMMC)
  - **`/api/routing`** — current routing info
  - **`/api/ethernet`** — ethernet link/IP info
  - **`/api/hostname`** (GET) — returns `{ hostname }`
  - **`/api/version`** (GET) — returns `{ id: SERVER_ID }`; client polls this to detect a server restart and reload the page
  - **`/api/update/branches`** (GET, `?refresh=1` bypasses the 60 s cache) — `{ branches[], current, source: 'remote'|'local', error }`; branches come from `git ls-remote --heads origin` (so the single-branch device clone still sees every branch), sorted case-insensitively, with the checked-out branch always included. Offline falls back to on-disk refs. Feeds the Settings → Update branch dropdown
  - **`/api/update/check`** (GET, `?branch=X`) — commits HEAD is behind `origin/X` (default: checked-out branch). `X` must pass `isValidBranch` (ref-safe name AND present in the branch list) or it is ignored
  - **`/api/update/apply`** (POST `{ branch }`) — same branch → `reset --hard` + `clean -fd` + `pull`; other branch → `fetch` + `checkout -f -B` onto the remote tip. Then `daemon-reload` + restart `fake-flipctl-node-server.service` via transient `systemd-run` (survives the restart). **Destroys every uncommitted change in `/flipperone-testing`** — commit + push before pressing Update on a device you develop on
  - **`/api/switch/flipctl`** (POST) — swaps the `/flipperone-testing/active-flipctl` symlink to the other variant (fake-flipctl ↔ fake-flipctl2), then restarts the node service. Client reloads via `/api/version` polling
  - **`/api/sound/files`** — list playable sound files
  - **`/api/sound/play`** (POST `{ file }`) — play a file
  - **`/api/sound/stop`** (POST) — stop playback
  - **`/api/sound/devices`** — list audio output devices
  - **`/api/sound/device`** (POST `{ device }`) — set default audio device
  - **`/api/sound/volume`** (GET) — current volume
  - **`/api/sound/volume`** (POST `{ control, volume }`) — set volume
  - **`/api/sound/restart-driver`** (POST) — restart the audio driver
- Systemd unit: `fake-flipctl-node-server.service` (lives in the sibling `fake-flipctl/` repo — units are shared; the active variant is picked via the `/flipperone-testing/active-flipctl` symlink)

### Client
- **Bitmap font** (`js/font.js`) — custom 5x7 pixel font, 6x8 cell (supports ASCII 32-126)
- **Canvas layer** (`js/canvas.js`) — drawing primitives (rect, text, line, pixel, frame)
- **Input layer** (`js/input.js`) — keyboard events mapped to actions (up/down/left/right/ok/back)
- **Scene manager** (`js/scene.js`) — stack-based push/pop scene navigation
- **UI components** (`js/ui.js`) — status bar (with battery icon + percentage, polls `/api/power` every 5s), menu list with highlight, scrollbar
- **App scenes** (`js/apps/`) — each screen is a scene with `render()` and `handleInput()`, returns `'pop'` from `handleInput` to go back

## Display

- Resolution: **256x144** pixels
- Colors: black and white only, grayscale accents
- Font: custom 5x7 bitmap font (`js/font.js`), 6x8 cell, pixel-perfect rendering via `fillRect`

## Input

- Keyboard only: Arrow keys, Enter (ok), Escape/Backspace (back)

## Running

```bash
sudo node server.js
```
Then open `http://localhost:8899` in a browser. Requires root for sysfs access. No build step needed.

### Cog browser on Flipper One

Cog has platform plugins: `wl` (Wayland), `drm`, `headless`. Available at `/usr/lib/aarch64-linux-gnu/cog/modules/`.

To force window size on KDE/Wayland, use KDE window rules in `~/.config/kwinrulesrc`:

```ini
[499e477a-c004-4eac-ba76-430ec6419c46]
Description=Settings for com.igalia.Cog
ignoregeometry=true
ignoregeometryrule=2
position=0,0
positionrule=2
screenrule=2
size=256,144
sizerule=2
wmclass=com.igalia.Cog
wmclassmatch=1

[General]
count=1
rules=499e477a-c004-4eac-ba76-430ec6419c46
```

### Kiosk mode (cage + cog, no KDE)

The goal is to run Cog directly on the 256x144 SPI LCD without KDE. Cog's DRM plugin (`-P drm`) only works with GPU-backed connectors (HDMI on card2), not the SPI panel on card0. The solution is **cage** — a minimal Wayland kiosk compositor that handles non-GPU displays and runs one app fullscreen.

Systemd units (in `systemd/`):
- **`fake-flipctl-node-server.service`** — Node.js HTTP server (port 8899, web UI + JSON APIs), requires root for sysfs
- **`fake-flipctl-wayland-cage.service`** — cage compositor + Cog browser on tty1, replaces getty, runs as `root` (required for `LIBSEAT_BACKEND=builtin` — libseat's builtin backend needs root to manage DRM/TTY directly, avoiding the need for seatd or a logind session)
- **`fake-flipctl.target`** — groups both services; enabled on `multi-user.target`

Install:
```bash
sudo cp systemd/*.service systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable fake-flipctl.target fake-flipctl-wayland-cage.service fake-flipctl-node-server.service
sudo reboot
```

DRM devices:
- `/dev/dri/card0` — SPI LCD panel (256x144, panel-mipi-dbi-spi)
- `/dev/dri/card2` — Rockchip GPU/HDMI (only used when external monitor connected)

## Live development workflow

Two sibling variants exist on the device:
- **`/flipperone-testing/fake-flipctl/`** — the "flipctl" variant
- **`/flipperone-testing/fake-flipctl2/`** — this repo, the "flipctl2" variant
- **`/flipperone-testing/active-flipctl`** — symlink pointing at whichever variant is currently active. The systemd service serves whatever this points to. Swap it via `POST /api/switch/flipctl`.

### Edit & reload cycle

1. Edit files in this directory
2. Reload the UI: `sudo systemctl restart cog-seat1.service`
3. The client auto-reloads when `/api/version` reports a new `SERVER_ID` after `fake-flipctl-node-server.service` restarts — no manual page refresh needed

## UI Sandbox

Isolated development environment for building and inspecting components from the component library without running the full app. Runs as its own Node server on a separate port, so editing sandbox-only code never touches the live app.

### Running

```bash
node ui-sandbox.js
```

Serves on **port 8900** (no root required, independent of the main app on 8899). Open `http://localhost:8900/`.

### Views

- **Library view** (default): grid of cards, one per registered component (name + short description). Click a card → detail view.
- **Detail view**: 3× zoomed 256×144 canvas with a light-gray/white checker background (so transparent pixels are visible), a 1-native-pixel grid overlay (toggleable), and auto-generated controls that match the selected component's `tweakables` schema. `← back to library` returns to the list.

### Files

- **`ui-sandbox.js`** — minimal static server. No API endpoints, no sysfs, no root.
- **`ui-sandbox.html`** — browser entry. Dark theme with Flipper orange (`#FF8200`) accent for controls.
- **`js/sandbox/main.js`** — registers the `COMPONENTS` list, renders library cards, handles list↔detail transitions, owns the render loop.
- **`js/sandbox/controls.js`** — schema-driven controls builder (see below).

### Registering a component for the sandbox

1. Add a static `tweakables` schema on the component (outside the IIFE):
   ```js
   MyComponent.tweakables = [
       { section: 'position' },
       { key: 'x', type: 'range', min: 0, max: 256, default: 0 },
       // ...
   ];
   ```
2. Add an entry to the `COMPONENTS` array in `js/sandbox/main.js`:
   ```js
   { name: 'MyComponent', ctor: MyComponent, description: 'What it does.' }
   ```
3. Ensure `ui-sandbox.html` loads the component file via `<script>` (in the component-library block at the bottom).

No other wiring needed — the sandbox instantiates the component with the schema's defaults, builds the controls UI, and mutates the instance on change.

### Tweakables schema

Each entry is one of:

| Entry | Produces |
| --- | --- |
| `{ section: 'name' }` | Starts a new panel with this title |
| `{ key, type: 'range', min, max, default, label? }` | Number slider with live value readout |
| `{ key, type: 'color', default, label? }` | Native color picker with hex readout |
| `{ key, type: 'bool',  default, label? }` | Checkbox |
| `{ key, type: 'enum',  options: [...], default, label? }` | Radio group |

- `key` supports dot paths (e.g. `'corners.tl'`). On change, the builder mutates the live instance directly via that path.
- `label` defaults to the key.
- For `enum`, `options` can be strings or numbers; their original type is preserved through `onChange`.

### Constraints & notes

- Components exposed to the sandbox should recompute layout inside `render()` (stateless). Components that cache computed state in an `_update()` method — like `MessageBox` — need setter-based mutation to stay correct; they're not currently in the sandbox registry.
- The sandbox canvas clears to **transparent** each frame (checker shows through). A component whose appearance depends on being drawn over a specific filled background (e.g. over a prior `canvas.clear('#fff')`) should either paint its own background or behave well on transparent — `ResponsiveFrame`'s body-only fill is the reference pattern here.
- Main app and sandbox load the **same** component file from `js/component-library/`. Both `server.js` and `ui-sandbox.js` serve from the project root. Edit once, reload both pages — behavior stays in sync.

## File: test-screen.html

Test pattern page for verifying LCD display alignment — draws 1px border, diagonal cross, center crosshair, and corner coordinate labels at native 256x144.

## Project Structure

```
fake-flipctl2/
├── server.js                      # Node.js HTTP server + API endpoints (main app, port 8899)
├── index.html                     # Main app entry point
├── ui-sandbox.js                  # Sandbox Node server (port 8900, no root) — see UI Sandbox
├── ui-sandbox.html                # Sandbox browser entry (component library + demo views)
├── test-screen.html               # Display test pattern
├── png-to-bitmap.py               # PNG → 6-bit grayscale sprite/icon converter
├── cog-drm-research.txt           # Notes on Cog DRM/Wayland setup
├── css/style.css                  # Layout, canvas scaling
└── js/
    ├── main.js                    # Bootstrap + render loop (requestAnimationFrame)
    ├── canvas.js                  # Drawing primitives (drawRect, drawFrame, drawSprite, _drawGrayscaleSprite)
    ├── font.js                    # 5x7 bitmap font data (legacy, small font)
    ├── haxrcorp16.js              # HaxrcorpFont16 — primary 5x7 font used across the UI
    ├── input.js                   # Keyboard event → action mapping
    ├── scene.js                   # Scene stack manager (push/pop)
    ├── ui.js                      # Status bar (battery, signal, tech, wifi, time) + shared components
    ├── icons.js                   # Icon definitions (re-exports from js/icons/icons.js)
    ├── sprites.js                 # Large sprite assets (dolphin, StatusBarBattery, etc.)
    ├── keyboard-blinking-cursor.js # Blinking cursor helper for text input
    ├── component-library/         # Reusable components — see Component Library & UI Sandbox sections
    │   ├── MessageBox.js          # Rounded speech-bubble dialog with tail indicator
    │   ├── ResponsiveFrame.js     # Configurable rect: fill, 1px stroke, per-corner rounding, anchor
    │   └── MenuSelectorFrame.js   # Menu selection frame (duplicate of ResponsiveFrame, diverging)
    ├── sandbox/                   # Sandbox boot + schema-driven controls builder
    │   ├── main.js                # Library list → component detail → render loop
    │   └── controls.js            # Builds UI from each component's .tweakables schema
    ├── icons/
    │   └── icons.js               # 6-bit grayscale icon data (network, system, testing, wifi_0..100, etc.)
    ├── running_apps.js            # Recents stack — open()/close()/list()/setSnapshot(); read by AppSwitcherScene
    └── apps/
        ├── desktop.js             # Desktop startup scene + Power flow + Wi-Fi card (see "Desktop additions")
        ├── menu.js                # Main menu (Network, Testing, Settings — no breadcrumb, no bottom buttons; keyboard-only navigation)
        ├── animated_icons.js      # Vertical sprite strips (e.g. settings_animated) played on SELECTED menu items
        ├── submenu.js             # Generic submenu handler
        ├── app_switcher.js        # Cover-flow Tab overlay — see "App Switcher" section
        ├── placeholder_app.js     # Generic full-PNG app scene; registers with RunningApps on enter, captures snapshot on exit
        ├── modem5g.js             # 5G modem info via /api/modem
        ├── diskspace.js           # Disk space via /api/disk
        ├── power.js               # Battery info via /api/power
        ├── routing.js             # Routing info via /api/routing
        ├── ethernet.js            # Ethernet list + verbose IfaceDetailModal (see "Ethernet verbose detail modal")
        ├── sound.js               # Sound menu: files, devices, volume, driver restart (via /api/sound/*)
        ├── update.js              # OTA update: branch dropdown (/api/update/branches) + check/apply
        ├── screentest.js          # Display test pattern scene
        ├── figma_live_preview.js  # Embeds a Figma prototype in a 256×144 iframe; shows a mix-blend "x2 to exit" hint
        └── boot_menu_ui_demo.js   # Complex UI demo with profiles, cloning, rename
```

Note: systemd units are **not** in this repo. They live in the sibling `/flipperone-testing/fake-flipctl/systemd/` and are shared between both variants via the `active-flipctl` symlink.

---

## Status Bar

### Layout
- **Height**: 13px (`STATUS_BAR_H` in `ui.js`)
- **Background**: Black (`#000`)
- **Top padding for all elements**: 3px (`STATUS_BAR_PAD_TOP`)
- **Foreground color**: White (`#fff`). Grayscale sprites preserve their
  internal shade relationships through the canvas alpha-blending path.
- **Left side** (conditional, laid out left-to-right via a `leftX` cursor):
  1. **5G signal bars + tech label** — only when modem reports
     `available: true`.
  2. **Wifi icon** — only when wifi is connected.
  3. **Ethernet icon** (`Icons.ethernet_statusbar`, 13×7) — only when at
     least one ethernet interface reports a `connected` state (and not
     `disconnected`).
  4. **Recording dot** (`Icons.records_status_bar`, 7×7 solid disc) — only
     while a voice-recorder take is rolling **in the background**, i.e.
     `window._voiceRecorderRecording && !window._voiceRecorderForeground`.
     Pulses via `drawSprite`'s `alphaScale` and self-drives repaints with
     `requestRender()`. See Voice recorder § Status-bar indicator.
- **Right side**: Battery percentage + battery sprite. Charging bolt
  overlays the battery sprite when `batteryCharging === true`.
- **No time/date** is rendered in this variant.

### 5G Signal Bars

**Visual Indicator** (left-side cursor, 2px initial padding):
- **5 vertical bars** with heights: 3, 4, 5, 6, 7px (left to right)
- **Width**: 1px each, 1px gap → 9px total span
- **`drawSignalBars(canvas, x, topY, quality)`** takes `topY` as the top
  of the *tallest* bar; all bars share a common bottom so shorter bars
  are bottom-aligned.

**Coloring**:
- **White (`#fff`)** — filled bars (`ceil(quality / 100 * 5)`)
- **`#ccc`** — empty bars. Kept intentionally as a "shade" tone rather
  than re-inverting, so the empty/filled contrast mirrors the light-mode
  palette.

**Visibility**: The whole block (bars + tech label) is skipped when
`modemAvailable === false`, which happens when `/api/modem` returns
`available: false` **or** the poll errors/times out.

**Source**: Polled from `/api/modem` every 1 second.

### Technology Label

**Display** (right of signal bars, 2px gap):
- **Format**: Technology abbreviation (5G, LTE, 3G, 2G, or combos like
  "5G+LTE")
- **Default**: `--` (never visible, since the whole block hides when no
  modem)
- **Font**: HaxrcorpFont16
- **Color**: `#fff`
- **Position**: `leftX` cursor after the signal bars, `y = top` (=3)

**Mapping**:
- `5gnr` → "5G"
- `lte` → "LTE"
- `umts/hspa/hsdpa/hsupa` → "3G"
- `gsm/gprs/edge` → "2G"
- Multiple techs joined with `+`

### Wifi Icon

**Display** (after modem block via `leftX` cursor, only when connected):
- **Size**: 7×7 sprite, rendered via `canvas.drawSprite(..., '#fff')`
- **Position**: `leftX`, `y = top` (=3)
- **Icon variants** (by `quality` 0–100):
  - `>= 80` → `Icons.wifi_100`
  - `>= 60` → `Icons.wifi_75`
  - `>= 40` → `Icons.wifi_50`
  - `>= 20` → `Icons.wifi_25`
  - else → `Icons.wifi_0`
- **Hidden** when `wifiConnected === false`

**Source**: Polled from `/api/wifi` every 2 seconds.

### Ethernet Icon

**Display** (after wifi via `leftX` cursor, only when connected):
- **Asset**: `Icons.ethernet_statusbar` (13×7, 6-bit grayscale)
- **Rendered** with `canvas.drawSprite(..., '#fff')`
- **Connected check**: `state.indexOf('connected') !== -1 && state.indexOf('disconnected') === -1` over all interfaces returned by `/api/ethernet`
- **Source**: Polled from `/api/ethernet` every 2 seconds

### Battery Icon + Charging Overlay

**Battery sprite** (right-aligned):
- **Asset**: `StatusBarBattery.sprite` (16×9, 6-bit grayscale)
- **`batteryX = canvas.w - 2 - 16`** → `238px`
- **`batteryY = top - 1`** → `2px` (raised 1px vs. the other elements
  so the visual center sits closer to the bar's optical midline)

**Battery level bar** (drawn inside the sprite):
- **Max**: 10px wide × 5px tall at 100%
- **`barX = 240`** (fixed)
- **`barY = top + 1`** → `4px` (2px from the sprite's top-left)
- **Color**: `#fff`

**Percentage text** (right-aligned to the battery sprite):
- **Font**: HaxrcorpFont16, color `#fff`
- **Position**: Right edge of the last glyph sits **1px left** of the
  battery sprite — computed with `textX = batteryX - 1 - HaxrcorpFont16.textWidth(pctStr)` (do **not** approximate with `pctStr.length * 6`; glyph widths vary).
- **Y**: `top - 2` (raised 1px vs. other elements for optical
  alignment with the battery sprite, matching the sprite's 1px rise)

**Charging overlay**:
- When `batteryCharging === true`, `Icons.charging_status_bar` (16×9)
  is drawn on top of the battery sprite at `(batteryX, batteryY)`
  (flush with sprite top-left).
- **Rendered via `canvas.drawSpriteLiteral`** (not `drawSprite`) so the
  three tones map as: dark source → black, bright source → white,
  `gray=63` sentinel → transparent (battery shows through around the
  bolt silhouette). See [Canvas Drawing Primitives](#basic-methods).

### Battery State

- **Default `batteryLevel`**: `-1` (unknown) → `--%` until the API
  responds.
- **Source**: `/api/power` polled every 5 seconds. `batteryCharging` is
  set when `status` is `'Charging'` or `'Full'`.

---

## Input Handling & Button Feedback

### Keyboard Mapping (input.js)
```
ArrowUp/i → 'up'      | ArrowDown/m → 'down'
ArrowLeft/j → 'left'  | ArrowRight/l → 'right'
Enter/k → 'ok'        | Escape/Backspace/n → 'back'
z → 'esc'             | x → 'edit'
c → 'power'           | v → 'view'
a → 'ptt'             | b → 'run'
h → 'appsw'
```

### Button Press/Release Cycle
```javascript
// When action maps to a button (via btnActionMap):
btn.press();                    // Set state to 'pressed' (visual feedback)
if (btn.onPress) btn.onPress(); // Execute callback (e.g., open new scene)
setTimeout(function() {
    btn.release();              // Reset state after 30ms
}, 30);
```

**Press-feedback timing** (authoritative, from code):
- **Bottom-bar buttons** (Left/Middle/Right): **30ms** release — used in `desktop.js`, `menu.js`, `submenu.js`
- **PopupMenuLeft item selection**: **150ms** before `onSelect` fires — gives the inverted (black fill + white text) press state time to render
- **Keyboard key press**: **150ms** before clearing the pressed row/col

The longer 150ms delay is intentional for popup/keyboard: the user is committing to a choice, so the press flash must be clearly visible. Bottom-bar buttons are fast (30ms) because the next scene is often about to replace the whole screen.

### Button Bar Layout
- **5 button slots** (48px each, 2px gap): `5 × 48 + 4 × 2 = 256px` exactly
- **Position 0**: Left button (flush left, optional)
- **Positions 1-3**: Middle buttons (center area, optional)
- **Position 4**: Right button (flush right, optional)

Example from Desktop scene:
```javascript
this.app_defined_buttons = [
    null,  // Slot 0 (left) - unused
    new UI.MiddleButton('Menu', 1, 48, 2, 'edit', callback),  // Slot 1
    null,  // Slot 2
    null,  // Slot 3
    null   // Slot 4 (right) - unused
];
```

## Sprite System (Large Bitmap Assets)

### Overview
For large images (>16×16), use the sprite system instead of icons:
- **sprites.js** — sprite asset definitions
- **canvas.drawSprite()** — render sprites of any size
- Data format: bitmap array with multiple hex values per row

### Creating Sprites
1. **Convert image** to monochrome (black/white) PNG, exact dimensions
2. **Generate bitmap data**:
   - Python script to convert PNG → hex array
   - Example: 150×114 needs 19 bytes/row (150 ÷ 8 rounded up)
3. **Generate with converter**:
```bash
python3 png-to-bitmap.py dolphin.png Dolphins > sprites.js
```

The converter properly handles semi-transparent pixels:
- Alpha blending with white background (50% alpha → 50% gray)
- Threshold at brightness 128 (< 128 → black, >= 128 → white)
- No dithering (preserves clean edges)

4. **Use in sprites.js**:
```javascript
var Dolphins = (function() {
    var sprite = {
        w: 150,
        h: 114,
        d: [
            0xff, 0xff, ..., // row 0 (19 bytes)
            0xff, 0xff, ..., // row 1 (19 bytes)
            // ... 114 rows total (6516 hex values)
        ]
    };
    return { sprite: sprite };
})();
```

### Drawing Sprites
```javascript
var spriteX = Math.floor((256 - Dolphins.sprite.w) / 2);  // center
var spriteY = 0;  // top of screen
canvas.drawSprite(Dolphins.sprite, spriteX, spriteY, '#000');
```

### 6-bit Grayscale Sprite System

For images with semi-transparent pixels, use **6-bit grayscale** (64 gray levels):

**Converter:** `png-to-bitmap.py`
```bash
python3 png-to-bitmap.py image.png VariableName > sprites.js
```

**How it works:**
1. Blend RGBA pixels with white background (semi-transparent → gray)
2. Map brightness (0-255) to 6-bit value (0-63)
3. Pack 4 pixels → 3 bytes
4. Render with variable opacity: `opacity = (63 - grayValue) / 63`

**Result:** 64 gray levels, semi-transparent pixels become visible gray tones

**Sprite object:**
```javascript
var VariableName = (function() {
    var sprite = {
        w: 150, h: 114,
        bitsPerPixel: 6,
        grayscale: true,
        d: [0xff, 0x8a, 0x14, ...]  // Packed 6-bit data
    };
    return { sprite: sprite };
})();
```

**Rendering in canvas.js:** Uses `_drawGrayscaleSprite()` method with alpha blending

### Example: Dolphin Sprite
- **Size**: 150×114 pixels
- **Format**: 6-bit grayscale (64 levels)
- **Features**: Semi-transparent edges preserved as gray tones
- **Render**: Desktop scene, top center

---

## Animated Icons

Animated icons are **vertical sprite strips**: the same 6-bit grayscale
format as regular sprites, but with all frames stacked top-to-bottom in
one `d` array.

**File**: `js/animated_icons.js`

**Shape**:
```javascript
var AnimatedIcons = (function() {
    var settings_animated = {
        w: 14,                 // width of each frame
        h: 140,                // TOTAL strip height (frameH × frames)
        frames: 10,            // frame count
        bitsPerPixel: 6,
        grayscale: true,
        d: [ /* ... */ ]       // packed 6-bit data, rows top-to-bottom
    };
    return { settings_animated: settings_animated };
})();
```

**Byte layout note (important):** the grayscale renderer reads 3 bytes
per 4-pixel group, so a row consumes `ceil(w/4) * 3` bytes — **not**
`ceil(w*6/8)`. For `w=14` that's 12 bytes/row, not 11. `drawSpriteFrame`
uses the correct formula so `frameIndex` lands on the right offset.

### Playback

Scenes drive animation by computing a frame index from wall-clock time
and calling `canvas.drawSpriteFrame`:

```javascript
var FRAME_MS = 200;  // 5 fps
var frameIndex = Math.floor(Date.now() / FRAME_MS) % sprite.frames;
canvas.drawSpriteFrame(sprite, x, y, frameIndex, '#000');
```

### MenuLine integration

`MenuLine` supports an optional `iconAnimated` property. When the line's
state is `SELECTED` or `PRESSED` **and** `iconAnimated` is set, the
strip plays at 5 fps; frame index is `(floor(elapsed / 200ms) + 1) %
frames` so the first highlighted frame is frame 1 (user-facing "frame
2"), not the static fallback. When unselected, the line draws the
static `icon` if present, or falls back to **frame 0 of the strip** if
only `iconAnimated` was supplied.

```javascript
var line = new MenuLine({
    text: 'Settings',
    icon: Icons.system,                              // static fallback
    iconAnimated: AnimatedIcons.settings_animated    // plays on highlight
});
```

### Driving redraws

The main loop throttles renders (it only redraws on input or every
`IDLE_REDRAW_MS = 250 ms`). For smooth animation, scenes should tick
more frequently:

- `main.js` exposes `window.requestRender()` — call it to force a redraw
  on the next rAF tick.
- `MenuScene.enter()` starts a `setInterval(200 ms)` that calls
  `window.requestRender()`; `exit()` clears it.

Any new scene that hosts time-driven animation should follow the same
pattern (start an interval in `enter`, clear it in `exit`).

---

# UI System Documentation

Complete guide to the fake-flipctl UI system for building new screens and components.

## Canvas & Display Specifications

### Resolution & Rendering
- **Dimensions**: 256px × 144px (width × height)
- **Type**: Monochrome (black & white) with grayscale accents
- **Rendering**: HTML5 Canvas, pixel-perfect (no antialiasing)
- **Scaling**: All elements rendered with sharp, crisp edges

### Safe Margins & Layout Zones
```
0–14px:       Header area (text + 5px top padding)
15–19px:      Spacing/divider
20–127px:     Menu items area (max 5 items visible at 19px each)
128–144px:    Button bar (5 button positions)
```

### Coordinate System
- **Origin**: Top-left (0, 0)
- **Left/Right margins**: 8px from canvas edges
- **Centered content width**: 240px (canvas 256px - 16px margins)

## Typography System

### Primary Font: HaxrcorpFont16
- **Glyph size**: 5×7 pixels
- **Cell size**: 6×8 pixels (5px + 1px kerning)
- **Row frame**: 11 rows × 8 bits (bit7 = leftmost pixel)
- **Supported**: ASCII 32–126 (printable ASCII)
- **Color**: Any hex color (passed as parameter)
- **API**: `HaxrcorpFont16.draw(ctx, text, x, y, color)`
- **Metrics**: `HaxrcorpFont16.textWidth(text)` → pixels
- **Used by**: status bar, submenu titles, most scenes

### Menu Font (default): BusyFont9
- **Cap height**: 9px (capital R spans 9 rows)
- **Row frame**: 14 rows × 16 bits (MSB = leftmost pixel; 2 bytes per
  row to accommodate glyphs up to 16px wide)
- **Generated from**: `/Users/vladpetrenko/Downloads/busy-regular_9px.ttf`
  rasterised at `size=15` (the PIL size at which caps render 9px tall)
- **Source file**: `js/busy9.js`
- **Supported**: ASCII 32–126
- **API**: same surface as HaxrcorpFont16 — `BusyFont9.draw(ctx, text, x, y, color)` and `BusyFont9.textWidth(text)`
- **Used by**: `MenuLine` in the `DEFAULT` state (unselected rows)

### Menu Font (highlighted): Born2bSportyV2Medium
- **Row frame**: 18 rows × 16 bits (MSB = leftmost pixel)
- **Source file**: `js/born2bsportyv2.js` (TTF at `/Users/vladpetrenko/Downloads/Born2bSportyV2.ttf`)
- **Supported**: ASCII 32–126
- **API**: `Born2bSportyV2Medium.draw(ctx, text, x, y, color)` / `.textWidth(text)`
- **Used by**: `MenuLine` in `SELECTED` and `PRESSED` states — labels and
  status text both swap to this font so the whole row reads as a single
  unit while highlighted.

See [Font Creation (TTF → bitmap)](#font-creation-ttf--bitmap) for the
conversion pipeline.

### Font Creation (TTF → bitmap)

New fonts live under `js/` as hand-generated `.js` modules emitted by
`ttf-to-js.py` at the project root (sibling of `png-to-bitmap.py`). The converter:

1. Loads the TTF at a chosen rasterisation size (pick whatever size
   makes the target cap height right — for `busy-regular_9px.ttf`,
   `SIZE = 15` gives a 9px capital R).
2. For each ASCII codepoint 32–126: rasterises onto a wide `L`-mode
   canvas at `(1, TEXT_Y)`, thresholds at `>= 128`, crops the leftmost
   whitespace column, then packs the first `ROWS` rows × `COLS` columns
   into integers (MSB = leftmost pixel).
3. Writes a `<Name> = (function() { ... })()` IIFE with `draw` and
   `textWidth`, matching `haxrcorp16.js`.

Key knobs inside the converter:

| Knob | Purpose |
|------|---------|
| `SIZE` | PIL rasterisation size. Pick to control cap height. |
| `ROWS` | Fixed row count per glyph. Must cover ascenders + descenders. |
| `COLS` | Bit width per row (8 or 16). Use 16 if any glyph is wider than 8px. |
| `TEXT_Y` | Row at which to draw the text on the canvas. Choose so that cap tops land where you want them. |

Wiring a new font into a scene:

1. Add `<script src="js/<name>.js"></script>` to `index.html` after
   `haxrcorp16.js`.
2. Replace `HaxrcorpFont16.draw` / `HaxrcorpFont16.textWidth` calls in
   the target scene with the new font's symbol.
3. If the font uses a different `ROWS` count than the old one, update
   the scene's `FONT_H` constant so vertical centring accounts for the
   new frame height (e.g. `menu.js` uses `FONT_H = 14` for BusyFont9).

## Color Palette

| Purpose | Color | Usage |
|---------|-------|-------|
| Background | `#ffffff` | Main canvas fill |
| Text/Borders | `#000` | Primary text, frames, icons |
| Dividers | `#EDEDED` | Menu item separator lines |
| Unselected | `#EAEAEA` | Dim state, accents |
| Overlay | `rgba(255, 255, 255, 0.75)` | Modal dialogs, keyboards |
| Disabled | `#CCC` | Disabled text, buttons |

## Visual Design System

This section consolidates the visual conventions used across all components. Values below are authoritative — taken directly from the code.

### Design Tokens (constants from `js/ui.js` + `js/apps/menu.js` + `js/canvas.js`)

| Token | Value | Source | Meaning |
|-------|-------|--------|---------|
| `STATUS_BAR_H` | 13px | `ui.js` | Status bar height (black bg) |
| `STATUS_BAR_PAD_TOP` | 3px | `ui.js` | Top padding for every foreground element in the bar |
| `ITEM_H` (simple list) | 12px | `ui.js` | Plain menu row height |
| `MenuLine.H` | 20px | `MenuLine.js` | Fixed height of every `MenuLine` (14px icon + 3px top + 3px bottom padding) |
| `MenuLine` icon inset | 3px | `MenuLine.js` | Icon padding from the line's left/top/bottom (`ICON_PAD`) |
| `MenuLine` icon→text gap | 4px | `MenuLine.js` | Gap between icon and label (`TEXT_GAP`) |
| `MenuLine` cap-top offset | 5px | `MenuLine.js` | Y of the first pixel of capitals inside the line (achieved via `TEXT_DRAW_Y = 2`) |
| `MenuLine` status right pad | 3px | `MenuLine.js` | Right padding for status text (`STATUS_PAD_R`) |
| `PAD_LEFT` | 4px | `ui.js` | Status bar + simple list text left padding |
| `SCROLLBAR_W` | 3px | `ui.js` | Scrollbar track width (dotted 1px line + 3px thumb centred on it) |
| `BTN_H` (bottom bar) | 14px | `canvas.js` | Height of LeftButton/MiddleButton/RightButton |
| `BTN_W` (bottom bar) | 48px | `menu.js` | Width of a single button slot (5 × 48 + 4 × 2 = 256) |
| `BTN_R` (bottom bar) | 4px | `canvas.js` | Top-corner radius on bottom-bar buttons |
| `POPUP_ITEM_H` | 13px | `ui.js` | Height of a row inside PopupMenuLeft |
| `POPUP_PAD` | 3px | `ui.js` | Inner padding of PopupMenuLeft |
| Keyboard `BTN_W` × `BTN_H` | 15 × 16px | `ui.js` | Virtual keyboard key cell |
| Keyboard container | 250 × 77px | `ui.js` | Overall keyboard box |

### Corner Radius Conventions

Only two radius values are used system-wide. `drawRoundRect` / `drawRoundFrame` support `r = 2` and `r = 3` only — anything else renders as a plain rectangle.

| Radius | Where it's used |
|--------|-----------------|
| **2px** | PopupMenuLeft item selection; legacy MenuItem selected/pressed |
| **3px** | MenuSelectorFrame (default `cornerRadius`) — used by the main menu selector |
| **3px** | Dialog boxes (DeleteConfirmDialog body) |
| **4px** | MessageBox corners (manual pixel routine), bottom-bar button top corners, keyboard container (`drawRoundRect(..., 4, bg)`) |
| *none (1px frame)* | `drawFrame` for InputField, TestScreen borders |

### Component State Styling

All interactive components expose four possible states: `default`, `selected`, `pressed`, `disabled`. Not every component uses all four.

**MenuLine** (`js/component-library/MenuLine.js`, owning scene paints the selector):

| State | Line-level visual | Selector frame (painted by scene) | Font |
|-------|-------------------|-----------------------------------|------|
| `default` | No frame. Icon + text in `#000`. | — | `BusyFont9` |
| `selected` | Icon + text still `#000`. Animated strip plays if `iconAnimated` is set. | `MenuSelectorFrame` outline (`showStroke: true`, `showFill: false`) around the line. | `Born2bSportyV2Medium` |
| `pressed` | Icon + text flip to `#fff`. Animation keeps advancing (clock preserved across `SELECTED ↔ PRESSED`). | Same `MenuSelectorFrame` instance but with `showFill: true`, `fillColor: '#000'` — drawn *behind* the line content, then the line is redrawn on top so the white content reads over the black fill. | `Born2bSportyV2Medium` |
| `disabled` | Not implemented. |

**Bottom-bar buttons** (`drawMiddleButton` / `drawLeftButton` / `drawRightButton`):

| State | Background | Foreground (text) | Border |
|-------|------------|-------------------|--------|
| `default` | `#ffffff` | `#000` | 1px `#000`, top corners rounded at r=4 (middle: both; left: top-right only; right: top-left only — outer edges run flush to the screen) |
| `pressed` | `#000` | `#fff` | Same border pattern |
| `disabled` | `#CCC` | `#999` | Same border pattern |

**PopupMenuLeft items** (`js/ui.js`):

| State | Visual |
|-------|--------|
| unselected | No highlight, text in `#000` |
| selected | `drawRoundFrame(..., 2, '#000')` — 1px outline |
| pressed | `drawRoundRect(..., 2, '#000')` — filled black, text in `#fff` (selection frame suppressed while pressed) |

**Rule of thumb for state styling** — the pattern is consistent across components:
- **Selection** = outline only (`drawRoundFrame`)
- **Press** = filled black + inverted text/icon (`drawRoundRect` + `#fff` foreground)
- **Disabled** = `#CCC` background, `#999` text

### Icon Sizing Conventions

| Size | Format | Used for |
|------|--------|----------|
| 14×14 | 6-bit grayscale | Menu icons (network, system, testing, router) — inset 3px from the MenuLine's left/top/bottom (line is 20px tall) |
| 16×9 | 6-bit grayscale | Status bar battery (`StatusBarBattery.sprite`) |
| 7×7 | 6-bit grayscale | Wifi icon variants (`wifi_0` … `wifi_100`) — fits in the 11px status bar |
| 5×7 | drawn primitives | Plug icon — hand-drawn via `drawRect` calls |
| 150×114 | 6-bit grayscale | Dolphin (full desktop splash) |

### Layout Zones (256×144 canvas)

```
y:   0 ─── 11     Status bar (white bg, battery right, signal/tech/wifi left, time center)
y:  11 ─── 13     2px divider gap
y:  13 ── 130     Content area (menu list, scene body)
                  ├─ Menu list: items at y = 13 + i * 19 (max 5-6 visible)
                  └─ Scrollbar: x = 253, w = 3, visible when items > viewport
y: 130 ── 144     Bottom button bar (BTN_H = 14, 5 × 48px slots + 4 × 2px gaps)
```

Horizontal margins: **8px** on left/right for centered content (giving 240px usable width — same as `ITEM_W`).

### Press-feedback Timing (see also Button Press/Release Cycle)

| Context | Duration | Rationale |
|---------|----------|-----------|
| Bottom-bar button | **30ms** | Next scene usually replaces the view; keep it snappy |
| PopupMenuLeft item | **150ms** | User is committing to a choice — flash must be visible |
| Keyboard key | **150ms** | Same reason: confirm the character was captured |

### Invariants

- Everything renders on pixel boundaries — no antialiasing, no fractional coordinates.
- Black-on-white is the default; inversion (white-on-black) only for pressed/confirmed state.
- Dividers are never black — they're always `#EDEDED` so they sit quietly behind content.
- Selection never fills — always an outline. Filling is reserved for commit/press.
- Any rounded shape uses `r ∈ {2, 3, 4}` — no arbitrary radii.

## Canvas Drawing Primitives

### Basic Methods
```javascript
canvas.clear(color)                              // Fill entire canvas
canvas.drawRect(x, y, w, h, color)              // Filled rectangle
canvas.drawFrame(x, y, w, h, color)             // Rectangle outline (1px)
canvas.drawRoundRect(x, y, w, h, radius, color) // Rounded filled rect
canvas.drawRoundFrame(x, y, w, h, radius, color)// Rounded outline
canvas.drawHLine(x, y, length, color)           // Horizontal line
canvas.drawVLine(x, y, length, color)           // Vertical line
canvas.drawIcon(iconData, x, y, color)          // 14×14 bitmap icon
canvas.drawCursor(x, y, w, h, color)            // Text cursor indicator

// Sprite variants
canvas.drawSprite(sprite, x, y, color[, alphaScale])      // Full sprite (binary or 6-bit grayscale, alpha-blended)
canvas.drawSpriteFrame(sprite, x, y, frameIndex, color)   // One frame of a vertical strip (sprite has `frames` count)
canvas.drawSpriteLiteral(sprite, x, y)                    // Three-tone overlay: paint each pixel at its own grayscale value; gray=63 = transparent sentinel

// Text is rendered via font object, NOT canvas directly
HaxrcorpFont16.draw(canvas.ctx, text, x, y, color)
BusyFont9.draw(canvas.ctx, text, x, y, color)
```

**When to use each sprite method:**
- `drawSprite` — standard foreground-on-background rendering. Uses
  `opacity = (63 - grayValue) / 63`, so dark source pixels become
  opaque in the chosen `color`. Good for single-tone icons that should
  adopt the scene's ink colour. Optional `alphaScale` (default 1)
  uniformly fades the whole sprite — grayscale path only; used for the
  status-bar recording pulse (see Voice recorder § Status-bar indicator).
- `drawSpriteFrame` — same rendering as `drawSprite`, but crops to one
  frame of a vertically-stacked strip (see [Animated Icons](#animated-icons)).
- `drawSpriteLiteral` — preserves the original pixel values. Dark
  stays dark, light stays light, `gray=63` skips the pixel entirely so
  whatever was drawn underneath shows through. Use for multi-tone
  overlays (e.g. the charging bolt that must sit on top of another
  sprite without taking on the scene's foreground colour).

### Common Patterns
```javascript
// Centered text
var textWidth = HaxrcorpFont16.textWidth('Title');
var x = Math.floor((256 - textWidth) / 2);
HaxrcorpFont16.draw(canvas.ctx, 'Title', x, 10, '#000');

// Right-aligned text (within 240px content)
var x = 8 + 240 - HaxrcorpFont16.textWidth(text) - 6;
HaxrcorpFont16.draw(canvas.ctx, text, x, y, '#000');

// Bordered box with content
canvas.drawFrame(x, y, w, h, '#000');
HaxrcorpFont16.draw(canvas.ctx, label, x + 5, y + 5, '#000');
```

## Architecture & Scene System

### One-Way Data Flow
```
Input (keyboard)
    ↓
scene.handleInput(action)  ← Process & update state
    ↓
state changes trigger next frame
    ↓
scene.render(canvas)       ← Read state, draw UI
    ↓
Canvas display updated
```

### Scene Interface
Every scene must implement:
```javascript
function MyScene() {
    this.items = [];           // State
    this.selectedIndex = 0;
    this.popup = null;
}

MyScene.prototype.enter = function() {
    // Called when scene becomes active
};

MyScene.prototype.exit = function() {
    // Called when scene is popped
};

MyScene.prototype.handleInput = function(action) {
    // Handle input: 'up', 'down', 'ok', 'back', 'esc', 'run'
    // Return 'pop' to go back to previous scene
    if (action === 'back') return 'pop';
};

MyScene.prototype.render = function(canvas) {
    // Draw all UI for this screen
    // Called every frame (60 FPS target)
};
```

### Input Priority (Highest to Lowest)
1. **Keyboard** (text input active) → captures all input
2. **Dialog** (confirmation dialog) → handles up/down/ok/back
3. **Popup** (action menu) → handles navigation + selection
4. **Scene** (normal mode) → handles menu navigation + scene actions

### Input Actions
```javascript
'up'    // Navigate up, previous item
'down'  // Navigate down, next item
'left'  // Navigate left, previous option
'right' // Navigate right, next option
'ok'    // Confirm, select item, press character
'back'  // Delete character, undo, go back
'esc'   // Cancel, force close
'run'   // Execute primary action, submit
```

### Button Management Pattern
```javascript
// Buttons mapped to actions via KEY_MAP
if (btn && btn.action) {
    btn.press();  // Visual feedback
    setTimeout(function() {
        btn.release();
        if (btn.onPress) btn.onPress();
    }, 30);  // 30ms — see Press-feedback timing section
}
```

## Component System

### Component Base Pattern
All UI components follow state-based rendering:

```javascript
function MyComponent(options) {
    this.x = options.x;
    this.y = options.y;
    this.w = options.width;
    this.h = options.height;
    this.state = 'default';  // default, selected, pressed, disabled
}

MyComponent.prototype.render = function(canvas) {
    if (this.state === 'pressed') {
        canvas.drawRect(this.x, this.y, this.w, this.h, '#000');
    } else {
        canvas.drawFrame(this.x, this.y, this.w, this.h, '#000');
    }
};

MyComponent.prototype.press = function() {
    if (this.state !== 'disabled') this.state = 'pressed';
};

MyComponent.prototype.release = function() {
    if (this.state !== 'disabled') this.state = 'default';
};
```

### Built-in Components

#### MenuLine
Shared single-row menu component in [`js/component-library/MenuLine.js`](js/component-library/MenuLine.js). Replaces the old per-scene `MenuItem` class. Designed to be reused by the main menu today and submenus/other lists in the future.

- **Properties** (constructor options): `text`, `width` (default 224), `icon` (optional static), `iconAnimated` (optional vertical strip), `status` (optional right-aligned label / `< ON >` / `< OFF >`)
- **Dimensions**: `width × 20px` (`MenuLine.H = 20` — 14px icon + 3px top + 3px bottom padding)
- **Internal layout** (relative to the line's top-left):
  - Icon at `(3, 3)` with 3px L/T/B padding (icon expected 14×14)
  - Text 4px right of the icon; text draw `y = 2` so the capital-letter top lands at line `y = 5`
  - Status text right-aligned at `x + w - 3`
- **States**: `MenuLine.STATE_DEFAULT` / `STATE_SELECTED` / `STATE_PRESSED`
- **Font swap**: `BusyFont9` in `DEFAULT`, **`Born2bSportyV2Medium`** in `SELECTED` and `PRESSED`.
- **Icon mode** (three-tier):
  1. `SELECTED` or `PRESSED` **and** `iconAnimated` set → the strip plays at `FRAME_MS = 200ms` (5 fps). Frame index is `(floor(elapsed / FRAME_MS) + 1) % frames` so the first visible frame after highlight is frame 1 (user-facing "frame 2"), not the static fallback.
  2. `this.icon` present → standard sprite / icon.
  3. Only `iconAnimated` present → frame 0 of the strip is drawn as the static fallback for unselected lines (so you don't need a separate static asset).
- **`_selectedAt` timestamp**: stamped on the first render where the line is in an "active" state (SELECTED or PRESSED), cleared on transition to DEFAULT. Kept across the `SELECTED ↔ PRESSED` transition so the press flash picks up the animation at its current frame instead of rewinding.
- **The SELECTED/PRESSED frame is NOT painted by MenuLine.** The owning scene renders a `MenuSelectorFrame` around the selected line — this decouples the selector's geometry (e.g. `232×22` at `x=10` in the main menu) from the line's content area (`224×20` at `x=16`). `PRESSED` only inverts the line's own text/icon colours to white so they read over the black fill the scene paints behind them.
- **Render**: `menuLine.render(canvas, x, y)`

### Main Menu scene

Implemented in `js/apps/menu.js` as `MenuScene`. Sets the reference
layout that `MenuLine` + `MenuSelectorFrame` are designed around.

**Container** (top-left anchor):
- `CONTAINER_X = 16`, `CONTAINER_Y = 24` (below the 13px status bar with
  11px of breathing room — the breadcrumb bar was removed, this gap is
  intentional)
- `CONTAINER_W = 224` (`256 − 16 − 16`)
- No background fill of its own; the canvas clear is `#fff`

**Items**: `MenuLine` instances stacked flush inside the container with
a 1px gray (`#CCCCCC`) horizontal divider between each adjacent pair.
No divider above the first visible line, none below the last. Dividers
always sit **beneath** the selector frame.

**Current item list** (in order):
`Network, Files, Apps, Testing, Settings, Router` — this is treated as
the maximum list size; the spec is "6 items, scroll to reveal any
beyond the viewport."

**Selector frame** — one `MenuSelectorFrame` reused across frames:
| Knob | Value | Meaning |
|------|-------|---------|
| `SELECTOR_X` | 10 | Absolute X; overshoots the container's 16px left pad by 6px |
| `SELECTOR_W` | 232 | Extends 2px past the container's right edge |
| `SELECTOR_H` | 22 | 2px taller than the 20px line |
| `SELECTOR_Y_OFFSET` | `-1` | Vertical inset so the 22px frame sits centred over the 20px line |
| `showStroke` | `true` | Always on |
| `showFill` | toggled per-frame | `true` during `PRESSED` (filled black), `false` otherwise |

**Viewport + scroll**:
- `VISIBLE_COUNT = 5` lines
- `VIEWPORT_H = 104` (5 × 20 + 4 dividers)
- Viewport starts at `CONTAINER_Y`; items outside it are skipped during
  render.
- Navigation wraps — `down` past the last item jumps to the first and
  `up` past the first jumps to the last (`_ensureVisible()` then
  adjusts `scrollOffset` so the new selection lands on screen).

**Scrollbar** (uses the shared `UI.Scrollbar`):
| Knob | Value |
|------|-------|
| `SCROLLBAR_X` | 253 (3px-wide thumb centred → cols 252..254) |
| `SCROLLBAR_Y` | 15 (2px below the 13px status bar) |
| `SCROLLBAR_H` | 127 (reaches to `y = 141` — 2px above the canvas bottom) |
| `SCROLLBAR_THUMB_PAD` | 1 — ensures the thumb stays ≥3px from both the status bar and the canvas bottom |

**Press flash** — `ok` / `run` feedback:
1. On keypress: selected line's state flips to `PRESSED`; a redraw is
   requested immediately.
2. `render` paints the selector frame filled black behind the line,
   then redraws the (now inverted) line on top so its `#fff` content
   sits over the black fill.
3. `setTimeout(30 ms)` flips the state back to `SELECTED` and calls
   the submenu factory. If the factory returns a scene it's pushed;
   returning `null` is a no-op (used today for `Files`, `Apps`,
   `Router` — empty stubs).

**Animation tick**: `enter()` starts a `setInterval(200 ms)` that calls
`window.requestRender()`; `exit()` clears it. See
[Animated Icons → Driving redraws](#driving-redraws).

#### Buttons: LeftButton, MiddleButton, RightButton
- **Width**: 48px each, 2px gap between (5 × 48 + 4 × 2 = 256px exact)
- **Height**: **14px** (`BTN_H` in `canvas.js`) — sits flush at the bottom of the 144px canvas (`y = 130`)
- **Top-corner radius**: 4px
  - `MiddleButton` — both top corners rounded
  - `LeftButton` — only top-right corner (flush to screen left edge)
  - `RightButton` — only top-left corner (flush to screen right edge)
- **States & colors** (see [Component State Styling](#component-state-styling) for the full table):
  - `default` — bg `#ffffff`, text `#000`, 1px `#000` border
  - `pressed` — bg `#000`, text `#fff`, same border
  - `disabled` — bg `#CCC`, text `#999`, same border
- **Properties**: `text`, `action` (`'ok'`, `'run'`, `'esc'`, etc.), `onPress` callback
- **Render**: `btn.render(canvas)`

#### Scrollbar
- **When visible**: `totalItems > visibleItems`
- **Components**: dotted track line (full `(y, height)` range) + solid 3px-wide thumb
- **Calculation**: `thumbHeight = max(5, round(thumbRange * visibleItems / totalItems))`; `thumbY = y + thumbPad + round((thumbRange - thumbHeight) * scrollRatio)` where `thumbRange = height - 2 * thumbPad`
- **Position**: x ≈ 251–253, leaving 1px clearance from right edge
- **Render**: `scrollbar.render(canvas, x, y, height, thumbPad = 0)` — the optional `thumbPad` inset keeps the thumb `thumbPad` pixels away from each end of the dotted line (useful when the track sits near the status bar or canvas edge). The dotted line itself always fills the full range.

#### PopupMenu
- **Items**: List of action strings ('Delete', 'Rename', 'Clone', etc.)
- **Navigation**: Up/down arrows, ok to select, esc to close
- **Overlay**: Semi-transparent white (75% opacity)
- **Render**: `popup.render(canvas)` + overlay in scene

#### DeleteConfirmDialog (Generic Confirmation)
- **Properties**: Item name, action type ('Delete' or 'Reset to default')
- **Buttons**: Cancel / Confirm with toggle (left/right arrows)
- **Render**: `dialog.render(canvas)` + overlay in scene
- **Callbacks**: `onConfirm()`, `onCancel()`

#### Virtual Keyboard
- **Layout**: QWERTY 3-row layout with special characters
- **Navigation**: Arrow keys within grid, ok to select character
- **Input**: Text accumulates in `inputText`, backspace via `\b` character
- **Render**: `keyboard.render(canvas)` + overlay in scene

#### TextInputBox & InputField
- **TextInputBox**: Header showing action ("Edit item name", "Rename item")
- **InputField**: Bordered box for text input with optional error message
- **Features**: Blinking cursor, real-time validation, error display

#### MessageBox
Dialog box component with rounded corners, dynamic sizing, and fixed tail indicator.

**Features:**
- Dynamic width/height based on text content (max 25 characters per line)
- Rounded corners (4px radius) with pixel-perfect rendering
- Fixed tail indicator on left side (completely independent of frame position)
- Text wrapping and newline support (`\n` for explicit line breaks)
- Screen boundary clamping (no overflow)

**Constructor:**
```javascript
var messageBox = new MessageBox({
    text: "Your message here\nWith multiple lines",
    tailX: 113,        // Horizontal position of tail (left edge)
    tailY: 82,         // Vertical position of tail
    bottomY: 86        // Fixed bottom edge position (frame aligns to this)
});
```

**Properties:**
- `padding`: 6px (internal spacing)
- `radius`: 4px (corner radius)
- `maxLineLength`: 25 characters per line
- `textRightPadding`: 12px from right edge of screen

**Methods:**
- `render(canvas)` — Draw the component
- `setText(newText)` — Update text content and recalculate layout
- `setTailPosition(x, y)` — Move tail independently

**Rendering Details:**
- **White background** with black 1px border
- **Tail indicator** (fixed position, independent of frame):
  - Black horizontal strip (10px wide, 1px high)
  - Black staircase pattern (8×8) ascending left to right above the strip
  - White vertical line (1px wide, 8px high) covering the border junction
- **Text rendering** uses HaxrcorpFont16 with automatic word wrapping

**Key Behavior:**
- Frame attaches to tail (positioned at `tailX + tailStripWidth`)
- Frame width/height adjust based on text content
- Frame position clamps to screen boundaries (6px padding from right edge)
- Tail remains completely fixed at specified position regardless of frame size
- Text max width is 25 characters; longer lines wrap to next line

**Example Usage:**
```javascript
// In DesktopScene constructor:
this.messageBox = new MessageBox({
    text: "Hello, I'm totally Fake",
    tailX: 113,
    tailY: 82,
    bottomY: 86
});

// In render method:
this.messageBox.render(canvas);

// Update text dynamically:
this.messageBox.setText("New message here");
```

#### ResponsiveFrame
Configurable rectangular frame — fill, optional 1px stroke, per-corner rounded corners, 3×3 anchor. Used as a building block for menus, cards, and selection highlights.

**File:** `js/component-library/ResponsiveFrame.js`
**Sandbox:** registered — full live-tweakable controls.

**Features:**
- Fill color (any CSS color)
- Optional 1px stroke, independent color, toggleable
- Per-corner rounded corners, radius 0/3/4 px, each of the four corners can be enabled or disabled individually
- Anchor: `anchorH` (`left`/`center`/`right`) × `anchorV` (`top`/`center`/`bottom`) — `(x, y)` represents the chosen anchor point on the frame, not a fixed top-left

**Constructor:**
```js
var frame = new ResponsiveFrame({
    x: 6, y: 6,
    width: 244, height: 22,
    fillColor:   '#ffffff',
    strokeColor: '#000000',
    showStroke:  true,
    cornerRadius: 3,
    corners: { tl: true, tr: true, bl: true, br: true },
    anchorH: 'left',
    anchorV: 'top'
});
```

Any omitted option falls back to the constructor default.

**Methods:**
- `render(canvas)` — draw the frame
- `setPosition(x, y)`, `setSize(w, h)`
- `setFillColor(c)`, `setStrokeColor(c)`, `setShowStroke(bool)`
- `setCornerRadius(r)`, `setCorner(which, enabled)` — `which` is `'tl' | 'tr' | 'bl' | 'br'`
- `setAnchor(h, v)` — pass a falsy value to keep a dimension unchanged

**Rendering approach (important):**
Paints **only the body pixels** of the rounded rectangle, row by row, using per-corner insets. Cut-corner pixels are never touched, so whatever was already on the canvas at those positions shows through naturally. This works in every context — transparent sandbox canvas, white desktop, or any mixed content underneath — without the component needing to know what's behind it.

**Stroke:**
- Straight top/bottom/left/right edges are painted between the rounded corner regions.
- Each enabled rounded corner gets a 1-pixel diagonal border (at `dx + dy == r - 1`, mirrored per orientation).
- Disabled corners get a square stroke corner via the adjacent straight edges meeting at the full rect corner.
- `showStroke: false` skips all stroke drawing.

#### MenuSelectorFrame
Selection frame for menu rows. Descendant of `ResponsiveFrame` with the same API (`x`, `y`, `width`, `height`, `anchorH`/`anchorV`, `showStroke`, `showFill`, `strokeColor`, `fillColor`, `cornerRadius`, `corners`), plus selector-specific embellishments.

**File:** `js/component-library/MenuSelectorFrame.js`
**Sandbox:** registered.

**Selector-specific flourishes (always painted, on top of the stroke):**
- **Bottom-right shadow pair** — a 1px horizontal segment at `y + h` and a 1px vertical segment at `x + w`, both using `strokeColor`. Each is `w - 2*r + 1` / `h - 2*r + 1` long so it meets the BR corner stair.
- **Two corner pixels at the bottom-right** — painted in the rounded-corner cut region at `(x + w − 2, y + h − 1)` and `(x + w − 1, y + h − 2)`. They thicken the BR corner visually and connect the shadow to the frame.
- Defaults: `cornerRadius = 3`, `showStroke = true`, `showFill = false` (transparent interior — the owning scene sets `showFill=true` only for the press-flash path).

**Main menu integration:** see [Main Menu scene](#main-menu-scene) for the specific geometry (`232×22` at `x=10`, `SELECTOR_Y_OFFSET = -1`) and the `showFill` toggle during the 30 ms press flash.

### Component Composition Pattern
```javascript
function MenuScene() {
    // Core components
    this.items = [...];                          // Array of MenuLine
    this.scrollbar = null;                       // Optional scrollbar
    this.buttons = {
        edit: new MiddleButton(...),
        cancel: new LeftButton(...),
        run: new RightButton(...)
    };

    // Modal components (mutually exclusive)
    this.popup = null;          // Action menu
    this.deleteConfirmDialog = null;
    this.keyboard = null;       // Text input
}

MyScene.prototype.render = function(canvas) {
    // 1. Render background/header
    canvas.clear('#ffffff');
    HaxrcorpFont16.draw(canvas.ctx, 'Menu Items', centerX, 5, '#000');

    // 2. Render main content (menu items)
    for (var i = 0; i < visibleItems; i++) {
        this.items[i + viewportStart].render(canvas, itemX, itemY);
    }

    // 3. Render optional scrollbar
    if (this.scrollbar && this.scrollbar.shouldShow()) {
        this.scrollbar.render(canvas, scrollbarX, startY, height);
    }

    // 4. Render modal components (overlay first, then component)
    if (this.popup) {
        canvas.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        canvas.ctx.fillRect(0, 0, 256, 144);
        this.popup.render(canvas);
    }

    if (this.keyboard) {
        canvas.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        canvas.ctx.fillRect(0, 0, 256, 144);
        this.keyboard.render(canvas);
    }

    // 5. Render buttons
    Object.values(this.buttons).forEach(function(btn) {
        btn.render(canvas);
    });
};
```

## Common Patterns & Solutions

### Viewport & Scrolling
```javascript
// Ensure selected item stays visible
var itemHeight = 19;
var visibleItems = Math.floor(107 / itemHeight);  // 5 max

if (this.selectedIndex < this.viewportStart) {
    this.viewportStart = this.selectedIndex;
} else if (this.selectedIndex >= this.viewportStart + visibleItems) {
    this.viewportStart = this.selectedIndex - visibleItems + 1;
}

// Bounds check
this.viewportStart = Math.max(0, this.viewportStart);
var maxViewport = Math.max(0, totalItems - visibleItems);
this.viewportStart = Math.min(this.viewportStart, maxViewport);
```

### Input Validation During Typing
```javascript
onKeyChar: function(char) {
    if (char === '\b') {
        this.inputText = this.inputText.slice(0, -1);
    } else {
        this.inputText += char;
    }

    // Real-time validation
    this._checkNameDuplicate();
    this._updateSaveButtonState();
};

_checkNameDuplicate: function() {
    this._inputError = '';
    for (var i = 0; i < this.items.length; i++) {
        if (this.items[i] !== this._renamingItem && 
            this.items[i].text === this.inputText) {
            this._inputError = 'Name already exists';
            this._saveBtn.disabled = true;
            return;
        }
    }
    this._saveBtn.disabled = false;
};
```

### Clone Naming Strategy
1. **First clone**: Add date suffix ("Router Jun 9")
2. **Repeated clone with same date**: Switch to [N] numbering ("Router Jun 9 [2]")
3. **Keep incrementing**: Auto-increment [N] when date exists
4. **Prevent conflicts**: Check all existing names before confirming

### Modal Overlay Rendering
```javascript
// Scene handles modal visibility
if (this.keyboard || this.popup || this.dialog) {
    // Draw semi-transparent overlay
    canvas.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    canvas.ctx.fillRect(0, 0, canvas.w, canvas.h);

    // Draw modal component on top
    if (this.keyboard) this.keyboard.render(canvas);
    if (this.popup) this.popup.render(canvas);
    if (this.dialog) this.dialog.render(canvas);

    // Render limited buttons (only applicable to current modal)
    this._closeBtn.render(canvas);
    this._saveBtn.render(canvas);
    return;  // Don't render background content
}
```

## Design Principles

1. **Simplicity**: Monochrome enforces minimal design; focus on clear hierarchy
2. **Efficiency**: Pixel-perfect rendering, no gradients/shadows, optimal canvas updates
3. **Consistency**: Same font, colors, spacing across all components
4. **Accessibility**: High contrast (black on white), consistent input patterns
5. **Responsiveness**: Viewport adjusts for long lists, buttons disable on validation error

## Creating New Scenes

### Step 1: Define Structure
```javascript
function MyScene() {
    // State
    this.items = [...];
    this.selectedIndex = 0;
    // UI components
    this.popup = null;
    this.keyboard = null;
    // Buttons
    this.editBtn = new MiddleButton(...);
}
```

### Step 2: Implement Core Methods
```javascript
MyScene.prototype.enter = function() { /* init */ };
MyScene.prototype.exit = function() { /* cleanup */ };

MyScene.prototype.handleInput = function(action) {
    if (this.keyboard) {
        // Handle keyboard input
    } else if (action === 'up') {
        // Handle navigation
        this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
    } else if (action === 'back') {
        return 'pop';  // Go back
    }
};

MyScene.prototype.render = function(canvas) {
    canvas.clear('#ffffff');
    // Draw UI based on state
    for (var i = 0; i < this.items.length; i++) {
        this.items[i].render(canvas, x, y);
    }
    // Render buttons, popups, etc.
};
```

### Step 3: Register in main.js
```javascript
// Add to initial scene stack
var menuScene = new MenuScene();
SceneManager.push(menuScene);
```

## Best Practices

✅ **DO**: Keep components pure (render depends only on state)
✅ **DO**: Calculate positions dynamically (don't hardcode)
✅ **DO**: Use modulo for circular navigation
✅ **DO**: Validate state before rendering
✅ **DO**: Handle input priority (keyboard → dialog → popup → scene)

❌ **DON'T**: Modify state during render()
❌ **DON'T**: Create new objects every frame
❌ **DON'T**: Hardcode colors and sizes
❌ **DON'T**: Use timers directly in components
❌ **DON'T**: Block render loop for long operations

## Performance Target

- **Frame rate**: 60 FPS (16.7ms per frame)
- **Render budget**: Complete within frame time
- **Input latency**: Respond within 1 frame (~16ms)

Profile with: `performance.now()` before/after `scene.render(canvas)`

---

# Icon System (6-bit Grayscale)

## Overview

The icon system uses **6-bit grayscale format** (64 gray levels) to preserve smooth anti-aliased edges from PNG source files. This is identical to the sprite system used for large assets like the Dolphins.

**Key Features**:
- 6 bits per pixel = 64 gray levels (0=white, 63=black)
- 4 pixels packed into 3 bytes (24 bits total)
- Smooth transparency and semi-transparent anti-aliased edges
- Perfect for small UI icons (14×14, 16×16, etc.)

## Why 6-bit Grayscale?

PNG icons are typically designed with anti-aliasing for smooth appearance:
- Edges have semi-transparent pixels (alpha 50-200) 
- Creates smooth transitions instead of hard edges
- Simple binary (black/white) conversion **loses** these edges

**Solution**: 6-bit grayscale preserves the full range:
- Semi-transparent pixels → gray values → smooth edges ✨
- Multiple opacity levels rendered with `globalAlpha`
- Supports colors in pressed/highlighted states

## Icon Files

### Main Menu Icons

Located in: `/fake-flip-ctl/icons/main_menu/`

**PNG Source Files** (14×14 pixels):
- `14_px_network.png` — Network/connectivity symbol (antenna/wifi)
- `14_px_system.png` — System/settings icon (gear-like)
- `14_px_testing.png` — Testing/tools icon (wrench-like)

All PNG files:
- RGBA color mode with transparent background
- Anti-aliased edges (semi-transparent pixels)
- Black foreground color

### JavaScript Icon Definitions

Located in: `js/icons.js` 

**Format**:
```javascript
var network = {
    w: 14,
    h: 14,
    bitsPerPixel: 6,        // ← 6 bits per pixel
    grayscale: true,        // ← Grayscale mode
    d: [
        0xff, 0xff, 0xff, ...,  // Packed hex bytes
        0xf0  // row N
    ]
};
```

**Properties**:
- `w`, `h` — Icon dimensions in pixels
- `bitsPerPixel: 6` — 6-bit grayscale format
- `grayscale: true` — Enables grayscale rendering
- `d` — Data array of packed hex bytes

## Converting Icons

### Using the Grayscale Converter

Location: `/fake-flip-ctl/png-to-bitmap.py`

**Basic usage**:
```bash
cd /fake-flipctl/icons
python3 /path/to/png-to-bitmap.py image.png variable_name
```

**Example**:
```bash
python3 /flipperone-testing/fake-flipctl2/png-to-bitmap.py main_menu/14_px_network.png network_grayscale
```

**Output**:
```javascript
var network_grayscale = (function() {
    var sprite = {
        w: 14,
        h: 14,
        bitsPerPixel: 6,
        grayscale: true,
        d: [
            0xff, 0xff, ..., 0xf0
        ]
    };
    return { sprite: sprite };
})();
```

### Converter Algorithm

1. **Load PNG as RGBA** — Preserves alpha channel
2. **Blend with white background** — For each pixel: `color * alpha + white * (1 - alpha)`
3. **Convert to 6-bit** — Brightness (0-255) → 6-bit value (0-63): `brightness >> 2`
4. **Pack 4 pixels** — 4 × 6-bit values → 3 bytes

**Packing format**:
```
Byte 0: [pixel0: 6 bits][pixel1: 2 MSBs]
Byte 1: [pixel1: 4 LSBs][pixel2: 4 MSBs]
Byte 2: [pixel2: 2 LSBs][pixel3: 6 bits]
```

### Creating New Icons

**Step 1: Design the icon**
- Create 14×14 or 16×16 PNG
- Use RGBA with transparent background
- Apply anti-aliasing for smooth edges
- Use black (#000) for the icon shape

**Step 2: Convert**
```bash
python3 png-to-bitmap.py my_icon.png my_icon_name
```

**Step 3: Add to icons.js**
```javascript
var myIcon = {
    w: 14,
    h: 14,
    bitsPerPixel: 6,
    grayscale: true,
    d: [ ... ]  // From converter output
};

return {
    network: network,
    myIcon: myIcon,  // ← Add here
    // ...
};
```

**Step 4: Use in scenes**
```javascript
// Inside a MenuScene
this.items.push(new MenuLine({
    text: 'My Item',
    icon: Icons.myIcon
}));

// Or directly in custom rendering
canvas.drawSprite(Icons.myIcon, x, y, '#000');  // Black
canvas.drawSprite(Icons.myIcon, x, y, '#fff');  // White (for pressed state)
```

## Rendering Icons

### In Menu Lines

**File**: `js/component-library/MenuLine.js`

Icons are rendered at a fixed 3px inset from the line's top-left; the
line picks between static and animated sources based on state:

```javascript
MenuLine.prototype.render = function(canvas, x, y) {
    if (this.icon) {
        var iconX = x + 3;
        var iconY = y + 3;

        // Use drawSprite for grayscale, drawIcon for binary
        if (this.icon.grayscale) {
            canvas.drawSprite(this.icon, iconX, iconY, iconColor);
        } else {
            canvas.drawIcon(this.icon, iconX, iconY, iconColor);
        }
    }
};
```

**Icon positions in menu**:
- X offset: `6px` from left edge (PAD_X)
- Y offset: Vertically centered in menu item
- Size: 14×14 pixels
- Text starts at: `6 + 14 + 4 = 24px` from left

### In Custom Scenes

**Using icons directly**:

```javascript
// Black icon (default)
canvas.drawSprite(Icons.network, 10, 50, '#000');

// White icon (for pressed/highlighted states)
canvas.drawSprite(Icons.network, 10, 50, '#fff');

// Any hex color (though icons are optimized for black/white)
canvas.drawSprite(Icons.network, 10, 50, '#ccc');
```

### Canvas Drawing Implementation

**File**: `js/canvas.js`

**drawSprite method**:
```javascript
FlipCanvas.prototype.drawSprite = function(sprite, x, y, color) {
    if (!sprite || !sprite.d) return;
    
    if (sprite.grayscale && sprite.bitsPerPixel === 6) {
        this._drawGrayscaleSprite(sprite, x, y, color);
    } else {
        this._drawBinarySprite(sprite, x, y, color);
    }
};
```

**_drawGrayscaleSprite method** (simplified):
```javascript
FlipCanvas.prototype._drawGrayscaleSprite = function(sprite, x, y, color) {
    var ctx = this.ctx;
    color = color || '#000';
    
    // Unpack 6-bit values and draw with opacity
    for (var row = 0; row < sprite.h; row++) {
        for (var col = 0; col < sprite.w; col++) {
            var grayValue = ... // Extract 6-bit value
            var opacity = (63 - grayValue) / 63;  // 0=white, 1=black
            
            if (opacity > 0.01) {
                ctx.globalAlpha = opacity;
                ctx.fillStyle = color;
                ctx.fillRect(x + col, y + row, 1, 1);
            }
        }
    }
};
```

**Key behavior**:
- Grayscale value 0 = white (transparent) → opacity 0
- Grayscale value 63 = black (opaque) → opacity 1
- Colors are applied with proper alpha blending
- Works with any HTML color (#000, #fff, #f00, etc.)

## Examples

### Main Menu with Icons

The current main menu is built from `MenuLine` instances inside `MenuScene`
(`js/apps/menu.js`). See [Main Menu scene](#main-menu-scene) below for the
full layout contract; here's the construction pattern:

```javascript
var line = new MenuLine({
    text: 'Settings',
    width: 224,
    icon: Icons.system,                      // static icon (shown when unselected)
    iconAnimated: AnimatedIcons.settings_animated  // plays while SELECTED
});
```

If no static icon is supplied but `iconAnimated` is, the line falls back
to frame 0 of the strip as the static render — no separate static asset
needed (used today for `Files` and `Apps`).

### Dynamic Icon Color in Pressed State

`MenuLine` itself only inverts its content colours during `PRESSED` —
the filled black backdrop is painted by the owning scene via the
`MenuSelectorFrame` (see [Main Menu scene](#main-menu-scene)). The line
looks up which font to use for text and then switches `iconColor` /
`textColor` based on state:

```javascript
MenuLine.prototype.render = function(canvas, x, y) {
    var textColor = '#000';
    var iconColor = '#000';

    if (this.state === STATE_PRESSED) {
        textColor = '#fff';
        iconColor = '#fff';   // line draws icon/text in white over the
                              // black selector fill the scene painted
    }

    // Pick static vs animated; grayscale sprites alpha-blend the colour.
    if (this.icon && this.icon.grayscale) {
        canvas.drawSprite(this.icon, iconX, iconY, iconColor);
    }
};
```

## File Structure

```
fake-flipctl/
├── js/
│   ├── icons.js                    # Icon definitions (network, system, testing)
│   ├── canvas.js                   # drawSprite() & _drawGrayscaleSprite()
│   └── apps/
│       └── menu.js                 # Main menu scene — builds MenuLine rows, owns the MenuSelectorFrame + scroll state
├── icons/
│   ├── main_menu/
│   │   ├── 14_px_network.png      # PNG source
│   │   ├── 14_px_system.png       # PNG source
│   │   ├── 14_px_testing.png      # PNG source
│   │   └── [generated .js files]  # (Optional, for reference)
│   ├── png-to-bitmap.py            # Grayscale converter tool
│   └── README_CONVERTER.md         # Conversion guide
└── CLAUDE.md                        # This documentation
```

## Troubleshooting

### Icon looks blocky/pixelated
- Check that PNG source uses anti-aliasing
- Verify conversion used `png-to-bitmap.py` (grayscale)
- Try re-converting the PNG

### Icon doesn't show up
- Verify icon is added to `Icons` object in `icons.js`
- Check `bitsPerPixel: 6` and `grayscale: true` are set
- Ensure canvas method uses `drawSprite()` not `drawIcon()`

### Icon color not changing
- Verify scene code passes the correct color parameter
- Check that `fillStyle` is set before `fillRect()` in canvas
- Ensure opacity is not being globally overridden elsewhere

### Edges look jagged
- PNG source may need better anti-aliasing
- Try adjusting PNG export settings for smoother curves
- Consider larger icon size (16×16) for finer detail

## Performance Notes

- **6-bit grayscale**: Minimal performance overhead vs. binary
- **Rendering cost**: Same as sprites (per-pixel opacity blending)
- **Memory**: 14×14 icon ≈ 42 bytes (4 pixels per 3 bytes × 14 rows)
- **Recommendation**: Use for UI icons up to ~20×20 pixels

For larger assets (>32×32), consider dedicated sprite assets with better compression.

---

# Recent additions

## App Switcher (Tab overlay)

`js/apps/app_switcher.js` — cover-flow scene that pops over whatever
is currently on top when the user presses **Tab** (mapped to `'appsw'`
in `input.js`).

### Activation rules (in `main.js`)

- **Tab from any non-`AppSwitcherScene` and non-`FigmaLivePreviewScene`
  scene** opens the switcher. Figma is excluded because its iframe
  consumes Tab for its own use.
- **Tab from inside the switcher** (already on top) launches the
  focused app instead of toggling.

### Transient current-scene card

When Tab is pressed from a *non-app* scene (Desktop / Menu / Submenu —
anything that's not a `PlaceholderAppScene`), `main.js` snapshots the
canvas and passes it to the switcher as a `transient` card:

```js
var tSnap = document.createElement('canvas');
tSnap.width = canvas.w; tSnap.height = canvas.h;
tSnap.getContext('2d').drawImage(canvas.el, 0, 0);
scenes.push(new AppSwitcherScene(scenes, {
    name: getSceneName(active) || '', snapshot: tSnap
}));
```

The transient occupies slot 0 (focused), running apps queue at
−1, −2, … . Picking it just pops the switcher (the user is staying
where they were); Esc on it is a no-op (you can't "kill" Desktop).
The transient is *not* added to `RunningApps`.

If `RunningApps.list().length === 0`, the transient is dropped on the
floor in `buildCardsFromRunningApps` and the switcher falls into the
empty-state branch ("No running apps" centered).

### Carousel layout (`POSITIONS` map)

| Slot | Role | Visual |
|------|------|--------|
| 0    | focused | 252 × 100 selected card with full screenshot |
| +1   | peek above | 252 × 100 white tab — where the demoted card lands after Down |
| −1   | tab below | 13 px tab, label `#666666` |
| −2   | deeper tab below | 13 px tab, lighter `#A7A7A7`, anchored to the canvas bottom |

Cards beyond ±2 fade out via `cardAlpha` rather than sliding off-screen.
Mid-animation the focused style and tab style cross-fade linearly
(`focusedAlpha = 1 − |posClamped|`, `tabAlpha = posClamped`) so 0 ↔ ±1
transitions blend rather than snapping.

Z-order is set per-frame by `zKey(card, e) = |lerp(animFrom, position, e)|`
— interpolated absolute position. Closest to focus paints last (on top).

### Phase state machine

`PHASE_OPENING` (zoom-in) → `PHASE_REST` → `PHASE_SCROLLING` /
`PHASE_KILLING` → `PHASE_REST`. Each animated phase runs for
`ANIM_DURATION_MS = 110`. Pixel-perfect lerping is done by
interpolating the four edges (L/R/T/B) independently and deriving
`w`, `h` from them — lerping `x` and `w` separately produces ±1 px
right-edge jitter from out-of-phase rounding.

### Kill flow

- **Esc** on a real running card kills it: card slides off-screen
  left, `RunningApps.close(name)` runs, any `PlaceholderAppScene` for
  the same name is spliced out of the scene stack, survivors shift up
  by 1.
- **Esc** on a transient is a no-op.
- If killing the last running app would leave only transients behind,
  the transients are spliced out *immediately* (so the user doesn't
  see Desktop parked above the dying app), then at animation end
  `cards = []` and a `requestRender()` paints the empty-state. Without
  the explicit request the loop wouldn't repaint — at `t >= 1`
  `animating` is already `false` and the screen would freeze on the
  last animation frame.
- Back from the empty switcher routes to `popToRoot()` rather than
  back to the menu chain that launched the now-dead apps.

### Kill button

Bottom-left button, label **`Kill`**:
`canvas.drawLeftButton('Kill', 0, 48, false, false)`. Hidden during
`PHASE_KILLING` (so it doesn't flicker against the slide-out) and when
the focused card is a transient.

### RunningApps registry

`js/running_apps.js` — single source of truth for "what's running."

| Method | Behaviour |
|--------|-----------|
| `open(name, imagePath, icon)` | Add new entry or bump existing one to the top. Re-launches keep the existing `image` (captured snapshot is what matters). |
| `close(name)` | Remove an entry; calls `requestRender()`. |
| `setSnapshot(name, canvas)` | Replace an entry's `image` with a captured canvas — called from `PlaceholderAppScene.exit()` so the switcher card always shows the user's last view of the app. |
| `list()` | Shallow copy, most-recent first. |

The exit-time snapshot is gated by `window._lastRenderedScene === this`
— without that guard, when the user picks a different app from the
switcher (which fires `pop()` then `push(newApp)` on the previous
scene before any render), the canvas pixels still belong to the
switcher and we'd save *its* frame as the previous app's "last seen"
thumbnail.

---

## Desktop additions

`js/apps/desktop.js` extras layered onto the original layout.

### Power flow

Battery power-flow row labelled **`Power flow`**, signed value
`±N.NN W`:

```js
var sign = watts > 0 ? '+' : (watts < 0 ? '-' : ' ');
var str  = sign + Math.abs(watts).toFixed(2) + ' W';
```

- `+` = power flowing **into** the battery (charging)
- `−` = power flowing **out of** the battery (discharging)
- ` ` (leading space at zero) keeps the column width identical across
  signed and idle states, so the value doesn't jitter horizontally
  when it crosses zero.

Server-side `getPowerUsage()` reads `/sys/class/power_supply/<dev>/power_avg`
in µW, divides by 1 000 000, retains sign — convention is preserved
end-to-end (the kernel reports negative for discharging on Flipper One).

### Wi-Fi connection card

A `WIFI` card sits below the ETH card stack on Desktop, rendered with
the same `drawEthCard()` function (same two-line `<NAME>  IPv4: …` /
`IPv6: …` layout, same colours). Data comes from the extended
`/api/wifi` schema (see API endpoints). Display name is hard-wired to
`WIFI` — only one wireless interface is ever active, no need for
`WLAN0` / `wlp2s0` noise.

The card renders only when **both** `connected: true` *and*
`ip4.length > 0`. The link can be up but unaddressed mid-DHCP, and a
flicker card during association is exactly the noise we don't want.

`_fetchWifi()` follows the same change-detection pattern as
`_fetchEthernet()` — only triggers `requestRender()` when the snapshot
differs from the previous (`ip4`, `ip6`, presence flips), so steady
state doesn't burn frames.

---

## Ethernet verbose detail modal

`js/apps/ethernet.js` — pressing **OK** on an interface tab opens an
overlay modal (`IfaceDetailModal`) showing the full `ip addr show`
dump for that interface. Esc / Back closes. The Mode row (index 0)
ignores OK as before — only the real interface tabs open the modal.

### Frame & layout

- `ResponsiveFrame` at `(4, 18, 248×122)`, white fill, 1 px black
  stroke, 4 px corner radius. Sits below the 13 px status bar so the
  system chrome stays visible.
- 6 px inner padding; content area 236 × 110 px.
- **Pixel-based scrolling.** `scrollOffsetPx` advances by
  `MODAL_LINE_H = 12 px` per Up / Down. `UI.Scrollbar` thumb computed
  from `totalHeightPx / viewportHeightPx`, drawn only when content
  overflows. Pixel-space scrolling lets text rows (12 px) and divider
  rows (4 px) coexist without index gymnastics.

### Row kinds

Each row carries its own height; the renderer accumulates in pixel
space and clips to the inner content rect.

| Kind | Height | Visual |
|------|--------|--------|
| `header` | 12 px | Interface name + cleaned status, **`Born2bSportyV2Medium`**, drawn at `y − 2` so the chunkier glyphs don't crowd the divider beneath |
| `metrics` | 12 px | Single line: `Speed`, `↓ RX`, `↑ TX`. Arrows are `Icons.arrow_down` / `Icons.arrow_up` (5 × 7), nudged 2 px down to centre against the 7-px text cap row |
| `kv` | 12 px | `Label:` (gray `#6D6D6D`) + value (black) on one line |
| `sub` | 12 px | Section label `IPv4:` / `IPv6:` / `DNS:` (gray) — only emitted when the section has 2+ entries |
| `value` | 12 px | Indented (8 px) array entry under the most recent `sub` |
| `divider` | 4 px | 1 px `#E5E5E5` rule centred in a 4-px band, separates blocks |

### Inline-vs-list collapse

The `pushList(label, arr)` helper emits a single `kv` row when the
array has exactly one entry (`IPv4:  192.168.1.10/24`), and `sub` +
`value` rows when there are multiple. A typical home-router setup
(one IPv4, one IPv6, one DNS) renders as three clean inline rows
instead of six.

### State string cleanup

nmcli's `GENERAL.STATE` returns `"100 (connected)"` / `"30 (disconnected)"`
— the leading numeric NM-DEVICE-STATE code is internal noise.
`cleanState()` strips it via `/^\s*\d+\s*\(([^)]+)\)\s*$/`. Server-side
carrier overrides like `"disconnected (no carrier)"` (no leading
number) pass through unchanged.

### Block order

```
header
divider
metrics                         # Speed / ↓RX / ↑TX, omitted if all missing
divider
Method:  DHCP Client            # omitted if no method
divider
IPv4 + Gateway4                 # block omitted if neither present
divider
IPv6 + Gateway6
divider
DNS                             # 1 entry → inline; 2+ → sub + values
```

Empty blocks skip both content and the preceding divider, so a
disconnected interface doesn't end up with a stack of bare rule lines.

### Modal pattern

Same shape as `SubMenuScene._modal` — input routes through the modal
first when set, normal scene continues to render and poll underneath.
Polling keeps modal data fresh on the 2-second cadence, and
`scrollOffsetPx` is clamped against the latest poll's row count each
render.

```js
EthernetScene.prototype.showModal  = function(modal) { ... };
EthernetScene.prototype.closeModal = function() { ... };

// In handleInput
if (this._modal) { this._modal.handleInput(action); return; }

// In render, after the page paints
if (this._modal) { this._modal.render(canvas); }
```

---

## App Switcher — touchpad scrolling & velocity projection

The carousel can be flicked with the touchpad as well as the D-pad.
Same machinery is reused by other scenes (visible-networks modal,
connected-network details modal in `wifi.js`).

### SSE wiring

```js
this._tpES = new EventSource('/api/touchpad/xy');
this._tpES.onmessage = function(e) { self._handleTouchpadMessage(e); };
```

Server backs this with `fs.createReadStream` over the kernel evdev
node, parsing `EV_ABS` events into `"x,y,touch"` lines. One stream
per scene — close it in `exit()` so the kernel-side reader gets
released.

### PHASE_DRAGGING (live)

Each `"x,y,touch"` line either:

- **Touch-down** (`touch 0 → 1`): capture `_tpBaselineY`,
  `_tpBaselineFocusedIdx`, reset `_tpVelSamples = [{y, ts}]`, switch
  to `PHASE_DRAGGING`. Crucially also reset any in-flight snap
  animation so the new stroke isn't tugged by stale momentum.
- **Touch-move** (`touch 1`): compute
  `rawDelta = (baselineY − ny) / TP_UNITS_PER_STEP`, clamp into
  `[0, n−1]`, write `_tpDragDelta`. Append `{y, ts}` to the
  velocity buffer and trim entries older than
  `TP_VELOCITY_WINDOW_MS` so a long drag with a slow tail doesn't
  pollute the release velocity.
- **Touch-up** (`touch 1 → 0`): see velocity projection below.

Y is **inverted**: finger moving down on the pad moves focus toward
*newer* / lower-index cards. Matches "drag the carousel down"
direct-manipulation feel.

### Velocity projection on release

```js
var first = samples[0], last = samples[samples.length-1];
var dt = last.ts - first.ts;
var velUnitsPerMs = -(last.y - first.y) / dt;        // inverted Y
var projectedExtra =
    velUnitsPerMs * TP_VELOCITY_PROJECTION_MS / TP_UNITS_PER_STEP;
var rawTarget = Math.round(fracIdx + projectedExtra);
var target    = clamp(0, n - 1, rawTarget);
```

- Slow drag → `projectedExtra ≈ 0`, lands where the finger stopped.
- Fast flick → carries the carousel multiple slots past release.
- Snap duration scales with distance; rendered with `easeOutCubic`
  for the iPhone-style decay-to-stop.

### Edge bounce

`_tpOvershootDir` is stamped from either:
1. **Position overshoot** — unclamped `fracIdx` left `[0, n-1]` mid-drag.
2. **Momentum overshoot** — projected stop position outside `[0, n-1]`.

After the snap commits, `PHASE_DRAGGING`'s tick chains a
`PHASE_BOUNCING` pulse on the focused card so the user feels the
"hit the wall" cue regardless of which kind of overshoot triggered it.

### Reusable shape (Wi-Fi modals reuse this)

The same five steps — touch-down baseline, drag-clamp, sample +
trim, velocity-from-window on release, project-then-snap with
`easeOutCubic` — are pasted into:

- Visible-networks modal scrollbar (`_openNetworksModal` in `wifi.js`)
- Connected-network details modal (`_openConnectedDetailsModal`)

The only thing that varies is the unit (cards vs pixels) and the
clamp range (carousel `[0, n-1]` vs scroll `[0, contentH − viewportH]`).

---

## Virtual Keyboard (`Keyboard` in `js/ui.js`)

Pop-up text-entry component used by the screen-keyboard testing
scene and any future text-input flow. Centred on the canvas, 250 ×
77 with 5 × 16 cells.

### Cell shapes

A row entry is either a **string** (single-char key, the common
case) or an **object**:

```js
{ text, wide, isShift, isLang, isSpace, onPress }
```

- `wide: true` — cell spans extra columns (used by space, shift,
  lang, the symbols-layout's `<>|` switcher).
- `isShift / isLang / isSpace` — semantic flags so the renderer
  can swap the glyph for an icon (`keyboard_shift`,
  `keyboard_lang`) and `handleInput` can branch on them.
- `onPress` — cell-level callback. Fires on OK *before* any text
  emission. Wires up the symbols-layout's `<>|` button switching
  between SYM-1 and SYM-2 layouts.

The OK handler normalises strings + objects into a uniform
`{char, isShiftCell, isLangCell, cellOnPress}` so the rest of the
key dispatch doesn't care which form the cell came in.

### Three-state shift machine

```
'off'  ──tap──▶ 'shift'  ──letter emitted──▶ 'off'   (Camel-Case affordance)
'off'  ─long-press─▶ 'caps'                          (entered externally)
'caps' ──tap──▶ 'off'                                (any tap exits caps)
```

- `'shift'` is **one-shot**: emits one upper-case letter, auto-releases.
- `'caps'` is reachable only via long-press, handled by the owning
  scene (sets `keyboard.shiftState = 'caps'` directly). The
  Keyboard component itself only knows about taps.
- Numbers, punctuation, space pass through unchanged regardless of
  `shiftState`. Multi-char labels (`"<>|"`) also fall through.

The pressed-state visual is independent of the shift-state fill —
every key (including shift) gets the 100 ms press-flash on tap so
the user sees the touch register even when the persistent state
doesn't change.

### Selection visual

Selected cell renders a **2 px outer stroke** drawn AFTER the
neighbouring cells, so the right + bottom edges aren't clipped by
the next cell's fill. Unselected cells use a whitened-gray fill
(`#E0E0E0` ish) so the selection pops without making everything
shouty.

### Layout switching

`langLabel` is a small gray badge above the lang key (top-row left
pad area): `'EN'` for the alphabetic layout, owning scenes swap to
`'123'` / `'ABC'` etc. when changing layouts. It's purely visual —
doesn't affect input.

The lang key itself uses a private-use-area sentinel (`'⌘'`,
`KEYBOARD_LANG_CHAR` in `ui.js`); pressing it currently no-ops at
the component layer. The owning scene watches selection + the
press flash externally and swaps `keyboard.rows` to do the actual
layout change.

`KEYBOARD_SHIFT_CHAR = '⇧'` is the matching sentinel for the
shift cell.

### Touchpad navigation

The screen-keyboard test scene wires the same SSE → velocity
machinery as App Switcher, but **linear without projection** —
slow finger movement scaled with a fixed divider so the cursor
moves cell-by-cell predictably. Earlier iterations included
axis-favouring (extra-distance for diagonals to lock to the
nearest row/col); that was removed by user request as a mistake.

### Diagnostics gotcha

The `KEYBOARD_LANG_CHAR` sentinel must be byte-identical between
`canvas.js` (the renderer) and `ui.js` / consumer scenes. An
earlier version stored U+E002 in canvas.js but an empty string
(invisible glyph dropped during copy/paste) in ui.js, leading to
the lang icon never rendering. Fixed by switching to a visible
codepoint (`'⌘'`) and asserting equality across files.

---

## Wi-Fi sub-page (`js/apps/wifi.js`)

Reachable from `Network → Wi-Fi`. Bread-crumb trail
`> Network > Wi-Fi` driven by `SceneManager.breadcrumb()` walking
the scene stack collecting each scene's `breadcrumbTitle`.

### Page layout (`_buildItems`)

Rebuilt every render so the list stays in sync with the live
radio state:

| Row | When shown |
|-----|-----------|
| **Wi-Fi toggle** (ON/OFF) | always |
| **`<SSID>`** chevron row (connected network) | only if `enabled && wifi.connected && wifi.ssid` |
| **See visible networks** chevron row | only if `enabled` |

When the radio is OFF every secondary row vanishes — there's
nothing useful to do with them while the radio is down, and
showing them would be lying to the user about what the device can
do right now. Selection clamps to `items.length - 1` so the
highlight survives the list shrinking under it.

### Wi-Fi power toggle (optimistic)

`UI.getWifiEnabled()` / `UI.setWifiEnabled()` in `js/ui.js`:

- `setWifiEnabled(enabled)` flips the local `wifiEnabled` flag
  *immediately*, requests a render, then POSTs `{enabled}` to
  `/api/wifi/power`. The UI never blocks on the round-trip.
- `pollWifiPower()` (3-s interval, also fired once on module init)
  reconciles by GETting `/api/wifi/power`. If the server's
  authoritative value differs, the local flag follows and a render
  is requested. This handles `nmcli radio wifi off` from a
  different control path.

Server side:

```js
var wifiPowerCache = { enabled: true };
async function refreshWifiPower() {
    var line = await tryExec('nmcli radio wifi', { ... });
    wifiPowerCache = { enabled: line.trim() === 'enabled' };
}
function setWifiPower(enabled, cb) {
    exec('nmcli radio wifi ' + (enabled ? 'on' : 'off'), ...);
}
```

POST handler updates the cache **before** the shell command
returns, so the very next GET on the same poller tick reflects the
write — closes the optimistic loop without waiting for nmcli.

### Visible networks scan (`/api/wifi/scan`)

The "spinner forever vs no networks" ambiguity is the central
problem this endpoint solves:

```js
var wifiScanCache       = { ready: false, networks: [] };
var wifiRescanCompletedAt = 0;
var wifiScanStartedAt   = Date.now();
var WIFI_SCAN_GRACE_MS  = 30000;
```

Three loops feed it:

| Loop | Period | Job |
|------|--------|-----|
| `triggerWifiRescan` | 20 s | `nmcli dev wifi rescan` — kicks the supplicant. First success stamps `wifiRescanCompletedAt`. |
| `refreshWifiScan`   | 5 s  | `nmcli dev wifi list` — parses output. |
| `refreshWifi`       | 2 s  | `/api/wifi` (active connection state, IP addresses). |

The scan endpoint returns `{ ready, networks }`. `ready` is gated
to **prevent flashing "No networks"** during the cold start before
nmcli has actually completed a scan:

```js
var inGrace    = (Date.now() - wifiScanStartedAt) < WIFI_SCAN_GRACE_MS;
var rescanDone = wifiRescanCompletedAt !== 0;
if (nets.length === 0 && !rescanDone && inGrace) return;   // keep ready:false
wifiScanCache = { ready: true, networks: nets };
```

So an empty result only flips `ready: true` once we've seen at
least one rescan complete, OR the 30-s grace has elapsed (a
genuinely empty area shouldn't spin forever either).

### Visible-networks modal (`_openNetworksModal`)

Same design language as the text-input box: `ResponsiveFrame` body
+ black `TabHeader` ("Visible networks") with rounded corners.

- **Geometry**: 4 px padding from the canvas left/right/top.
  `ResponsiveFrame` corner radius **4 px**, top edge sits flush
  with the bottom of the tab header (so the tab looks "attached").
  Top-left corner radius is **0** to fuse with the tab.
- **Dynamic height**: count rendered rows, add tab header,
  centre vertically. Hard cap at `MAX_BOTTOM_Y = 128` (1 px below
  what straight padding would give, matching a `+1` bottom-pad
  bump that gives the last row breathing space). Anything above
  the cap pages into the scroll.
- **Row contents**: SSID (ellipsised to the available width), a
  small WPA/WPA2/WPA3/WEP/Open security label, and a 4-bar signal
  icon **identical to the status-bar Wi-Fi icon** (so signal
  strength reads consistently between the two locations).
- **Scrollbar**: `UI.Scrollbar` shown only when content overflows.
  When scrollbar is hidden, the row's right edge extends to the
  inner frame edge (no wasted gutter for an absent thumb).
- **Loading state**: client tracks `_scanLoaded` separately from
  `_visibleNetworks.length` — only flips true when the server
  responds with `data.ready === true`. While `_scanLoaded` is
  false, the modal renders the 8-frame `spinner_22x20` looped at
  ~80 ms ticked by a `setInterval` requesting renders.
- **Empty state**: `ready: true` + `networks.length === 0` →
  centred "No networks" text. Distinct from the spinner.

### Security label

Parsed from nmcli's `SECURITY` field. The server returns the raw
string, the client maps it to a short label:

```
'WPA2'        → 'WPA2'
'WPA1 WPA2'   → 'WPA1/2'
'WPA3'        → 'WPA3'
''            → 'Open'
'WEP'         → 'WEP'
```

Whatever specific WPA flavour nmcli hands us makes it through —
not a "WPA-anything" lump.

### Connected-network details modal (`_openConnectedDetailsModal`)

Pressing OK on the connected-network row opens a second modal
sharing the design language of the Ethernet verbose modal but
unified into a **single scrollable selectable list**:

| Row kind | Selectable | Notes |
|----------|-----------|-------|
| `action` (Forget this network, Auto-join, Password) | yes | OK fires the action |
| `kv` (DHCP method, simple labels) | yes | Edit not yet wired |
| `sub` (IPv4: / IPv6: / DNS: section heads, multi-entry only) | yes | |
| `value` (indented address / gateway / DNS entry) | yes | |
| `divider` / `sectionDivider` | no  | Skipped by `nextSelectable` |
| `unavailable` | no | Rendered greyed when section has no data |

- **All non-divider rows are `selectable: true`** — even the info
  rows — so future edit flows can hook in without re-plumbing the
  list. Today only `action` rows do anything on OK.
- `nextSelectable(rows, idx, dir)` walks past dividers when the
  user navigates with up/down.
- `ensureSelectedVisible()` auto-scrolls so the highlight stays
  inside the viewport (matches the keyboard interaction in long
  menus).
- Touchpad uses the same SSE → velocity → `easeOutCubic` snap
  pattern documented under App Switcher above; the only diff is
  the unit (pixels) and clamp (`[0, contentH − viewportH]`).
- `computeLayout()` returns `{rows, rowOffsets, contentH}` per
  render, so the scroll math is always against the latest poll's
  data.

### Forget action wiring

`POST /api/wifi/forget` runs `nmcli connection delete <name>`
server-side, then synchronously kicks `refreshWifi()` and
`refreshWifiScan()` so the next client poll already reflects the
removal — no waiting for the 2-s tick to catch up. Auto-join /
Password rows are present but currently no-op; backend hooks for
auto-join change are still pending.

### Endpoint summary

| Endpoint | Method | Role |
|----------|--------|------|
| `/api/wifi`           | GET  | Active connection: `{connected, ssid, ip4[], ip6[], gateway4, gateway6, dns[], method}` |
| `/api/wifi/scan`      | GET  | `{ready, networks: [{ssid, signal, security}]}` |
| `/api/wifi/power`     | GET  | `{enabled}` |
| `/api/wifi/power`     | POST | `{enabled}` → `nmcli radio wifi on/off` |
| `/api/wifi/forget`    | POST | `{name}` → `nmcli connection delete` |
| `/api/wifi/connection`| GET  | `?name=…` → full `nmcli connection show` for that profile |

---

## References

- **Grayscale sprite example**: Dolphins (`js/sprites.js`) — 150×114 at 6-bit grayscale
- **Related components**: Canvas drawing primitives, [MenuLine](#menuline) rendering
- **Converter tools**: `png-to-bitmap.py` (grayscale), `png-to-bitmap-converter-v3.py` (binary, legacy)

# Voice recorder

Voice memo recorder for the Flipper One. Captures from the on-board NAU8822 codec
to WAV files on disk; lets the user list, play back, and delete them.

This file documents the voice-recording feature only. For the broader UI / scene
patterns it builds on, see `fake_flipctl2_CLAUDE.md` in the same directory.

## At a glance

- **Capture tool:** `sox` (not `arecord` — see "Why sox" below)
- **Recording format:** user-selectable **WAV / MP3 / OGG** (Format picker); all
  capture at 16 kHz / mono / S16_LE — MP3/OGG pipe sox into `lame` / `oggenc`
- **Capture device:** `plughw:N,0` where N is the NAU8822 card (auto-detected)
- **Storage:** `/flipperone-testing/sound/voice_recordings/` (created on server
  start; git-ignored via `sound/voice_recordings/`)
- **Filename:** template-driven, default `F1-REC-[YYYYMMDD-HHMMSS]` — date/time
  tokens are substituted **only inside `[...]`**, and colliding names get a `-N`
  suffix (see "Filename templates & collision indexing" below)
- **Recording lifetime:** server-side child process, now **decoupled from the
  scene**. A take started via `/api/record/start` keeps running when the recorder
  is backgrounded (like Internet Radio); `exit()` no longer stops it. Only an
  in-app **Stop** or an **App Switcher kill** (the `RunningApps` onClose hook →
  `_postStopRecord`) ends it. See "Backgrounding & the App Switcher" below

> **⚠ v1 vs current:** the **Server** and **Client** subsections immediately
> below describe the original v1 (two scenes, `recordings/` dir, `rec-*.wav`,
> WAV-only, scene-tied lifetime). They are kept for the sox/arecord rationale,
> but the **"Post-v1 implementation"** subsections further down are authoritative
> where they differ (storage dir, filenames, endpoint list, single-scene model,
> selectable formats, pause/resume, backgrounding, Files browser, player,
> status-bar indicator).

## Files touched

- `server.js` — recording state + `/api/record/*` endpoints
- `js/apps/record.js` — `VoiceRecorderScene` (list) + `RecordingScene` (active)
- `index.html` — loads `record.js` after `sound.js`
- `js/apps/menu.js` — adds **Testing → Voice recorder** entry, factory wires
  `VoiceRecorderScene`

## Server (`server.js`)

### State

```js
var RECORDINGS_DIR = '/flipperone-testing/sound/recordings';
var recordChild = null;             // ChildProcess (sox) when recording
var recordState = null;             // { file, startedAt: ms } when recording
try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch (e) {}
```

`recordChild` and `recordState` are nulled together in the child's `exit`
listener so a crash mid-recording can't desync them.

### Helpers

| Function | Purpose |
|----------|---------|
| `buildRecordingFilename()` | (current) expands the client's name template + format ext, then walks `-N` via `recordingExists()` until free — see Post-v1 § Filename templates |
| `getRecordings()` | Reads `RECORDINGS_DIR`, filters to `.wav`, returns `[{name, size, mtime}]` sorted newest-first |
| `startRecording()` | Spawns sox; stops any active playback first via `stopSound()` |
| `stopRecording()` | `SIGINT` to the sox child (clean WAV header). Idempotent — returns `{success: true, recording: false}` even if nothing was running |
| `deleteRecording(file)` | Validates filename (no path separators, must end `.wav`), then `unlinkSync` |
| `playRecording(file)` | Same shape as `playSoundFile` but reads from `RECORDINGS_DIR`. Reuses the global `audioChild` so playback can't collide with `/api/sound/play` |

### Endpoints

| Endpoint | Method | Returns / accepts |
|----------|--------|-------------------|
| `/api/record/list`   | GET  | `{ files: [{name, size, mtime}] }` (newest first) |
| `/api/record/status` | GET  | `{ recording: bool }`, plus `{ file, elapsedMs }` when recording |
| `/api/record/start`  | POST | `{ success, file }` or `{ success: false, error }` |
| `/api/record/stop`   | POST | `{ success: true, recording: false, file? }` |
| `/api/record/delete` | POST `{ file }` | `{ success }` |
| `/api/record/play`   | POST `{ file }` | `{ success, file }` |

### sox invocation

```js
var device = 'plughw:' + card + ',0';
var args = ['-q', '-t', 'alsa', device, '-r', '16000', '-c', '1', '-b', '16', filePath];
recordChild = spawn('sox', args, { stdio: ['ignore', 'ignore', 'pipe'] });
```

`-q` keeps the progress meter off stderr (otherwise it eats CPU rendering ASCII
art for nobody to read). The child closes its own stdin/stdout but keeps stderr
piped so error output is observable from `journalctl -u fake-flipctl-node-server`
if anything goes wrong.

### Why sox, not arecord

`arecord` was tried first and failed in two ways on this build:

1. **WAV header sizes don't get patched on signal-stop.** arecord writes a 2 GiB
   placeholder for the RIFF and `data` chunk sizes upfront and is supposed to
   seek back and patch them when it stops. On SIGINT *or* SIGTERM, this build
   leaves the placeholders in place — `soxi` then reports the file as ~18 hours
   long even though only a few KB of data was written. Manually patching the
   header in Node (`fs.openSync` + write 4 bytes at offsets 4 and 40) works
   but is fragile.
2. **Captures ~2× wallclock duration when interrupted mid-buffer.** A 5-second
   wallclock recording produced 10 seconds of audio in the file. Reproducible
   on both `hw:1,0` and `plughw:1,0`, with both SIGINT and SIGTERM. Likely an
   internal arecord buffering quirk on this version. Did not happen with
   `arecord -d N` (arecord-controlled stop).

sox handles SIGINT cleanly: writes a valid WAV header, captures real wallclock
duration, no Node-side header patching needed. The plug layer's resampling
(48 kHz → 16 kHz) happens transparently inside sox / ALSA.

### Why `plughw:` and 16 kHz

- The NAU8822 codec only opens at **48 kHz** on the raw `hw:N,0` interface
  (confirmed via `arecord --dump-hw-params`: `RATE: 48000`, `CHANNELS: [1 2]`).
- `plughw:N,0` inserts ALSA's plug layer, which transparently resamples to
  whatever rate sox asks for.
- 16 kHz mono is plenty for voice memos and gives ~32 KB/s files (vs ~96 KB/s
  at 48 kHz). The Flipper One has limited eMMC; smaller is better here.

### Card auto-detection

`getNau8822Card()` already exists in `server.js` (used by the volume controls).
It greps `/proc/asound/cards` for `[NAU8822` and returns the card number.
The voice recorder reuses it as-is — if the codec card number changes (driver
reload, hot-replug), the next `startRecording()` call picks up the new number.

## Client (`js/apps/record.js`)

Two scenes, IIFE-wrapped following the same shape as `sound.js`. Both use
`UI.drawStatusBar` + `UI.drawMenuList` / direct `canvas.drawText` (the
plain-text style this app variant uses for utility scenes — *not* the
`MenuLine` + `MenuSelectorFrame` style used by the main menu).

### `VoiceRecorderScene` — list view

State (instance fields):

```js
this.files = [];        // [{name, size, mtime}, ...] from /api/record/list
this.loading = true;
this.error = false;
this.selectedIndex = 0; // 0 = "* New recording" pseudo-row
this.scrollOffset = 0;
this.playing = null;    // filename of currently-playing recording, or null
```

Layout: row 0 is always the literal string `* New recording`. Rows 1..N are
the saved files (newest first), with a ` >>>` suffix on whichever one is
currently playing.

`enter()` re-fetches the list every time the scene becomes active. This includes
returning from the recording flow — `SceneManager.pop()` calls `enter()` on the
revealed scene, so a fresh recording lands at the top of the list immediately
without any explicit "I just made one" signal between scenes.

`handleInput`:
- **`ok` on row 0** → `sceneManager.push(new RecordingScene())`
- **`ok` on a saved row** → toggle play (POST `/api/record/play` if not currently
  playing this file; POST `/api/sound/stop` if it is)
- **`back`** → return `'pop'`

`exit()` posts `/api/sound/stop` if a playback was in flight, so leaving the
scene doesn't keep audio playing in the background.

### `RecordingScene` — active recording

State:

```js
this.startedAt = 0;
this.elapsedMs = 0;
this.state = 'starting';   // 'starting' → 'recording' → 'done' (on error)
this.error = '';
this.tickHandle = null;    // setInterval id for the 500ms redraw tick
this.filename = '';
this._unloadHandler = null;
```

`enter()`:
1. POST `/api/record/start`. On success, transition to `'recording'` and stamp
   `startedAt = Date.now()`. On failure, transition to `'done'` with `error`.
2. Start a `setInterval(500ms)` that updates `elapsedMs` and calls
   `window.requestRender()` so the blinking REC dot and elapsed counter
   advance even when the user isn't pressing keys.
3. Register `pagehide` + `beforeunload` listeners that fire
   `navigator.sendBeacon('/api/record/stop')`. `sendBeacon` is the durable
   cross-engine option for "send this last request as the page is going away" —
   `fetch({keepalive: true})` isn't universally supported in the Cog WebKit
   build this device runs.

`exit()`:
1. Clear the tick interval
2. Remove the unload listeners
3. POST `/api/record/stop` (always — even if state is `'done'`; the server is
   idempotent)

The triple-stop coverage (`exit()`, `pagehide`, `beforeunload`) is by design.
The contract with the user is "recording happens **only** while the scene is
open." Each path is the only one that fires for some scenarios:

| Scenario | Path that stops the recording |
|----------|-------------------------------|
| User presses OK / back / esc | `handleInput` returns `'pop'` → `exit()` |
| App switcher kills the scene | `SceneManager.pop()` → `exit()` |
| `/api/version` reload after server restart | `pagehide` → `sendBeacon` |
| Cog browser closed / TTY switch | `pagehide` → `sendBeacon` |
| Page navigated away (dev browser) | `beforeunload` → `sendBeacon` |

`handleInput`: any of `ok`, `back`, `esc` returns `'pop'` — explicit so the
intent ("any commit-ish key stops the recording") is obvious in the diff.

`render`:
- `'starting'` state: `Starting...`
- `'done'` with error: `Failed:` + truncated message
- `'recording'`: blinking `* REC` (toggles every 500 ms via
  `Math.floor(Date.now() / 500) % 2`), then `MM:SS` elapsed time, then a hint
  line and `[Stop]` label at the bottom

The blinking dot uses wall-clock time as the phase source rather than a
counter, so it stays stable across redraw skips and matches the 500 ms tick.

## Wiring

### `index.html`

```html
<script src="js/apps/sound.js"></script>
<script src="js/apps/record.js"></script>
```

Order matters only insofar as `record.js` doesn't depend on `sound.js` — they're
peers. Loading after `sound.js` keeps the audio-related apps grouped.

### `js/apps/menu.js`

Added under the **Testing** submenu, next to **Sound**:

```js
'Network LEDs',
'Sound',
'Voice recorder',     // ← new
'Figma live preview',
// ...
'Sound': function() { return new SoundMenuScene(sm); },
'Voice recorder': function() { return new VoiceRecorderScene(sm); },  // ← new
```

# Voice recorder — Post-v1 implementation (authoritative)

Everything below reflects the **current** code and supersedes the v1 text above
where they differ. Files now in play:

- `js/apps/record.js` — the single `VoiceRecorderScene` (settings list **and** the
  in-place recording panel; the separate v1 `RecordingScene` is gone). It is an
  app: `this._isApp = true` and it registers with `RunningApps` in `enter()`.
- `js/apps/voice_recorder_files.js` — the **Files browser** scene plus the
  built-in audio **player** overlay (loaded right after `record.js` in
  `index.html`).
- `server.js` — `RECORDINGS_DIR = '/flipperone-testing/sound/voice_recordings'`
  plus recording / playback / mic-level / input-routing endpoints.

## Filename templates & collision indexing

- Default template `F1-REC-[YYYYMMDD-HHMMSS]` (`DEFAULT_NAME_TEMPLATE`).
- Tokens are substituted **only inside square brackets** — literal text outside
  `[...]` is left untouched, so `F1-REC-` stays as typed. Opening the name field
  shows the raw pattern (`[YYYYMMDD-HHMMSS]`), not a pre-filled date.
- `_expandTemplateName` walks `TEMPLATE_TOKENS` **longest-first** so `HHMMSS`
  beats `HH`+`MM`+`SS`: `YYYYMMDD, HHMMSS, HHMM, MMDD, YYYY, YY, HH, MM, DD, SS`.
  Delete `SS` from the bracket to get a no-seconds timestamp, etc.
- Collisions: the server's `buildRecordingFilename()` walks `-1, -2, …` via
  `recordingExists()` until the name is free, so repeatedly starting with a fixed
  name yields `…-1`, `…-2`.

## Recording formats (WAV / MP3 / OGG)

- Format picker options `['WAV','MP3','OGG']` (default `WAV`); `_formatMeta` maps
  each label → `{ id, ext, … }`, populated from `/api/record/formats`.
- WAV = sox writing the file directly. MP3/OGG pipe sox's raw output into `lame` /
  `oggenc`. `/api/record/formats` reports which encoders are installed; a missing
  one drives the install modal (`/api/record/install`).
- The Format dropdown opens **upward** (its row sits near the bottom edge).

## Input device routing (built-in mic vs 3.5 mm jack)

- The NAU8822 exposes two mic paths; the Input-device picker is **exclusive**:
  *Build-in mic* vs *3.5 Audio*. `INPUT_DEVICE_LABEL_TO_SOURCE` maps labels →
  server `builtin` / `jack` modes. The server (`applyInputSource`) flips the
  Internal/Headset Microphone switches + the Left/Right Input Mixer MicP/MicN so
  only the chosen path is hot.
- Hardware wiring: built-in mic → **left** ADC channel, jack → **right**
  (device-tree routing), so each source carries signal on exactly one channel —
  hence the single-channel meter per source.
- Codec absent → `/api/sound/input/source` returns `cardPresent:false`; the picker
  shows **"Not found"**, suppresses arrows, and gates OK / left-right
  (`_codecPresent`).

## Input-level meter (SSE)

- A single 7 px **Input level** bar (transparent rect + black stroke) aligned to
  the menu-row chip column; no L/R labels — it shows the active source's channel.
- Fed by an `EventSource` on `/api/mic/level/stream`; the server pushes frames
  from inside the arecord chunk handler (replaced the old ~50 ms XHR poll).
  `EventSource` auto-reconnects on transport blips.
- The meter **stays live while paused** (see Pause/resume).

## Recording panel — free space & time-left

- The panel shows free disk GB + an estimated time-left, refreshed **once a
  minute** (faster just flickers between near-identical estimates); a one-shot
  fetch on enter/start fills real numbers on the first frame.
- `/api/record/status` returns `freeBytes` / `totalBytes`; the client turns the
  selected format's bitrate into the time-left figure.

## Pause / resume (real audio)

- Pause actually halts capture (not UI-only). `_togglePause` →
  `/api/record/{pause,resume}`.
- **WAV**: the server keeps sox draining ALSA but **drops file writes** while
  paused (`if (!recordPaused) { write + count bytes }`). Deliberate: sox keeps
  reading the capture stream so the **mic-level meter keeps updating** while
  paused — only the bytes-to-disk stop.
- **MP3/OGG**: `SIGSTOP` / `SIGCONT` the sox + encoder processes.
- The red LED and the status-bar dot both follow `_recording && !_paused` (see
  `_applyRecordingLed`); the in-panel lamp swaps to the static `recording_pause`
  icon while held.

## Backgrounding & the App Switcher

- `_isApp = true` + `RunningApps.open(...)` in `enter()` → Tab shows it as a card.
  Pressing **Back** no longer stops the take: `exit()` leaves the server child
  running (background recording, like Internet Radio) and keeps the red LED lit.
- `exit()` captures a **static snapshot** of the last frame into the card
  (`RunningApps.setSnapshot`, guarded by `window._lastRenderedScene === this`).
  (A live/running-numbers card preview was built then **reverted** — the card is a
  static snapshot taken only at the transition.)
- The **only** stops for a take: in-app **Stop**, or an App Switcher **kill** —
  the `RunningApps.open` onClose hook calls `_postStopRecord()` and clears
  `_recorderBgState`.

## Re-entry without the idle flash

- Symptom: a fresh scene instance started idle and only showed the recording panel
  after the async `/api/record/status` round-trip (~1.5 s) — a visible "reset to
  start" flash.
- Fix: module-level `_recorderBgState` survives between instances. `exit()` stashes
  `{recording, paused, recordStartTime, pausedElapsed, serverFile,
  recordingDisplayName, formatLabel}`; `enter()` calls `_applyBgStateSync()`
  **synchronously** (before mic setup) so the first paint already shows the panel.
  `_restoreRecordingState()` then reconciles against the server — refreshing
  elapsed/file, or rolling back to idle (and nulling `_recorderBgState`) if the
  take ended while away.

## Files browser (`js/apps/voice_recorder_files.js`)

- Opened from the recorder's **Files** button. Lists recordings with **durations**
  (`fmtDuration` → `M:SS` / `H:MM:SS`); the server probes duration via `soxi -D`
  (cached in `durationCacheMs`) so MP3 lengths work too.
- **Breadcrumb**: full `folderPath` (from `/api/record/list`), left-truncated with
  `…`, no `>` prefix.
- **Scrollbar**: `UI.Scrollbar` (`update(total,visible,idx)` + `render(...)`),
  `VISIBLE_COUNT = 4`.
- Bottom **button strip**: Home (esc) / Record (edit → pop back to recorder) /
  Edit (del) / Play (run); OK on a track opens the player.
- **Edit modal**: rows **Rename / Delete / Sort** (center-aligned). Sort is a
  `MenuDropdownLine` chip opening a gray popover (`SORT_OPTIONS`
  `name-asc/desc`, `duration-desc/asc` → labels `A-Z / Z-A / Longest / Shortest`).
  `_applySort` keeps the **selected file** selected. Re-pressing Edit while the
  modal is open closes it.
- **Rename**: opens `TextInputScreen` seeded with the current name; a `validate`
  callback shows a live "Name already exists" warning and disables **Done** on a
  duplicate. Keyboard skips the "Discard changes?" modal when text is unchanged.
  Server: `/api/record/rename`.
- **Delete**: Discard-style confirmation modal — "Delete" + filename on the next
  line, **Cancel / Delete** buttons with **Cancel** auto-selected. Server:
  `/api/record/delete`.

## Built-in audio player (overlay)

- Rendered **on top of** the Files list (not its own scene): a 228 × 48 panel at
  x = 4, y = 41, centered progress bar, bottom row
  `current-time / [< -10s] / play-pause / [+10s >] / total`.
- **Real playback.** The server spawns `play` (sox) via `spawn('play', argv,
  {env})` — **not** `exec` — with `AUDIODEV=plughw:<card>,0`. The Node server runs
  as **root**, where ALSA `default` = pipewire is user-only and fails with "no
  default audio device"; and `exec` runs via `/bin/sh -c` so SIGKILL would hit the
  shell, not sox.
- Pause/resume/seek use a **wait-for-exit** pattern (`_audioChildExit` promise
  captured after `stopSound`) to dodge ALSA `EBUSY`; `_killAudioChild` SIGKILLs
  and awaits exit before respawning at the new offset.
- Volume widget (16 px rounded rect, vertical fill) on the right; up/down →
  `/api/sound/volume` (control `Speaker`). Seek brackets are gray, flash `-Ns/+Ns`
  on press, and **long-press accelerates** the step (+10 up to 60 every 500 ms via
  `window.input.isHeld`).
- Track end keeps the player open (OK replays); left soft-key = **Close**.
- Server playback state: `audioPlay = {file, durationMs, startedAt, startOffsetMs,
  playing, paused, pausedAtMs, completed, child}`. `playbackPositionMs()` uses a
  `completed` flag (true only on a clean end-of-track exit) so the bar snaps to
  full on natural end but not on a kill.

## Status-bar recording indicator + pulse

- Icon `Icons.records_status_bar` — a **7 × 7 solid grayscale disc** (corners
  transparent so it reads round; interior filled fully opaque).
- Drawn in `UI.drawStatusBar` (`js/ui.js`), appended to the **left** status
  cluster after the wifi/ethernet icons, at `top` so it lines up with those 7 px
  icons.
- **Two flags, both owned by the recorder scene:**
  - `window._voiceRecorderRecording` — set in `_applyRecordingLed()` to
    `_recording && !_paused` (mirrors the LED: **hidden while paused**).
  - `window._voiceRecorderForeground` — `true` in `enter()`, `false` in `exit()`.
  - Dot shows only when `recording && !foreground` → **only while a take runs in
    the background** (in the recorder you already see the take, so it's suppressed
    there).
- **Pulse**: `alpha = 0.35 + 0.65·(0.5 + 0.5·sin(now/250))` (~1.6 s breathe, never
  fully gone). Applied via a new `alphaScale` arg on `FlipCanvas.drawSprite` /
  `_drawGrayscaleSprite` (`opacity *= alphaScale`; grayscale path only,
  backward-compatible). The animation is **self-perpetuating** — `drawStatusBar`
  calls `window.requestRender()` whenever it paints the dot (the codebase's
  "scene schedules its own next frame" pattern), so it animates in any scene and
  stops on its own when the dot drops out.
- The **same** pulse formula drives the in-panel `record_circle` lamp while
  actively recording (in `record.js` render); the 33 ms record tick supplies the
  repaints there.

## Server endpoints (current — supersedes the v1 table)

**Recording**
| Endpoint | Method | Notes |
|---|---|---|
| `/api/record/list` | GET | `{ files:[{name,size,mtime,durationMs}], folderPath }` |
| `/api/record/status` | GET | `{ recording, paused, file, format, elapsedMs, bytes, freeBytes, totalBytes }` |
| `/api/record/start` | POST | builds a collision-free filename from template + format |
| `/api/record/stop` | POST | idempotent |
| `/api/record/pause` · `/api/record/resume` | POST | WAV drop-writes / MP3-OGG SIGSTOP-CONT |
| `/api/record/formats` | GET | installed encoders → picker options |
| `/api/record/install` | POST | encoder install (drives the modal) |
| `/api/record/rename` · `/api/record/delete` | POST | file ops |
| `/api/record/level` | GET | one-shot mic level |

**Playback**
| Endpoint | Method | Notes |
|---|---|---|
| `/api/record/play` | POST `{file, positionMs?}` | spawn `play` with `AUDIODEV` |
| `/api/record/play/status` | GET | `{playing, paused, positionMs, durationMs, completed}` |
| `/api/record/play/pause` · `/…/resume` · `/…/seek` | POST | wait-for-exit respawn |

**Mic level + input routing**
| Endpoint | Method | Notes |
|---|---|---|
| `/api/mic/level/start` · `/…/stop` | POST | start/stop the arecord monitor |
| `/api/mic/level/stream` | GET (SSE) | pushes level frames |
| `/api/sound/input/source` | GET / POST | `{source, cardPresent}` / set `builtin`\|`jack` |
| `/api/sound/input/gain` | GET / POST | input gain |
| `/api/sound/input/controls` | GET | raw amixer controls (diagnostics) |

## Known constraints / future work

Resolved since v1: live level meter (input-level bar via SSE), rename (keyboard
+ `/api/record/rename`), and App Switcher visibility (the recorder is now an app
and backgrounds a running take). Still open:

- **No length cap.** A recording runs until stopped. eMMC has a few GB free; a
  runaway take at 32 KB/s (WAV) takes ~9 hours to fill 1 GB. A `--max-length`
  could be added if it becomes a real risk.
- **No tag/metadata sidecar.** Filenames are now freely editable, but there's no
  separate metadata store (artist/notes/etc.).
- **Codec contention with capture.** `startRecording()` calls `stopSound()`
  first; there's no inverse — starting playback while recording doesn't stop the
  take. Full-duplex on this codec is untested; assume one side may fail.
- **Status-bar dot can go stale.** The dot tracks `window._voiceRecorderRecording`,
  which only updates from the recorder scene. If a backgrounded take ends
  server-side (e.g. disk full) while you're in another app, the dot keeps pulsing
  until you re-enter the recorder and `_restoreRecordingState()` reconciles —
  same staleness window as the hardware LED.
- **DJI / TRS stereo-from-jack (deferred).** Open hardware question: feeding
  independent L/R from a TRS (not TRRS) source — the left channel came through
  very quiet while right was fine. User deferred investigating; no code change yet.

## End-to-end test recipe

```bash
# Start a recording from the command line
curl -X POST http://localhost:8899/api/record/start
# ... speak into the mic ...
curl -X POST http://localhost:8899/api/record/stop

# Inspect the file (default dir is now voice_recordings/)
LATEST=$(ls -t /flipperone-testing/sound/voice_recordings/ | head -1)
soxi /flipperone-testing/sound/voice_recordings/$LATEST
# Expect: 16000 Hz, mono, S16_LE, duration ≈ wallclock between start and stop

# Play it back
curl -X POST -H 'Content-Type: application/json' \
    -d "{\"file\":\"$LATEST\"}" http://localhost:8899/api/record/play

# Delete it
curl -X POST -H 'Content-Type: application/json' \
    -d "{\"file\":\"$LATEST\"}" http://localhost:8899/api/record/delete
```

For UI testing, navigate **Menu → Testing → Voice recorder** in cog after a
service restart (the page auto-reloads on `/api/version` change).

# Internet radio

Streaming-radio app under **Apps → Internet radio**. Lets the user pick a
city, pick a station within that city, set volume, route audio to a chosen
output, and play/stop an MP3 stream — all via a single screen with a
stacked-row settings layout and a dropdown picker overlay.

## At a glance

- **Stream player:** `mpg123` (auto-prompted to install if missing)
- **Stream format:** any URL `mpg123` accepts — we hard-code MP3 ICY
  endpoints; the server pipes them straight to ALSA
- **Settings rows:** City, Station, Volume (slider), Audio device — 4
  rows, divider before Audio device
- **State persistence:** in-memory across scene re-entries (city, station
  per city, volume, currently-playing) so re-launching from the App
  Switcher doesn't reset the user's pick
- **Audio routing:** Speaker / Headphone / HDMI / DisplayPort, fed by the
  `/api/sound/outputs` enumerator
- **Volume:** master Speaker + Headphone via amixer; chains
  `mute`/`unmute` so 0 % is genuine silence

## Files touched

- `js/apps/internet_radio.js` — `InternetRadioScene` (full app, ~1.2k LOC)
- `js/component-library/MenuDropdownLine.js` — settings-row component
- `js/animated_icons.js` — `internet_radio_anim` (14×14 strip, 8 frames)
- `js/apps/menu.js` — Apps submenu entry with `icon` / `iconAnimated`
- `js/main.js` — `_isApp` opt-in for the Tab handler
- `js/apps/app_switcher.js` — animated-icon awareness + multi-app
  intro that anchors A's screenshot from the live canvas
- `server.js` — `/api/radio/*` endpoints, `/api/sound/output{,s}`,
  amixer `mute`/`unmute` chaining

## Scene state

`InternetRadioScene` is constructed fresh by the App Switcher each time
the user re-enters from elsewhere. Cross-launch state is parked in an
**IIFE-scoped `saved` object** so it survives constructor calls without
needing global storage:

```js
var saved = {
    city:           'London',
    stationByCity:  {},        // per-city memory
    volume:         50,
    playingStation: null
};
```

`stationByCity[cityName]` records the last station the user picked for
each city, so coming back to a city restores their previous pick instead
of snapping to the city's first entry.

The scene also tags itself as an app:

```js
this._isApp = true;
```

…which `main.js`'s Tab handler reads to skip the transient-snapshot path
that would otherwise add a duplicate card to the App Switcher and play
the slide-up-from-bottom intro intended for non-app scenes (Desktop /
Menu / Submenu).

## Layout

```
┌──────────── status bar ────────────────────────────────────┐
├─[icon] Internet radio (gray title bar, Born2bSporty) ──────┤
│ City                ┌──────── London ────────────┐         │
│ Station             ┌──── Heart London ──────────┐         │
│ Volume              ┌███████████░░░░░░░░░░░  60% ┐         │
├──────────── divider (1 px gray rule) ──────────────────────┤
│ Audio device        ┌──── Speaker ───────────────┐         │
│                                                            │
│                                                  [Play]    │
└────────────────────────────────────────────────────────────┘
```

Constants (in the scene's render function):

```js
var TITLE_H            = 16;             // gray title bar height
var ROW_GAP            = 3;
var DIVIDER_AFTER      = 3;              // rows 0..2 above, 3+ below
var DIVIDER_OFFSET_Y   = 49;             // px below title bar bottom
var DIVIDER_PAD_AFTER  = 3;              // gap below divider
var SELECTOR_X         = 2;
var SELECTOR_W         = 252;
var SELECTOR_H         = 15;
```

The first three rows stack at `MenuDropdownLine.HEIGHT + ROW_GAP = 17` px
pitch starting at the title bar's bottom. Anything past `DIVIDER_AFTER`
drops below the gray rule, anchored at `dividerY + 1 + DIVIDER_PAD_AFTER`
and stacking at the same pitch from there. `rowYAt(i)` does the math.

Title bar carries:
- A **static icon** (frame 0 of `internet_radio_anim`, 14×14) at
  `(2, TITLE_Y + 1)` — 2 px from left, 1 px from top.
- The label `Internet radio` in `Born2bSportyV2Medium` at
  `(18, STATUS_BAR_H + 1)`.
- 2 px gap between icon and label.

## `MenuDropdownLine` (`js/component-library/MenuDropdownLine.js`)

Reusable settings row used by every line in the Internet Radio body. Two
visual modes share the same shell — title on the left (HaxrcorpFont16,
black, 6 px from canvas edge), 180 × 11 chip on the right (5 px from
canvas right edge, 3 px corner radius, `#E5E5E5` fill).

### Plain mode (City / Station / Audio device)

Constructor: `{ y, title, value, selected }`.

- **Value** drawn centered horizontally inside the chip in black.
- **Long values** trim from the right with a trailing `…` once
  `HaxrcorpFont16.textWidth` overflows the chip width minus 4 px (or
  more when the row is selected; see arrows below).
- **Selected state** paints `<` / `>` glyphs at the chip's left/right
  inner edges — advertises that left/right will cycle the picker
  without opening the dropdown.

### Slider mode (Volume)

Pass `slider: <0..1>` to flip the chip into a horizontal progress bar:

1. Gray base `ResponsiveFrame` (full chip).
2. Black `ResponsiveFrame` on top, width = `slider × CHIP_W`. Left
   corners follow the chip curvature; right corners are square unless
   the fill covers the whole chip.
3. Centered value text drawn TWICE at the same x/y, once clipped to
   the black region (white) and once to the gray remainder (black).
   Reads as one continuous label flipping color pixel-by-pixel across
   the fill edge.
4. When `selected`, `<` / `>` glyphs drawn at chip edges with the
   same split-color clipping — they invert when the bar reaches them.

**Minimum visible fill** is hardcoded at 5 % so the bar never reads as
an empty line. At `slider = 0` the chip still shows a small black nub
on the left edge so the user has a visible anchor at the bottom of the
range. Above 5 % the fill tracks the actual slider value.

### Static metrics

```js
MenuDropdownLine.HEIGHT       // 14 px (TOP_PAD 3 + CHIP_H 11)
MenuDropdownLine.TOP_PAD      // 3
MenuDropdownLine.CHIP_HEIGHT  // 11
MenuDropdownLine.CHIP_WIDTH   // 180
MenuDropdownLine.CHIP_FILL    // '#E5E5E5'
```

Exposed so caller scenes can stack rows without re-deriving the math.

## Pickers

The scene holds three pickers in a single keyed structure:

```js
this._pickers = {
    city:        { options: [...], current: 'London' },
    station:     { options: [],     current: '' },        // populated by _refreshStationList
    audioDevice: { options: ['Updating...'], current: 'Updating...' }
};
```

Each settings row tags itself with `pickerKey: 'city' | 'station' |
'audioDevice'`, so OK / left-right routes uniformly through
`_pickers[pickerKey]` regardless of which row is active. `Volume` is the
exception — flagged `isVolume: true` and routed to `_setVolume()` which
posts to amixer.

**`_refreshStationList()`** keeps the Station picker in sync with the
current city. Called from the constructor (to seed the initial state)
and from `_commitPickerChange('city')` (after a city change). It:

1. Reads `_stationsByCity[currentCity]` to build the new options list.
2. Reads `saved.stationByCity[currentCity]` for the city's last pick;
   falls back to the city's first entry on first visit or if the
   remembered value isn't in the new list.
3. Writes the resolved value back into `saved.stationByCity` so the
   next visit honors it.

**`_initSettings()`** (in `enter()`) hydrates `_volume` from
`/api/sound/volume` and the `audioDevice` picker from `/api/sound/outputs`
in parallel XHRs — neither blocks UI on the other.

## Dropdown overlay

OK on a row tagged with `pickerKey` opens an inline dropdown picker
anchored at the chip's top-left. Spec:

- **Width** = `CHIP_WIDTH` (180).
- **Height** = `13 × N + (N − 1) + 2` (per-line content + dividers
  between items + 2 px borders). 3 items = 43 px.
- **Wash**: `rgba(255, 255, 255, 0.75)` over the whole canvas — every
  other element fades out, the dropdown is the only crisp UI.
- **Body**: `ResponsiveFrame`, 3 px corner radius, `#E5E5E5` fill,
  **no stroke** (matches the chip's strokeless silhouette so the
  dropdown reads as the chip "growing downward").
- **Items**: `HaxrcorpFont16` black, centered horizontally; 1 px
  `#999999` divider between items.
- **Inner selector**: `MenuSelectorFrame` outline, width = `CHIP_W - 1`
  so the BR shadow pixel stays inside the dropdown silhouette.
- **Title text** (e.g. "City") is re-drawn in solid black on top of the
  wash so the user sees which row they're editing.
- **Page-level selector outline is hidden** while the dropdown is open
  — only the inner one reads as active focus.

Input handler:
- `up` / `down` cycle `_dropdownIndex` mod `picker.options.length`.
- `ok` / `run` commit: `picker.current = picker.options[idx]`, then call
  `_commitPickerChange(key)` which:
  - Writes city to `saved.city` and calls `_refreshStationList()` (the
    cascade — switching city resets / restores the station list).
  - Writes station to `saved.stationByCity[saved.city]`.
  - For audio device: hits `/api/sound/output` to switch ALSA routing.
  - **Hot-swaps the running stream** — if `_playingStation` is non-null,
    re-fires `_playRadio` with the new value. mpg123 doesn't reroute
    mid-stream, so the device change has to restart the child.
- `back` / `esc` cancels.

Left/right on a row with `pickerKey` cycles the picker INLINE without
opening the dropdown — same `_commitPickerChange` runs, so persistence
+ hot-swap stay consistent.

## Volume

`_setVolume(pct)` clamps to 0–100, writes optimistically into `_volume`
+ `saved.volume`, then POSTs to `/api/sound/volume` for both `Speaker`
and `Headphone` controls so the slider behaves like a master volume
regardless of routing. Server-side, `setVolume` chains `mute` /
`unmute` onto the same amixer call:

```bash
amixer -c <card> set Speaker 0% mute     # at 0 %
amixer -c <card> set Speaker 50% unmute  # at any non-zero
```

So 0 % genuinely silences the channel (some codec builds leak signal at
0 %), and going from 0 → any value above zero auto-unmutes — without
this, raising the slider after a previous 0 % wouldn't unmute the
channel because we'd never have flipped the mute bit back.

Step is 5 % per left/right press. Long press auto-repeats via the OS's
keyboard repeat.

## Audio device

`/api/sound/outputs` returns `{ outputs: [{id, label}], current }` for
the high-level targets — Speaker, Headphone, HDMI, DisplayPort. Server
hides the loopback device and splits the NAU8822 card into Speaker /
Headphone so the picker doesn't lie about what the user is choosing.

The picker stores `{id, label}` records on `_audioDevices`; the chip
shows labels but the API call uses the id. `_setAudioDevice(label)`
resolves label → id and POSTs `/api/sound/output { id }`. Server then:

1. Sets `selectedAlsaDevice` to the matching `hw:N,0`.
2. For Speaker / Headphone, mutes the OTHER NAU8822 control so the
   unwanted output is genuinely silent during the active route.

If a stream is already playing, `_commitPickerChange('audioDevice')`
restarts mpg123 — it doesn't reroute mid-stream.

## Play / Stop

`_playBtn` is a `UI.RightButton('Play', 48, 'run', ...)`. The label
flips to `'Stop'` every render based on `_playingStation` so the user
always sees the next action. `'run'` (mapped to the device's primary
action key, same as Done in KeyboardTestScene) flashes the button and
calls `_togglePlayback()`:

- If `_playingStation` is set → `_stopRadio()` → POST `/api/radio/stop`.
- Else → `_playRadio(stationName)` → POST `/api/radio/play { url }`.

`_playingStation` is updated optimistically (immediate UI feedback) and
rolled back on HTTP failure. Server's `playRadioStream` kills any
existing mpg123 child via SIGTERM and waits for actual exit before
spawning the new one (otherwise the new mpg123 would hit "Device or
resource busy").

## Persistent playback across scene exits

The stream is INTENTIONALLY left running when the user backs out of the
scene with Esc / Back — radio behaves like a "background music" app:
tap Back, music keeps playing while you do something else. Three paths
DO stop playback:

| Path | Mechanism |
|------|-----------|
| Switcher kill | `RunningApps.open(..., onClose)` 5th-arg hook fires `POST /api/radio/stop` and clears `saved.playingStation` |
| Tab close / refresh | `beforeunload` listener fires `navigator.sendBeacon('/api/radio/stop')` |
| Manual Stop | Right button while playing |

The user can also leave the app, change another setting, come back —
the Play/Stop button reads "Stop" because `saved.playingStation` is
non-null, and tapping Stop stops the still-running stream.

## mpg123 install modal

`mpg123` may not be installed. `enter()` fires `_checkMpg123()`:

```js
GET /api/radio/status   →   { mpg123Installed: bool }
```

When `mpg123Installed === false` (or the probe fails), the app opens an
install modal that owns input ahead of the dropdown ahead of the page
chrome. Three states:

| State | UI |
|---|---|
| `missing` | Title `Install mpg123?`, body `MP3 decoder for radio streaming`, two stacked buttons: **Install** (primary) / **Cancel** |
| `installing` | Title `Installing`, animated 22×20 spinner |
| `failed` | Title `Install failed`, last non-empty stderr line in body, **Retry** / **Cancel** |

`_runInstall()` POSTs `/api/radio/install`. Successful installs
auto-dismiss the modal so the user lands on the live app immediately —
no acknowledgement screen.

The modal sits on top of the dropdown overlay so the user can never
look at the app while the binary it depends on is missing.

## Dependency probe + station URLs

Stations are hard-coded in `_stationsByCity` (city → station-name list)
and `_stationUrls` (station name → MP3 URL). Names are ASCII because
`HaxrcorpFont16` tops out at codepoint 126 — Cyrillic / German
diacritics would render as blank tofu. URLs were probed for an MP3 ICY
response before being baked in; HTTP redirects are fine because mpg123
follows them transparently.

```js
this._stationsByCity = {
    'London':   ['Capital London',     'Heart London'],
    'New York': ['WNYC-FM',            'WQXR Classical'],
    'Tokyo':    ['J-Pop Sakura',       'Japan Hits'],
    'Berlin':   ['Berliner Rundfunk',  'Spreeradio 105.5']
};
```

Trivial to swap for a server-backed lookup later — only
`_refreshStationList` needs to change.

## Server endpoints

| Endpoint | Method | Body / response |
|---|---|---|
| `/api/radio/status` | GET | `{ mpg123Installed: bool }` — probes `which mpg123` |
| `/api/radio/play` | POST | `{ url }` → spawns `mpg123 -q <url>`; reuses `audioChild` so the mpg123 child shares lifecycle with /api/sound/play (one playback at a time) |
| `/api/radio/stop` | POST | `{ success: true }`. Idempotent — survives `sendBeacon` from page unload |
| `/api/radio/install` | POST | runs `apt-get install mpg123` with 90 s timeout; returns `{ success, output }` |
| `/api/sound/volume` | POST | `{ control, volume }` — chains `mute` / `unmute` based on `volume === 0` |
| `/api/sound/outputs` | GET | `{ outputs: [{id, label}], current }` |
| `/api/sound/output` | POST | `{ id }` → flips ALSA routing; mutes the unused NAU8822 sub-channel for Speaker/Headphone |

## Animated icon

`internet_radio_anim` in `animated_icons.js` is a 14 × 14, 8-frame strip
(grayscale 6-bit). Used in three places:

| Where | Usage |
|---|---|
| **Apps submenu row** | `iconAnimated` field — MenuLine plays it at 200 ms cadence when the row is selected; renders frame 0 statically when unselected (fall-through path in MenuLine when `icon` is null). |
| **App Switcher card title bar** | `this.icon` on the scene → `RunningApps.open(...)` 3rd arg → switcher draws **frame 0 only** (no animation in the switcher — see app_switcher.js's `iconFrameCount > 1 → drawSpriteFrame(icon, x, y, 0, color)` block). |
| **Internet Radio scene's title bar** | Drawn directly via `canvas.drawSpriteFrame(AnimatedIcons.internet_radio_anim, 2, TITLE_Y + 1, 0, '#000')` at `(2, 14)` — 2 px left, 1 px top inside the gray title bar. |

## App Switcher integration

Three coordinated changes make Internet Radio behave correctly in the
switcher:

1. **`main.js#isAppScene` check** — accepts any scene with
   `_isApp === true` in addition to `PlaceholderAppScene` /
   `SubMenuScene._asApp`. Suppresses the transient capture so Tab from
   inside the radio app doesn't add a duplicate card or trigger the
   slide-up intro.
2. **`buildCardsFromRunningApps` multi-app intro** — for any
   `cards.length >= 2` (transient or in-app), the intro now does:
   - `cards[0]` (current / transient): FULL APP → POSITIONS[+1],
     `_imageFromFullApp` (live canvas), `_overlay = true` so it sits on
     top during the intro.
   - `cards[1]` (previous app): FULL APP → POSITIONS[0] (focused) —
     B's saved snapshot is revealed underneath as A shrinks.
   - `cards[2..N]`: park at -1, -2, … cyclical positions.

   `focusedIdx = 1` so Tab → Tab from inside an app drops the user
   straight onto the previous running app — the standard "swap to
   last app" gesture without scrolling.
3. **In-app reuse** — when picking an app from the switcher,
   `PHASE_CLOSING` searches `sceneManager._stack` for an existing
   instance with matching `displayName` and pops down to it instead of
   constructing a fresh scene. This is what preserves Internet Radio's
   in-memory state (selection index, dropdown state, etc.) across a
   Tab → pick-another-app → Tab → pick-Internet-Radio cycle.

The card-internal screenshot is anchored 12 px above the frame
interior's top (was 9 px before; the user-visible 3 px lift) — both the
REST path (`state.y + 1 - 13`) and the zoom-transition lerp target
(`targetState.y - 12`) reference the same offset so there's no jump at
the animation boundary.

## Known constraints / future work

- **Stations are hard-coded.** A real backend (radio-browser.info, etc.)
  would replace the `_stationsByCity` / `_stationUrls` literals with an
  async fetch in `_refreshStationList`. The rest of the picker plumbing
  stays as is.
- **No volume-button feedback for mute state.** At 0 % the audio is
  genuinely silent (amixer mute) but the slider's 5 % visible nub stays
  visible; there's no separate "muted" indicator beyond the `0%` label.
- **mpg123 doesn't reroute mid-stream.** Audio device changes restart
  the child — there's an audible gap of 1–2 s during the restart.
- **HTTP-only stream URLs aren't TLS-validated.** The server passes the
  URL straight to mpg123, which will fetch http(s) but won't enforce
  certificate validation choices (relies on the system trust store).
- **No favourites / recents stack.** Per-city memory is the entire
  state model; scrolling to a previously-played station from a
  different city requires city-switching first.

## End-to-end test recipe

```bash
# Start a stream from the command line
curl -X POST -H 'Content-Type: application/json' \
    -d '{"url":"http://media-ice.musicradio.com/CapitalMP3"}' \
    http://localhost:8899/api/radio/play

# Stop it
curl -X POST http://localhost:8899/api/radio/stop

# Check mpg123 is installed
curl http://localhost:8899/api/radio/status

# Master-volume sweep (chains mute/unmute)
curl -X POST -H 'Content-Type: application/json' \
    -d '{"control":"Speaker","volume":0}'  http://localhost:8899/api/sound/volume
curl -X POST -H 'Content-Type: application/json' \
    -d '{"control":"Speaker","volume":40}' http://localhost:8899/api/sound/volume

# Audio output enumerator + flip
curl http://localhost:8899/api/sound/outputs
curl -X POST -H 'Content-Type: application/json' \
    -d '{"id":"speaker"}' http://localhost:8899/api/sound/output
```

UI testing: navigate **Menu → Apps → Internet radio**. The first launch
on a fresh device hits the install modal; once mpg123 is installed
subsequent launches go straight to the settings stack. Persistent
state lives in JS memory — full page reload (auto-fires on
`/api/version` change) resets `saved` to its IIFE defaults.

# Text input screen + on-screen keyboard

A reusable text-input screen — title above an auto-sizing input
field, the standard on-screen `UI.Keyboard` with a peek-row number
wave, two square-top/rounded-bottom tabs (`123` and a backspace
icon) just below the keyboard, the bottom-bar `Cancel` / `Done`
buttons, and a `Discard changes?` modal that intercepts Back when
there's unsaved text.

Originally split out of the keyboard-test sandbox so other scenes
(Wi-Fi password modal today, future forms tomorrow) can drop the
same input experience in without copying the chrome. The single
canonical class is `TextInputScreen`; `KeyboardTestScene` is kept
as a backward-compatible alias for the boot-menu / debug-config /
app-switcher entries.

## At a glance

* **Canonical class** — [`js/apps/keyboard_test.js`](js/apps/keyboard_test.js) exports
  `TextInputScreen(options)` with an in-file alias
  `var KeyboardTestScene = TextInputScreen;`.
* **Options** —
  ```js
  new TextInputScreen({
      displayName: 'Screen Keyboard',  // app-switcher label
      title:       'Wi-Fi password',   // caption above the field
      initialText: '',                 // pre-fill (cursor lands at end)
      onSave:      function(text) { /* commit + return 'pop' or 'stay' */ },
      onDiscard:   function()     { /* tear down + return 'pop' */ },
  });
  ```
* **Lifecycle hooks** — `enter()`, `exit()`, `render(canvas)`,
  `handleInput(action)`. Same shape as any other scene, so both
  the boot menu (scene push) and the Wi-Fi connect modal
  (embedded inside `self._modal`) can drive it.
* **Two consumers today** — `KeyboardTestScene` (sandbox, pushed
  by the boot menu) and `WifiScene._openConnectModal` (Wi-Fi
  password entry, wrapping the screen in its own `self._modal`
  with a spinner / error overlay on top).

## Files touched

| Path | Why |
|---|---|
| [`js/apps/keyboard_test.js`](js/apps/keyboard_test.js) | Houses `TextInputScreen` (and the `KeyboardTestScene` alias). All input/render logic + the discard modal live here. |
| [`js/apps/wifi.js`](js/apps/wifi.js) | `WifiScene._openConnectModal` now constructs a `TextInputScreen` and overlays its own spinner / error states. Old inline keyboard/layouts/touchpad/buttons removed. |
| [`js/canvas.js`](js/canvas.js) | New cell flags + render paths in `drawKeyboard` (`isKeyboardUp` / `isKeyboardDown`), peek-row wave math, and the tab-button drawing (`drawNumericTabButton`, `drawIconTabButton`, `drawNumericTabButtonSelector`). |
| [`js/ui.js`](js/ui.js) | `UI.Keyboard` gained focus state + peek-row wave eval (`setFocused`, `syncWaveToSelection`, `snapToRow`, interlayer callback) and two new bottom-button classes (`UI.NumericTabButton`, `UI.IconTabButton`). |
| [`js/input.js`](js/input.js) | Hardware-key remapping: `Backspace` / `Escape` → `'esc'`; `v` → `'back'`. |

## Constructor options + commit funnel

`enter()` reads `this._opts`:

* `displayName` → `this.displayName` (sandbox / app-switcher label).
* `title` → `this.fieldTitle` (centred caption above the field).
* `initialText` → `this.inputText`. `_inputCursor` lands at
  `inputText.length` so typing appends.
* `onSave`, `onDiscard` → stored as `_onSave` / `_onDiscard`.

`_commitSave()` and `_commitDiscard()` are the funnels: every Save
path (modal Save button, bottom-bar Done) routes through
`_commitSave`; every Discard path (modal Discard, bottom-bar
Cancel when text empty) routes through `_commitDiscard`. Each
helper invokes the consumer callback and returns whatever the
callback returned. Returning `undefined` defaults to `'pop'`;
returning any non-`'pop'` value (e.g. `false`) keeps the screen
alive — Wi-Fi uses this to hold the screen open while the
`/api/wifi/connect` XHR is in flight.

## Title + input field layout

Flat layout: status bar at `y=0..12`, a centred title at `y=24`,
the input field directly below at `y=titleY + 14 = 38`, the
keyboard at the canonical `y=75`. No modal-style tab header or
body frame.

Both the title and field use `Math.round((canvas.w - w) / 2)`
for x-centring so even/odd widths land on the same pixel axis.
Field auto-grows with the typed text:

* `INPUT_PAD = 6` (padding each side).
* `INPUT_MIN_W = 150` (start), `INPUT_MAX_W = 238` (cap).
* `inputW = clamp(textWidth + 12, 150, 238)`.
* `inputX = round((canvas.w - inputW) / 2)`.
* `cornerRadius = 3` on the field's `ResponsiveFrame` (light-grey
  fill, no stroke).
* Focus selector = 2-px black wraparound rendered via two
  `ResponsiveFrame` strokes (r=3 inner at the field bounds, r=4
  outer 1 px out). `drawRoundFrame` only ships r=2/3 tables —
  `ResponsiveFrame` handles arbitrary radii.

## Cursor + text truncation

`_inputCursor` (integer 0..`inputText.length`) is the caret
position. The keyboard's `onChar` callback inserts at the cursor
and Backspace deletes the char to its left, advancing the cursor
accordingly. `_fitInputText(text, cursor, innerW)` decides which
slice of the text to render and whether either side needs a
truncation marker:

```
text fits           → text
right-truncated     → text...>
left-truncated      → <...text
both sides          → <...text...>
```

`HaxrcorpFont16` has no triple-dot glyph; the markers are three
period characters (`<` + `...` and `...` + `>`). `_fitInputText`
always measures the full rendered substring (with markers
attached) via `HaxrcorpFont16.textWidth` rather than summing
per-char widths — per-char widths each subtract one inter-char
unit at the tail, so accumulation under-counts the concat by
~N px and lets text overflow the field.

The cursor x is `textX + leftMarkerWidth + textWidth(slice(left,
cursor)) + 1` — measured inside the visible substring so it
stays accurate when the window slides.

## Peek row + dock-style number wave

`_layoutABC[0]` is the **peek row**: 11 cells (`1, 2, …, 0, -`)
sitting one row above the QWERTY top, aligned column-for-column
with `qwertyuiop[`. The first cell carries `peek: true` —
`drawKeyboard`'s `kbHasPeekRow` test keys off the row-0 first
cell.

Visually, each peek cell renders a full Q-shaped rounded card
that mostly tucks behind the QWERTY row below it. When the user
lands on a peek cell the wave lifts it (and the surrounding
cells, mac-dock-style); when they leave the wave lerps back to
flat.

* `POPPED_BTN_Y = keyboardY - BTN_H` (fully extended, 1 px above
  Q's top edge).
* `FOLDED_BTN_Y = keyboardY - PEEK_VISIBLE_H - PEEK_LIFT_FOLDED`
  (resting tab, `PEEK_VISIBLE_H = 2`, lifted 1 px above Q for
  breathing space).
* `LIFT_RANGE = FOLDED - POPPED = 13`.
* **Falloff** `PEEK_FALLOFF_PX = 2` — each column of distance
  from the wave centre drops the lift by 2 px, so neighbours
  step `2, 4, 6, …` px below the centre.

Every peek cell renders the same rounded card; Q's white-filled
default-state cell (now bg-filled before its stroke, so the body
is opaque) overdraws the lower portion of each peek so only the
3-px tab + the visible digit show through.

The digit text inside the peek cell is clipped per-frame so it
fades down as the cell descends — `paintContent` is wrapped in
`ctx.save / clip / restore` with `clip rect = (btnX, btnY, btnW,
keyboardY - 1 - btnY)` so only the rows above Q's top render.

## Wave animation system

State on `UI.Keyboard`:

* `_peekWaveRestCenter` / `_peekWaveRestAmp` — the steady-state
  values when no animation is running.
* `_peekWaveAnim` — `{ startMs, duration, fromCenter, fromAmp,
  toCenter, toAmp }` while interpolating.

`kbEvaluatePeekWave(kb, now)` folds the live animation into an
instantaneous `{ center, amp }` pair. `Keyboard.render` evaluates
it once per frame, passes it to `drawKeyboard` as `peekWave`,
and re-arms `requestRender` until the animation completes.

`_driveWaveToCurrentSelection()` is invoked from every path that
changes selection (`setSelection`, `handleInput`'s row/col
mutators, `setFocused`). It captures the current eased state as
the new `from`, computes a target (`onPeekRow ? amp=1, center=
selectedCol : amp=0, center=cur`), and starts a fresh animation.
Mid-flight retargeting re-anchors smoothly — no snap when the
user mashes left/right across the wave.

`syncWaveToSelection()` snaps the wave instantly (no animation)
to whatever shape matches the current selection. Used by
`_toggleLayout` after swapping `rows` — otherwise the wave state
from the outgoing layout would leak into the new layout and
play back as a "leftover" collapse animation.

`KB_PEEK_WAVE_MS = 160 ms`, cubic ease-out.

## Layout toggle ABC ↔ SYM

`KeyboardTestScene.prototype._toggleLayout` runs when the 123
tab fires (`'edit'` action / X hardware key). Row index shifts
between layouts:

* **ABC → SYM**: `newRow = max(0, prevRow - 1)`. SYM's numbers
  row visually sits where ABC's QWERTY-top row is, so `'t'` at
  `(1, 4)` lands on `'5'` at `(0, 4)`; peek row 0 clamps to SYM
  row 0 (same digit, no longer floating).
* **SYM → ABC**: `newRow = min(prevRow + 1, layoutABC.length - 1)`.
  The mirror — SYM `'5'` at `(0, 4)` round-trips back to ABC
  `'t'` at `(1, 4)`. Peek is reachable via Up arrow from QWERTY
  top, never as a toggle target.

After the swap, `_setSelection(newRow, prevCol)` re-clamps the
column to the new layout's row length and
`syncWaveToSelection()` snaps the wave to the resulting state.

## 123 + backspace tabs

Two tab buttons hang below the keyboard, both 48 × 14 with
**square top corners** and **rounded bottom corners (r=4)** — the
shape reads as a tab attached to the chrome above:

* **123 tab** — `(x=52, y=128)`, label `'123' / 'ABC'`, fires the
  `'edit'` action (X key) and toggles the layout.
* **Backspace tab** — `(x=156, y=128)`, icon = `Icons.backspace`,
  fires the `'back'` action (V key) and calls
  `keyboard.onChar('\b')`.

Rendering uses two canvas helpers — `drawNumericTabButton(text,
…)` and `drawIconTabButton(icon, …)`. Both share the same shape
+ light-grey side / curve strokes; only the content differs. UI
classes `NumericTabButton` and `IconTabButton` wrap them with
the standard `press` / `release` / `selected` protocol.

`drawNumericTabButtonSelector` paints the focus selector — a 1-
px black stroke on the sides + rounded-bottom curve + a 42 × 1
underline strip 1 px below the button + 1 × 11 flank strips one
column outside each side. Top stays open so the selector reads
as a tab.

## Form-navigation cells (Up / Down arrows)

The previously wide backspace / return cells at row 1 col 11 and
row 2 col 12 of every layout now carry `isKeyboardUp:true` /
`isKeyboardDown:true` flags. `drawKeyboard`'s `cellOf` +
`paintContent` render `Icons.keyboard_up` / `Icons.keyboard_down`
centred inside the cell, and `UI.Keyboard.handleInput`'s OK
branch swallows them with a no-op (no character emission, no
scene close). Real behaviour ("move caret to previous / next
form field") is a follow-up — visuals are in place.

## Focus model

`_focus` ∈ `{ 'keyboard', 'tab123', 'tabBackspace', 'inputField' }`.

* `_focusKeyboard()` — re-arms `keyboard.setFocused(true)`,
  clears `selected` on both tab buttons.
* `_focusTab(tabName)` — sets the named button's `selected =
  true`, defocuses the keyboard.
* `_focusInputField()` — clears tab selections, defocuses the
  keyboard, resets the blink cursor.

When defocused, `UI.Keyboard.drawKeyboard` skips its selector
pass and `_driveWaveToCurrentSelection` targets `amp = 0` —
the wave collapses cleanly while another control owns focus.

D-pad navigation:

* `Up` on row 0 → focus the input field. Keyboard's `(row, col)`
  is preserved so a follow-up `Down` restores the selection.
* `Down` on the bottom row → focus the tab whose x footprint the
  current column sits over (123: cols 1–4, backspace: cols
  8–11) — both the keyboard's wide leading cell is 35 px in
  every layout, so the same column indices line up across ABC /
  SYM.
* `Down` on either tab → `keyboard.snapToRow(0)` (x-aligned).
* `Up` on either tab → restore the keyboard's saved `(row, col)`.
* `Left` / `Right` on the input field → step `_inputCursor`.

## Touchpad zones

`_handleTouchpadMessage` resolves a touch position to a virtual
row via the same baseline + `dy / TP_Y_UNITS_PER_STEP` math the
keyboard uses. The vertical zones are:

| target row | result |
|---|---|
| `< 0` | input field; `targetCol` maps to `_inputCursor` so dx steers the `\|` through the text |
| `0..N-1` | keyboard rows |
| `>= rows.length` | tab strip — 123 / backspace by column, or clamp to last keyboard row when the column doesn't sit over either tab |

Touch-down rebaselines depending on focus: `inputField` → row =
`-1`, col = `_inputCursor`; `tab123` / `tabBackspace` → row =
`rows.length`, col = `2 / 9` (tab centre). Transition INTO the
input field re-anchors the baseline to the current finger
position with `baselineCol = _inputCursor`, so entry doesn't
shift the `|` — only further dx does.

Crucially the tab strip is a **dead-end via touchpad**: a drag
past `rows.length` is treated the same as `== rows.length` (tab
or last-row clamp). Crossing from the tab to the numeric row is
intentionally D-pad-only (Down from the tab → `snapToRow(0)`).

## Discard-changes modal

Opens on `'esc'` only when `inputText.length > 0` (empty field
falls through to the standard Cancel-button discard path).
State: `_discardModal = { open: false, buttonIndex: 0 }`.

Style mirrors the Internet Radio install modal — 150 × 70
centred frame on a translucent wash, `Born2bSportyV2Medium`
title (`'Discard changes?'`), `HaxrcorpFont16` grey body
(`"Your text won't be saved."`), two stacked buttons rendered
through `_drawDiscardModalButton` with a shared
`MenuSelectorFrame` highlight.

Buttons:

* `Save` (index 0, default focus) → `_commitSave` → consumer's
  `onSave(inputText)`. Same effect as the bottom-bar Done
  button.
* `Discard` (index 1) → `_commitDiscard` → consumer's
  `onDiscard()`. The text is lost.

Modal input handling owns the dispatch while open:

* `Up` / `Down` / `Left` / `Right` toggle `buttonIndex`.
* `OK` triggers the highlighted button.
* `Back` / `Esc` dismiss the modal (return to the keyboard,
  text preserved).

Render is the very last step in `TextInputScreen.render`, so the
modal layers above the keyboard, tabs, and bottom-bar selectors.

## Hardware key remapping

`js/input.js` `KEY_MAP`:

* `Backspace` → `'esc'` — used to map to `'back'`; now exits the
  scene (or opens the discard modal).
* `Escape` → `'esc'` — same.
* `v` → `'back'` — used to be `'view'`; now fires the backspace
  tab (delete one character).
* `x` → `'edit'` (unchanged) — fires the 123 tab (toggle layout).

The old `'view'` action wasn't referenced anywhere else, so
re-purposing `v` is a zero-cost swap.

## Wi-Fi password modal integration

`WifiScene._openConnectModal(ssid, security)` now constructs a
`TextInputScreen({ title: 'Password for ' + ssid, initialText:
'', onSave, onDiscard })` and parks it behind a thin
`self._modal` wrapper that:

* Forwards `handleInput` to the screen, closing the modal on a
  `'pop'` return **only when** `!connecting && self._modal` —
  otherwise the screen is needed alive while the
  `/api/wifi/connect` XHR runs and the spinner overlay paints.
* Renders the screen, then layers a translucent wash + 22 × 20
  spinner sprite when `connecting`, or a single ellipsised
  error line above the keyboard when `errorMsg` is set.
* Keeps the existing 80 ms anim ticker for spinner frames; the
  screen's own 250 ms blink ticker drives the text cursor.

Old inline keyboard / layouts / touchpad / Close-123-Done
bottom-buttons in `wifi.js` are gone — ~220 fewer lines.

## End-to-end test recipe

Boot menu → **Testing → Tests → On screen keyboard** drops into
the sandbox (`KeyboardTestScene`, default options). Sanity:

* Type a few letters → Field auto-grows up to 238 px, then
  text truncates with `<...` / `...>` markers.
* `Up` on `q` → input field selector lights up; `Left` / `Right`
  walk the `|` through the typed text.
* `Down` from `t` → wave centres on `t`; `Up` again → wave
  centres on `5` (the digit above `t`). `Down` past the bottom
  row at column 2 → 123 tab highlights; `OK` toggles to SYM and
  `'t'` maps to `'5'`.
* `V` → backspace tab flashes + last character deletes.
* `Backspace` with text in the field → discard modal opens with
  `Save` highlighted; `OK` exits (same as Done), `Right`+`OK`
  exits via `Discard`, `Back` dismisses the modal.
* Touchpad drag down past the tab strip → cursor parks on the
  tab (dead-end); only the D-pad Down from the tab advances
  onto the numeric row.

Wi-Fi consumer: **Menu → Connections → Wi-Fi → pick a visible
network**. Same keyboard chrome appears; Done POSTs `{ ssid,
password }` to `/api/wifi/connect`; spinner spins until the
response arrives; errors stay overlaid until the user dismisses
with any key.
