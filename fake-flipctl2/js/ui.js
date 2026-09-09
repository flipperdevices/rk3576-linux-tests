var UI = (function() {
    var STATUS_BAR_H = 13;
    var STATUS_BAR_PAD_TOP = 3;
    var ITEM_H = 12;
    var PAD_LEFT = 4;
    var SCROLLBAR_W = 3;

    var batteryLevel = -1;
    var batteryCharging = false;
    var modemAvailable = false;
    var signalQuality = -1;  // 0-100 or -1 for unknown
    var accessTech = '--';  // Technology: 5G, LTE, 3G, etc.
    var wifiConnected = false;
    var wifiQuality = 0;     // 0-100
    var wifiSSID = '';
    // Ethernet status-bar state. `'none'` → nothing connected (no
    // icon). `'real'` → at least one physical port (end0 / end1) is
    // up; show the standard ethernet icon. `'usb'` → ONLY the USB
    // gadget interface (flipusb0) is up; show the dedicated USB-ETH
    // icon so the user knows the link is back-channel rather than a
    // routable connection. Tri-state instead of a bool because the
    // icon depends on which kind of link is actually carrying data.
    var ethernetStatus = 'none';
    var airplaneEnabled = false;
    // Local Wi-Fi power toggle. Defaults to true ("Wi-Fi on") and
    // is flipped purely client-side for now — no /api/wifi/power
    // call yet. The Wi-Fi sub-page reads/writes via
    // get/setWifiEnabled and renders the on/off state in its
    // toggle row.
    var wifiEnabled = true;

    function pollBattery() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/power', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                if (data.available && data.capacity !== null) {
                    batteryLevel = data.capacity;
                }
                batteryCharging = (data.status === 'Charging' || data.status === 'Full');
                if (window.requestRender) window.requestRender();
            }
        };
        xhr.send();
    }

    function formatTech(techs) {
        if (!techs || !techs.length) return '--';
        var labels = [];
        for (var i = 0; i < techs.length; i++) {
            var t = techs[i].toLowerCase().replace(/[\s-]/g, '');
            if (t === '5gnr') labels.push('5G');
            else if (t === 'lte') labels.push('LTE');
            else if (t === 'umts' || t === 'hspa' || t === 'hsdpa' || t === 'hsupa') labels.push('3G');
            else if (t === 'gsm' || t === 'gprs' || t === 'edge') labels.push('2G');
            else labels.push(t.toUpperCase());
        }
        return labels.join('+');
    }

    function pollSignal() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/modem', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status === 200) {
                var data = JSON.parse(xhr.responseText);
                modemAvailable = !!data.available;
                if (data.available && data.signalQuality !== null) {
                    signalQuality = data.signalQuality;
                }
                if (data.available && data.accessTech) {
                    accessTech = formatTech(data.accessTech);
                }
                if (window.requestRender) window.requestRender();
            }
        };
        xhr.onerror = xhr.ontimeout = function() {
            modemAvailable = false;
            if (window.requestRender) window.requestRender();
        };
        xhr.send();
    }

    function pollEthernet() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/ethernet', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status !== 200) return;
            var data;
            try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
            // /api/ethernet returns an array of interfaces; classify
            // by whether any *physical* port (end0 / end1) is up vs
            // whether only the USB-gadget interface (flipusb0) is up.
            // The two cases pick different status-bar icons — see
            // `ethernetStatus` for the convention.
            var hasReal = false;
            var hasUsb  = false;
            if (Array.isArray(data)) {
                for (var i = 0; i < data.length; i++) {
                    var iface = data[i];
                    if (!iface || !iface.state) continue;
                    var s = iface.state;
                    var isConn = s.indexOf('connected') !== -1
                                 && s.indexOf('disconnected') === -1;
                    if (!isConn) continue;
                    if (/^flipusb\d*$/i.test(String(iface.name || ''))) {
                        hasUsb = true;
                    } else {
                        hasReal = true;
                    }
                }
            }
            var nextStatus = hasReal ? 'real'
                            : hasUsb ? 'usb'
                            : 'none';
            if (ethernetStatus !== nextStatus) {
                ethernetStatus = nextStatus;
                if (window.requestRender) window.requestRender();
            }
        };
        xhr.send();
    }

    // Hysteresis: a single "disconnected" response is ignored. Only flip
    // to disconnected after 2 consecutive misses (≈4s with the 2s poll).
    // Protects against any residual transient false-negatives.
    var wifiDisconnectStreak = 0;
    var WIFI_DISCONNECT_THRESHOLD = 2;

    function pollWifi() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/wifi', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status !== 200) return;
            var data;
            try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
            var prev = wifiConnected + '|' + wifiQuality + '|' + wifiSSID;
            if (data.connected) {
                wifiConnected = true;
                wifiDisconnectStreak = 0;
                wifiQuality = typeof data.quality === 'number' ? data.quality : wifiQuality;
                wifiSSID = typeof data.ssid === 'string' && data.ssid ? data.ssid : wifiSSID;
            } else {
                wifiDisconnectStreak++;
                if (wifiDisconnectStreak >= WIFI_DISCONNECT_THRESHOLD) {
                    wifiConnected = false;
                    wifiQuality = 0;
                    wifiSSID = '';
                }
            }
            var next = wifiConnected + '|' + wifiQuality + '|' + wifiSSID;
            if (prev !== next && window.requestRender) window.requestRender();
        };
        xhr.send();
    }

    function getWifiInfo() {
        return { connected: wifiConnected, quality: wifiQuality, ssid: wifiSSID };
    }

    // Wi-Fi radio power. Polled from /api/wifi/power every 3 s
    // (see pollWifiPower below); flipped optimistically by
    // setWifiEnabled then reconciled with the server response.
    function pollWifiPower() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/wifi/power', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status !== 200) return;
            try {
                var data = JSON.parse(xhr.responseText);
                var next = !!data.enabled;
                if (next !== wifiEnabled) {
                    wifiEnabled = next;
                    if (window.requestRender) window.requestRender();
                }
            } catch (e) { /* ignore parse errors */ }
        };
        xhr.send();
    }

    function getWifiEnabled() { return wifiEnabled; }
    function setWifiEnabled(enabled) {
        // Optimistic: flip local state and trigger a render
        // immediately so the toggle feels instant. The 3 s
        // poller will reconcile if the actual radio state ends
        // up differently.
        wifiEnabled = !!enabled;
        if (window.requestRender) window.requestRender();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/wifi/power', true);
        xhr.timeout = 3000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ enabled: wifiEnabled }));
    }

    function pollAirplane() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/airplane', true);
        xhr.timeout = 3000;
        xhr.onload = function() {
            if (xhr.status !== 200) return;
            try {
                var data = JSON.parse(xhr.responseText);
                var next = !!data.enabled;
                if (next !== airplaneEnabled) {
                    airplaneEnabled = next;
                    if (window.requestRender) window.requestRender();
                }
            } catch (e) { /* ignore */ }
        };
        xhr.send();
    }

    function getAirplaneMode() {
        return airplaneEnabled;
    }

    function setAirplaneMode(enabled) {
        // Optimistically update local state so the UI reflects the
        // change immediately; the 3s poller will reconcile if the
        // server call fails or produces a different result.
        airplaneEnabled = !!enabled;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/airplane', true);
        xhr.timeout = 3000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            if (xhr.status !== 200) return;
            try {
                var data = JSON.parse(xhr.responseText);
                if (typeof data.enabled === 'boolean') airplaneEnabled = data.enabled;
            } catch (e) { /* ignore */ }
        };
        xhr.send(JSON.stringify({ enabled: airplaneEnabled }));
    }

    function wifiIcon(quality) {
        // Map quality (0-100) to the five icon variants.
        if (quality >= 80) return Icons.wifi_100;
        if (quality >= 60) return Icons.wifi_75;
        if (quality >= 40) return Icons.wifi_50;
        if (quality >= 20) return Icons.wifi_25;
        return Icons.wifi_0;
    }

    // Poll battery every 5 seconds
    pollBattery();
    setInterval(pollBattery, 5000);

    // Poll signal quality every 1 second
    pollSignal();
    setInterval(pollSignal, 1000);

    // Poll wifi every 2 seconds
    pollWifi();
    setInterval(pollWifi, 2000);

    // Poll ethernet every 2 seconds
    pollEthernet();
    setInterval(pollEthernet, 2000);

    // Poll airplane-mode state every 3 seconds.
    pollAirplane();
    setInterval(pollAirplane, 3000);

    // Wi-Fi radio power state — kept in sync with `nmcli radio
    // wifi`. The toggle in the Wi-Fi sub-page calls
    // setWifiEnabled() which optimistically flips the local flag
    // and POSTs to /api/wifi/power; this 3 s poller reconciles in
    // case the server-side state differs.
    pollWifiPower();
    setInterval(pollWifiPower, 3000);

    function formatDateTime() {
        var now = new Date();
        var hours = String(now.getHours()).padStart(2, '0');
        var minutes = String(now.getMinutes()).padStart(2, '0');
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var month = months[now.getMonth()];
        var day = String(now.getDate()).padStart(2, '0');
        return hours + ':' + minutes + ' ' + month + ' ' + day;
    }

    function drawBattery(canvas, x, y, pct) {
        // Battery body: 9x5 outline
        canvas.drawFrame(x, y, 9, 5, '#000');
        // Nub on right: 1x3
        canvas.drawRect(x + 9, y + 1, 1, 3, '#000');
        // Fill: max 5px wide inside body
        var fillW = Math.round(5 * (pct / 100));
        if (fillW > 0) {
            canvas.drawRect(x + 2, y + 2, fillW, 1, '#000');
        }
    }

    function drawSignalBars(canvas, x, topY, quality, fg, dim) {
        // 5 signal bars: heights 3, 4, 5, 6, 7 from left to right.
        // `topY` is where the TOP of the tallest bar sits; shorter bars
        // share the same bottom as the tallest.
        var heights = [3, 4, 5, 6, 7];
        var tallest = 7;
        var barX = x;
        var barBottom = topY + tallest;

        var filledBars = 0;
        if (quality >= 0) {
            filledBars = Math.ceil((quality / 100) * 5);
        }

        for (var i = 0; i < 5; i++) {
            var h = heights[i];
            var barY = barBottom - h;
            var color = (i < filledBars) ? fg : dim;
            canvas.drawRect(barX, barY, 1, h, color);
            barX += 2;  // 1px bar + 1px gap
        }
    }

    function drawStatusBar(canvas, title, opts) {
        // Default dark theme (black bar, white foreground). A scene can
        // pass `{ bg, fg, dim }` to override — Desktop uses #EEEEEE bg
        // with #000 fg, for example.
        opts = opts || {};
        var bg  = opts.bg  || '#000';
        var fg  = opts.fg  || '#fff';
        var dim = opts.dim || '#ccc';  // empty signal bars / soft accents

        canvas.drawRect(0, 0, canvas.w, STATUS_BAR_H, bg);
        var top = STATUS_BAR_PAD_TOP;

        canvas.drawText(title, PAD_LEFT, top, fg);

        // Left-side network indicators are laid out left-to-right, only
        // showing elements whose underlying interface is present.
        var leftX = 2;
        if (modemAvailable) {
            drawSignalBars(canvas, leftX, top, signalQuality, fg, dim);
            leftX += 10;  // 5 bars × 1px + 4 gaps × 1px + 1px trailing gap
            HaxrCorp4090FlipCTL.draw(canvas.ctx, accessTech, leftX, top, fg);
            leftX += HaxrCorp4090FlipCTL.textWidth(accessTech) + 2;
        }
        if (wifiConnected) {
            canvas.drawSprite(wifiIcon(wifiQuality), leftX, top, fg);
            leftX += 7 + 2;
        }
        if (ethernetStatus === 'real') {
            canvas.drawSprite(Icons.ethernet_statusbar, leftX, top, fg);
            leftX += Icons.ethernet_statusbar.w + 2;
        } else if (ethernetStatus === 'usb' && Icons.usb_ethetrnet_status_bar) {
            // Only the USB-gadget link is up — surface the dedicated
            // icon so the bar visually signals "back-channel only".
            // (Icon name preserves the asset's existing spelling.)
            canvas.drawSprite(Icons.usb_ethetrnet_status_bar, leftX, top, fg);
            leftX += Icons.usb_ethetrnet_status_bar.w + 2;
        }

        // Recording indicator — appended to the left status cluster
        // ONLY while a voice-recorder take is rolling in the
        // background (the recorder isn't the foreground scene). When
        // the recorder is on top you can already see the take, so we
        // suppress it there via window._voiceRecorderForeground. Both
        // flags are owned by the recorder scene. The 7px dot sits at
        // `top`, vertically aligned with the 7px wifi / ethernet icons.
        // It pulses: a sine breathes its alpha so a steady recording
        // reads as "live". We drive the animation the same way scene
        // animations do — requestRender() from within the paint keeps
        // the loop repainting; once recording stops the icon (and this
        // call) drop out, so the pulse stops on its own.
        if (window._voiceRecorderRecording
                && !window._voiceRecorderForeground
                && Icons.records_status_bar) {
            var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);  // 0..1, ~1.6s cycle
            var recAlpha = 0.35 + 0.65 * pulse;                  // never fully gone
            canvas.drawSprite(Icons.records_status_bar, leftX, top, fg, recAlpha);
            leftX += Icons.records_status_bar.w + 2;
            if (typeof window.requestRender === 'function') window.requestRender();
        }

        // Battery sprite (16x9) + percentage, right-aligned. Shares
        // the standalone drawBattery() helper so scenes that want
        // just the battery glyph (no full bar) get identical pixels.
        drawBattery(canvas, fg, top);
    }

    // Battery cluster — percentage text + 16x9 sprite + level bar +
    // optional charging bolt — right-aligned against the canvas's
    // right edge. Extracted from drawStatusBar so scenes can paint
    // the battery indicator on their own (e.g. a chrome-less
    // power-menu screen: black glyph on white, no status-bar
    // background). `fg` colours the text / sprite / bar; `top` is
    // the y origin (the status bar passes STATUS_BAR_PAD_TOP).
    function drawBattery(canvas, fg, top) {
        fg = fg || '#000';
        if (typeof top !== 'number') top = STATUS_BAR_PAD_TOP;

        var pctStr   = batteryLevel >= 0 ? batteryLevel + '%' : '--%';
        var batteryW = StatusBarBattery.sprite.w;
        var batteryX = canvas.w - 2 - batteryW;
        var textX    = batteryX - 1 - HaxrCorp4090FlipCTL.textWidth(pctStr);

        HaxrCorp4090FlipCTL.draw(canvas.ctx, pctStr, textX, top - 2, fg);
        var batteryY = top - 1;
        canvas.drawSprite(StatusBarBattery.sprite, batteryX, batteryY, fg);

        // Battery level bar inside the sprite — offset kept constant
        // relative to the sprite's top-left (sprite is 2 px in from
        // its own left edge, so barX = batteryX + 2).
        var barMaxWidth = 10;
        var barHeight   = 5;
        var barX        = batteryX + 2;
        var barY        = top + 1;
        var barWidth    = Math.round((barMaxWidth * Math.max(0, batteryLevel)) / 100);

        if (barWidth > 0) {
            canvas.drawRect(barX, barY, barWidth, barHeight, fg);
        }

        // Charging bolt overlays the battery icon flush with its
        // left/top edge. Rendered literally so black stays black,
        // white stays white, and transparent lets the battery
        // sprite show through.
        if (batteryCharging) {
            canvas.drawSpriteLiteral(Icons.charging_status_bar, batteryX, batteryY);
        }
    }

    function drawMenuList(canvas, items, selectedIndex, scrollOffset) {
        var startY = STATUS_BAR_H + 2;
        var visible = visibleCount(canvas.h);

        for (var i = 0; i < visible && (i + scrollOffset) < items.length; i++) {
            var idx = i + scrollOffset;
            var y = startY + i * ITEM_H;

            if (idx === selectedIndex) {
                canvas.drawRect(0, y, canvas.w - SCROLLBAR_W - 1, ITEM_H, '#fff');
                canvas.drawText('>' + items[idx], PAD_LEFT, y + 3, '#000');
            } else {
                canvas.drawText(' ' + items[idx], PAD_LEFT, y + 3, '#fff');
            }
        }

        if (items.length > visible) {
            drawScrollbar(canvas, items.length, visible, scrollOffset);
        }
    }

    function drawScrollbar(canvas, totalItems, visibleItems, scrollOffset) {
        var trackX = canvas.w - SCROLLBAR_W;
        var trackY = STATUS_BAR_H + 2;
        var trackH = canvas.h - trackY;

        canvas.drawRect(trackX, trackY, SCROLLBAR_W, trackH, '#333');

        var thumbH = Math.max(8, Math.floor(trackH * (visibleItems / totalItems)));
        var maxOffset = totalItems - visibleItems;
        var thumbY = trackY + (maxOffset > 0 ? Math.floor((trackH - thumbH) * (scrollOffset / maxOffset)) : 0);

        canvas.drawRect(trackX, thumbY, SCROLLBAR_W, thumbH, '#fff');
    }

    function visibleCount(canvasHeight) {
        return Math.floor((canvasHeight - STATUS_BAR_H - 2) / ITEM_H);
    }

    // ── MiddleButton ──────────────────────────────────────────────────────────
    // Button flush with bottom of screen. Rendering is in canvas.drawMiddleButton.
    function _makeButton(drawMethod) {
        return {
            render:  function(canvas) { canvas[drawMethod](this.text, this.x, this.w, this.pressed, this.disabled); },
            press:   function() { if (!this.disabled) this.pressed = true; },
            release: function() { this.pressed = false; }
        };
    }

    // Toggle-button mixin: same press/release as a normal button,
    // plus a `toggled` flag and a `toggle()` flip. render() passes
    // `toggled` through to the draw method (which paints the 2 px
    // top bar accordingly).
    function _makeToggleButton(drawMethod) {
        return {
            render:  function(canvas) { canvas[drawMethod](this.text, this.x, this.w, this.pressed, this.disabled, this.toggled); },
            press:   function() { if (!this.disabled) this.pressed = true; },
            release: function() { this.pressed = false; },
            toggle:  function() { this.toggled = !this.toggled; }
        };
    }

    // Hard cap on app-defined bottom-bar button width: one 48px slot.
    // Clamped in the constructors so both the stored width and the
    // self-positioning (RightButton anchors at screenW - w) use the
    // capped value.
    var MAX_BTN_W = 48;

    // index — slot position (0..N-1), gap — px between buttons
    function MiddleButton(text, index, w, gap, action, onPress) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.text    = text;
        this.x       = index * (w + gap);
        this.w       = w;
        this.pressed = false;
        this.disabled = false;
        this.action  = action  || null;
        this.onPress = onPress || null;
    }
    MiddleButton.prototype = _makeButton('drawMiddleButton');
    // Optional sprite drawn right of the label (set `.icon`); the
    // generic _makeButton render doesn't know the extra arg.
    MiddleButton.prototype.render = function(canvas) {
        canvas.drawMiddleButton(this.text, this.x, this.w,
            this.pressed, this.disabled, this.icon || null);
    };

    // Icon-only middle button — same slot positioning as MiddleButton,
    // but renders a centred icon instead of a text label
    // (canvas.drawMiddleIconButton). `icon` replaces `text`.
    function MiddleIconButton(icon, index, w, gap, action, onPress) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.icon     = icon;
        this.x        = index * (w + gap);
        this.w        = w;
        this.pressed  = false;
        this.disabled = false;
        this.action   = action  || null;
        this.onPress  = onPress || null;
    }
    MiddleIconButton.prototype = {
        render:  function(canvas) { canvas.drawMiddleIconButton(this.icon, this.x, this.w, this.pressed, this.disabled, this.iconDy || 0); },
        press:   function() { if (!this.disabled) this.pressed = true; },
        release: function() { this.pressed = false; }
    };

    // Toggle variant of the middle button — same slot-indexed
    // positioning, plus a `toggled` state shown as a 2 px bar on
    // top (black when on, gray when off). `toggle()` flips it.
    function MiddleToggleButton(text, index, w, gap, action, onPress, toggled) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.text     = text;
        this.x        = index * (w + gap);
        this.w        = w;
        this.pressed  = false;
        this.disabled = false;
        this.toggled  = !!toggled;
        this.action   = action  || null;
        this.onPress  = onPress || null;
    }
    MiddleToggleButton.prototype = _makeToggleButton('drawMiddleToggleButton');

    // Icon toggle button — MiddleToggleButton with a centred icon
    // instead of a text label (canvas.drawMiddleIconToggleButton).
    function MiddleIconToggleButton(icon, index, w, gap, action, onPress, toggled) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.icon     = icon;
        this.x        = index * (w + gap);
        this.w        = w;
        this.pressed  = false;
        this.disabled = false;
        this.toggled  = !!toggled;
        this.action   = action  || null;
        this.onPress  = onPress || null;
    }
    MiddleIconToggleButton.prototype = {
        render:  function(canvas) { canvas.drawMiddleIconToggleButton(this.icon, this.x, this.w, this.pressed, this.disabled, this.toggled, this.iconDy || 0); },
        press:   function() { if (!this.disabled) this.pressed = true; },
        release: function() { this.pressed = false; },
        toggle:  function() { this.toggled = !this.toggled; }
    };

    // Left button — always flush with left screen edge (x = 0)
    function LeftButton(text, w, action, onPress) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.text    = text;
        this.x       = 0;
        this.w       = w;
        this.pressed = false;
        this.disabled = false;
        this.action  = action  || null;
        this.onPress = onPress || null;
    }
    LeftButton.prototype = _makeButton('drawLeftButton');

    // Right button — always flush with right screen edge (x = screenW - w)
    function RightButton(text, w, action, onPress, screenW) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.text    = text;
        this.x       = (screenW || 256) - w;
        this.w       = w;
        this.pressed = false;
        this.disabled = false;
        this.action  = action  || null;
        this.onPress = onPress || null;
    }
    RightButton.prototype = _makeButton('drawRightButton');

    // Right button variant with the top black stroke cut short on
    // the right (see canvas.drawRightButtonTopCut). Same flush-right
    // positioning and 48 px cap as RightButton — only the draw
    // method differs, so the stock RightButton is left untouched.
    function RightButtonTopCut(text, w, action, onPress, screenW) {
        if (w > MAX_BTN_W) w = MAX_BTN_W;
        this.text    = text;
        this.x       = (screenW || 256) - w;
        this.w       = w;
        this.pressed = false;
        this.disabled = false;
        this.action  = action  || null;
        this.onPress = onPress || null;
        // Optional icon drawn above the label; null → media_small
        // (the default, applied in the canvas draw method).
        this.icon    = null;
    }
    RightButtonTopCut.prototype = _makeButton('drawRightButtonTopCut');
    // Override render to pass the optional icon through to the canvas.
    RightButtonTopCut.prototype.render = function(canvas) {
        canvas.drawRightButtonTopCut(this.text, this.x, this.w,
            this.pressed, this.disabled, this.icon);
    };

    // Numeric-layout tab button — visual cousin of MiddleButton
    // with the corner radii flipped (square top, rounded bottom).
    // Positioned absolutely via (x, y) rather than slot-indexed,
    // so callers anchor it wherever they want above the standard
    // bottom-button row. Shares the same press/release flash and
    // action-key wiring as the other bottom buttons.
    function NumericTabButton(text, x, y, w, action, onPress) {
        this.text     = text;
        this.x        = x;
        this.y        = y;
        this.w        = w;
        this.pressed  = false;
        this.disabled = false;
        this.selected = false;
        this.action   = action  || null;
        this.onPress  = onPress || null;
    }
    NumericTabButton.prototype.render = function(canvas) {
        canvas.drawNumericTabButton(this.text, this.x, this.y, this.w,
            this.pressed, this.disabled);
    };
    // The selector frame paints in a separate pass so the owning
    // scene can render it AFTER other UI it might overlap (e.g.,
    // the keyboard chrome that visually sits just above the
    // button). Always layers on top, never gets overdrawn.
    NumericTabButton.prototype.renderSelector = function(canvas) {
        if (this.selected) {
            canvas.drawNumericTabButtonSelector(this.x, this.y, this.w);
        }
    };
    NumericTabButton.prototype.press   = function() { if (!this.disabled) this.pressed = true; };
    NumericTabButton.prototype.release = function() { this.pressed = false; };

    // Icon-content cousin of NumericTabButton — same square-top,
    // rounded-bottom shape and same selector wraparound, but
    // renders a centred icon instead of a text label. Used for
    // the backspace tab that mirrors the 123 tab on the
    // opposite side of the screen.
    function IconTabButton(icon, x, y, w, action, onPress) {
        this.icon     = icon;
        this.x        = x;
        this.y        = y;
        this.w        = w;
        this.pressed  = false;
        this.disabled = false;
        this.selected = false;
        this.action   = action  || null;
        this.onPress  = onPress || null;
    }
    IconTabButton.prototype.render = function(canvas) {
        canvas.drawIconTabButton(this.icon, this.x, this.y, this.w,
            this.pressed, this.disabled);
    };
    IconTabButton.prototype.renderSelector = function(canvas) {
        if (this.selected) {
            canvas.drawNumericTabButtonSelector(this.x, this.y, this.w);
        }
    };
    IconTabButton.prototype.press   = function() { if (!this.disabled) this.pressed = true; };
    IconTabButton.prototype.release = function() { this.pressed = false; };

    // ── PopupMenuLeft ────────────────────────────────────────────────────────
    // Popup menu that appears above a button, replacing it with a tab.
    // items    — array of label strings
    // btnX     — left edge x position of the trigger button
    // tabW     — width of the tab (button width, e.g., 48px)
    // btnText  — fixed text for the tab (e.g., 'Edit')
    // onSelect(index) — called when the user confirms a selection
    // onClose()       — called when the popup is dismissed (esc / back)

    var POPUP_ITEM_H = 13;  // px per menu item
    var POPUP_PAD = 3;      // left/right/top/bottom padding inside body

    function PopupMenuLeft(items, btnX, tabW, btnText, onSelect, onClose) {
        this.items = items;
        this.btnX = btnX;
        this.tabW = tabW;
        this.btnText = btnText;  // fixed button text for the tab
        this.selIndex = 0;
        this.pressedIndex = -1;  // Track which item is pressed
        this.onSelect = onSelect || null;
        this.onClose = onClose || null;

        // Calculate body width: longest item text + left/right padding (7px each)
        var maxItemWidth = 0;
        for (var i = 0; i < items.length; i++) {
            var w = HaxrCorp4090FlipCTL.textWidth(items[i]);
            if (w > maxItemWidth) maxItemWidth = w;
        }
        var contentWidth = maxItemWidth + 7 + 7;  // 7px left + 7px right padding
        var minWidth = tabW + 5;  // button width + 5px padding
        this.bodyW = Math.max(contentWidth, minWidth);

        // Calculate body height: items + top/bottom padding
        this.bodyH = items.length * POPUP_ITEM_H + 2 * POPUP_PAD;

        // Position: left-aligned with button, 4px above bottom (where tab sits)
        this.x = btnX;
        this.y = 144 - 14 - this.bodyH - 4;  // 144px screen height, 14px tab, 4px gap
    }

    PopupMenuLeft.prototype.render = function(canvas) {
        // Draw shell (body + tab)
        canvas.drawPopupLeft(this.x, this.y, this.bodyW, this.bodyH, this.tabW, '#fff', '#D0D0D0', '#000');

        // Draw menu items
        for (var i = 0; i < this.items.length; i++) {
            var iy = this.y + POPUP_PAD + i * POPUP_ITEM_H;

            // Draw selection highlight (not when pressed)
            if (i === this.selIndex && i !== this.pressedIndex) {
                canvas.drawRoundFrame(this.x + POPUP_PAD, iy, this.bodyW - 2 * POPUP_PAD, POPUP_ITEM_H, 2, '#000');
            }

            // Draw pressed highlight (inverted - black background with white text)
            if (i === this.pressedIndex) {
                canvas.drawRoundRect(this.x + POPUP_PAD, iy, this.bodyW - 2 * POPUP_PAD, POPUP_ITEM_H, 2, '#000');
            }

            // Draw item text (4px + 3px padding from left edge)
            var textColor = (i === this.pressedIndex) ? '#fff' : '#000';
            HaxrCorp4090FlipCTL.draw(canvas.ctx, this.items[i], this.x + 7, iy + 1, textColor);
        }

        // Draw tab label (button text — centered in tab)
        var tw = HaxrCorp4090FlipCTL.textWidth(this.btnText);
        var ttx = this.x + Math.floor((this.tabW - tw) / 2);
        var tty = this.y + this.bodyH + Math.floor((17 - 11) / 2);
        HaxrCorp4090FlipCTL.draw(canvas.ctx, this.btnText, ttx, tty, '#000');
    };

    PopupMenuLeft.prototype.handleInput = function(action) {
        var self = this;
        if (action === 'up') {
            this.selIndex = (this.selIndex - 1 + this.items.length) % this.items.length;
        } else if (action === 'down') {
            this.selIndex = (this.selIndex + 1) % this.items.length;
        } else if (action === 'ok') {
            // Show pressed feedback
            this.pressedIndex = this.selIndex;
            // Call onSelect after feedback delay
            setTimeout(function() {
                if (self.onSelect) self.onSelect(self.selIndex);
                self.pressedIndex = -1;
            }, 150);
        } else if (action === 'esc' || action === 'back') {
            if (this.onClose) this.onClose();
        }
    };

    // ── Keyboard ──────────────────────────────────────────────────────────────
    // Virtual keyboard popup with multiple rows
    var KEYBOARD_SHIFT_CHAR = '⇧';
    // Private-use-area sentinel matching the one used by drawKeyboard
    // for the language-switcher key. The owning scene gets no onChar
    // callback for it — the key is purely visual right now.
    var KEYBOARD_LANG_CHAR  = '⌘';

    function Keyboard(rows, onChar, onClose) {
        this.rows = rows;
        // Initial cursor position. Skip row 0 if it's a peek row
        // (carries a number-tab strip above the QWERTY row) — the
        // user wants to land on QWERTY, not on the peek strip,
        // because the peek is an opt-in extra reachable via Up.
        var initialRow = 0;
        var firstCellInRow0 = rows[0] && rows[0][0];
        if (firstCellInRow0
                && typeof firstCellInRow0 === 'object'
                && firstCellInRow0.peek) {
            initialRow = 1;
        }
        this.selectedRow = initialRow;
        this.selectedCol = 0;
        this.onChar = onChar || null;   // Called with character when ok pressed
        this.onClose = onClose || null; // Called when esc pressed
        this.pressedRow = -1;
        this.pressedCol = -1;  // Track which button is pressed
        // Focus state. When false, the renderer skips the selector
        // pass and the peek-row wave collapses to amp=0 — used by
        // the owning scene to "park" focus on a sibling control
        // (e.g., the 123 tab button) without losing the keyboard's
        // last selection coordinates.
        this.focused = true;
        // Tri-state shift:
        //   'off'   — letters lowercase (default).
        //   'shift' — next letter uppercased, then auto-releases
        //             back to 'off' (Camel-Case use case).
        //   'caps'  — every letter uppercased until toggled off
        //             (caps lock; entered via long-press handled
        //             externally by the owning scene).
        // Single tap on the shift key cycles 'off' ↔ 'shift';
        // 'caps' is reachable only via long-press, and any tap
        // while in 'caps' returns to 'off'.
        this.shiftState = 'off';
        // Optional gray label rendered in the top-row left-pad
        // area (above the wide cell at row [last-1][0]). 'EN' for
        // the alphabetic layout; the owning scene swaps to '123' /
        // 'ABC' / etc. when it changes layouts. Set to '' or null
        // to suppress.
        this.langLabel = 'EN';

        // Position: centered on screen in container
        var BTN_W = 15;
        var BTN_H = 16;
        var CONTAINER_W = 250;
        var CONTAINER_H = 77;
        var cols = rows[0].length;
        var keyboardW = cols * BTN_W;
        var keyboardH = rows.length * BTN_H;

        this.x = Math.floor((256 - CONTAINER_W) / 2);
        this.y = 75;  // 75px from top of screen — bumped 72 → 74 → 75 across two iteration passes so the keyboard chrome (and the inner-background rectangle drawn against it) sits 3 px lower under the input field. Pixel-perfect with the other rounded-corner chrome in the system.
        this.w = CONTAINER_W;
        this.h = CONTAINER_H;
    }

    // Duration of the peek-row wave transition, ms. One value
    // drives every kind of selection change inside or around the
    // peek strip — entering the strip from below, hopping from
    // one digit to another, or collapsing back to QWERTY. Each
    // transition lerps the wave's CENTRE (fractional column) and
    // AMPLITUDE (0 collapsed → 1 fully extended) from their
    // current eased values to the new target, so back-to-back
    // moves chain smoothly instead of snapping at the boundary.
    var KB_PEEK_WAVE_MS = 160;

    // Returns the current { center, amp } of the peek-row wave at
    // wall-clock time `now` (ms). Folds any in-progress animation
    // into a single instantaneous value — callers don't need to
    // know whether they're mid-transition.
    function kbEvaluatePeekWave(kb, now) {
        var anim = kb._peekWaveAnim;
        if (!anim) {
            return {
                center: kb._peekWaveRestCenter != null ? kb._peekWaveRestCenter : 0,
                amp:    kb._peekWaveRestAmp    != null ? kb._peekWaveRestAmp    : 0
            };
        }
        var t = (now - anim.startMs) / anim.duration;
        if (t >= 1) t = 1;
        if (t < 0)  t = 0;
        var eased = 1 - Math.pow(1 - t, 3);
        return {
            center: anim.fromCenter + (anim.toCenter - anim.fromCenter) * eased,
            amp:    anim.fromAmp    + (anim.toAmp    - anim.fromAmp)    * eased
        };
    }

    function kbNowMs() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
    }

    Keyboard.prototype.render = function(canvas, betweenCellsAndSelector) {
        // Resolve the peek-row wave's live state. If an animation
        // is in flight, evaluate its eased position; once it
        // completes, latch the target as the new resting state
        // and clear the animation handle so we stop asking for
        // more frames.
        var now = kbNowMs();
        var wave = kbEvaluatePeekWave(this, now);
        if (this._peekWaveAnim) {
            var ageMs = now - this._peekWaveAnim.startMs;
            if (ageMs >= this._peekWaveAnim.duration) {
                this._peekWaveRestCenter = this._peekWaveAnim.toCenter;
                this._peekWaveRestAmp    = this._peekWaveAnim.toAmp;
                this._peekWaveAnim = null;
            } else if (typeof window !== 'undefined' && window.requestRender) {
                window.requestRender();
            }
        }
        // Optional interlayer callback is invoked by the
        // renderer AFTER the cells paint and BEFORE the selector
        // frame, so the scene can sandwich overlays (e.g. the
        // 123 tab) between the keyboard's body and its
        // selection ring. Pass-through.
        canvas.drawKeyboard(this.x, this.y, this.rows,
            this.selectedRow, this.selectedCol,
            this.pressedRow, this.pressedCol,
            '#fff', '#000', this.shiftState, this.langLabel,
            wave, this.focused !== false,
            betweenCellsAndSelector);
    };

    // External focus toggle. Triggers a wave re-evaluation so
    // toggling focus while the wave is mid-animation re-targets
    // smoothly (e.g., handing focus away mid-rise collapses the
    // wave from its current eased position rather than snapping).
    Keyboard.prototype.setFocused = function(flag) {
        var next = !!flag;
        if (this.focused === next) return;
        this.focused = next;
        this._driveWaveToCurrentSelection();
        if (typeof window !== 'undefined' && window.requestRender) {
            window.requestRender();
        }
    };

    // Snap the peek-row wave to whatever shape matches the current
    // (rows, selection, focus) state — no animation. Used by
    // owning scenes when they swap `this.rows` for a different
    // layout. Without this, a wave state computed against the
    // outgoing layout (e.g., amp=1 centred on a peek cell) would
    // bleed into the incoming layout and play back as a "leftover"
    // collapse animation when the user is no longer near the peek
    // row.
    Keyboard.prototype.syncWaveToSelection = function() {
        var onPeekRow = kbHasPeekRow(this.rows)
            && this.focused !== false
            && this.selectedRow === 0;
        this._peekWaveRestCenter = onPeekRow ? this.selectedCol : 0;
        this._peekWaveRestAmp    = onPeekRow ? 1 : 0;
        this._peekWaveAnim       = null;
        if (typeof window !== 'undefined' && window.requestRender) {
            window.requestRender();
        }
    };

    // Geometry constants kept in lock-step with `canvas.drawKeyboard`
    // so the Keyboard component can reason about visual column
    // positions without having to ask the renderer. If those
    // change, update both places.
    var KB_BTN_W   = 15;
    var KB_SHIFT_W = 35;
    // Width of a single cell at (rowIdx, colIdx). Wide cells
    // (object form with `wide:true`, or the row-positional
    // SHIFT_CHAR / LANG_CHAR sentinels) measure SHIFT_W; everything
    // else measures BTN_W.
    function kbCellIsWide(rows, rowIdx, colIdx) {
        var raw = rows[rowIdx][colIdx];
        if (raw && typeof raw === 'object') return !!raw.wide;
        var lastRow      = rowIdx === rows.length - 1;
        var aboveLastRow = rowIdx === rows.length - 2;
        if (lastRow      && colIdx === 0 && raw === KEYBOARD_SHIFT_CHAR) return true;
        if (aboveLastRow && colIdx === 0 && raw === KEYBOARD_LANG_CHAR)  return true;
        return false;
    }
    function kbCellW(rows, rowIdx, colIdx) {
        return kbCellIsWide(rows, rowIdx, colIdx) ? KB_SHIFT_W : KB_BTN_W;
    }
    // Per-row leading-wide width: equals SHIFT_W if the row's
    // first cell is wide, else 0. Used to align the alphabetic
    // columns across rows that have / don't have a shift / lang
    // key on the left.
    function kbRowLeadingWide(rows, rowIdx) {
        return kbCellIsWide(rows, rowIdx, 0) ? KB_SHIFT_W : 0;
    }
    function kbMaxLeadingWide(rows) {
        var m = 0;
        for (var r = 0; r < rows.length; r++) {
            var lw = kbRowLeadingWide(rows, r);
            if (lw > m) m = lw;
        }
        return m;
    }
    function kbRowLeftOffset(rows, rowIdx) {
        return kbMaxLeadingWide(rows) - kbRowLeadingWide(rows, rowIdx);
    }
    // Visual centre x of a cell, measured from the keyboard's
    // left edge. Sums the leading offset + every cell width to
    // the left of `colIdx`, plus half this cell's own width.
    function kbCellCenterX(rows, rowIdx, colIdx) {
        var x = kbRowLeftOffset(rows, rowIdx);
        for (var c = 0; c < colIdx; c++) x += kbCellW(rows, rowIdx, c);
        return x + kbCellW(rows, rowIdx, colIdx) / 2;
    }
    // Walk every cell in `rowIdx` and return the column index
    // whose centre is closest to `targetX`. Used by up / down
    // navigation to land on the visually-aligned cell instead
    // of the same array index (which can drift when adjacent
    // rows differ in their leading wide cell).
    function kbClosestCol(rows, rowIdx, targetX) {
        var best = 0, bestDist = Infinity;
        for (var c = 0; c < rows[rowIdx].length; c++) {
            var d = Math.abs(kbCellCenterX(rows, rowIdx, c) - targetX);
            if (d < bestDist) { bestDist = d; best = c; }
        }
        return best;
    }

    // Returns true when row 0 of `rows` is the peek-tab row
    // (its first cell carries `peek: true`). The renderer treats
    // such a row specially — only the top 2 px shows when not
    // selected — and the Keyboard component uses the same flag to
    // decide whether to fire a deselect slide-back animation.
    function kbHasPeekRow(rows) {
        var firstCell = rows[0] && rows[0][0];
        return !!(firstCell && typeof firstCell === 'object' && firstCell.peek);
    }

    // Drive the peek-row wave toward whatever shape matches the
    // current (selectedRow, selectedCol). Called from any path
    // that changes selection. Behaviour:
    //   • On peek row → target amplitude = 1, centre = selectedCol.
    //   • Off peek row → target amplitude = 0, centre frozen at
    //     its current value so the wave collapses straight down
    //     in place rather than sliding sideways as it shrinks.
    //   • When the wave is currently flat (amp ≈ 0) and we're
    //     entering the row, snap the from-centre to the new
    //     column so the wave rises in place instead of sweeping
    //     in from column 0.
    Keyboard.prototype._driveWaveToCurrentSelection = function() {
        if (!kbHasPeekRow(this.rows)) return;
        var now = kbNowMs();
        var cur = kbEvaluatePeekWave(this, now);
        // The wave only animates "up" when (a) selection is on the
        // peek row, and (b) the keyboard actually has focus.
        // Defocusing the keyboard (e.g., handing focus to the 123
        // tab) collapses the wave even if selectedRow stays at 0.
        var onPeekRow = this.focused !== false && (this.selectedRow === 0);
        var fromCenter = cur.center;
        var fromAmp    = cur.amp;
        var toCenter   = onPeekRow ? this.selectedCol : cur.center;
        var toAmp      = onPeekRow ? 1 : 0;
        // Wave was fully collapsed and we just arrived on the row
        // — anchor from-centre at the landing column so the rise
        // happens in place. Without this the centre would lerp
        // from a stale value (e.g. 0) toward the landing column
        // and the wave would visibly sweep into position.
        if (onPeekRow && fromAmp < 0.01) {
            fromCenter = this.selectedCol;
        }
        // No-op if the target matches the current state to within
        // a pixel — avoids restarting an animation every frame
        // when nothing changed.
        if (Math.abs(fromCenter - toCenter) < 0.001
                && Math.abs(fromAmp - toAmp) < 0.001) {
            return;
        }
        this._peekWaveAnim = {
            startMs:    now,
            duration:   KB_PEEK_WAVE_MS,
            fromCenter: fromCenter,
            fromAmp:    fromAmp,
            toCenter:   toCenter,
            toAmp:      toAmp
        };
        if (typeof window !== 'undefined' && window.requestRender) {
            window.requestRender();
        }
    };

    // Move the cursor to `targetRow`, snapping the column to
    // whichever cell in that row is visually closest in x to the
    // current selection — same kbClosestCol logic used by the
    // built-in Up/Down arrow handlers. Used by the owning scene
    // when an external control (e.g. the 123 tab) hands focus
    // back to the keyboard at a particular row.
    Keyboard.prototype.snapToRow = function(targetRow) {
        if (targetRow < 0) targetRow = 0;
        if (targetRow > this.rows.length - 1) {
            targetRow = this.rows.length - 1;
        }
        var srcX = kbCellCenterX(this.rows, this.selectedRow, this.selectedCol);
        var newCol = kbClosestCol(this.rows, targetRow, srcX);
        this.setSelection(targetRow, newCol);
    };

    // External setters that need the same animation hook as
    // handleInput. Owning scenes (e.g. KeyboardTestScene's
    // touchpad-driven selection) should call this instead of
    // mutating `selectedRow` / `selectedCol` directly.
    Keyboard.prototype.setSelection = function(row, col) {
        var prevRow = this.selectedRow;
        var prevCol = this.selectedCol;
        this.selectedRow = row;
        this.selectedCol = col;
        if (row !== prevRow || col !== prevCol) {
            this._driveWaveToCurrentSelection();
        }
    };

    Keyboard.prototype.handleInput = function(action) {
        // Snapshot the (row, col) the cursor sits on BEFORE the
        // action runs. If the action moves selection off a peek-
        // row cell, we use this snapshot to kick off the slide-
        // back-down animation in render().
        var prevRow = this.selectedRow;
        var prevCol = this.selectedCol;
        if (action === 'left') {
            this.selectedCol = (this.selectedCol - 1 + this.rows[this.selectedRow].length) % this.rows[this.selectedRow].length;
        } else if (action === 'right') {
            this.selectedCol = (this.selectedCol + 1) % this.rows[this.selectedRow].length;
        } else if (action === 'up') {
            // Capture current visual centre BEFORE advancing the
            // row so the column-alignment algorithm sees the
            // source row's geometry. Wrap row index, then snap to
            // the column whose centre lines up.
            var upX = kbCellCenterX(this.rows, this.selectedRow, this.selectedCol);
            this.selectedRow = (this.selectedRow - 1 + this.rows.length) % this.rows.length;
            this.selectedCol = kbClosestCol(this.rows, this.selectedRow, upX);
        } else if (action === 'down') {
            var dnX = kbCellCenterX(this.rows, this.selectedRow, this.selectedCol);
            this.selectedRow = (this.selectedRow + 1) % this.rows.length;
            this.selectedCol = kbClosestCol(this.rows, this.selectedRow, dnX);
        } else if (action === 'ok') {
            // Cells can be strings (single-char keys) OR objects
            // {text, isShift, isLang, onPress, ...} (custom wide
            // cells in alternate layouts). Extract a uniform text
            // + flags + optional onPress callback.
            var raw = this.rows[this.selectedRow][this.selectedCol];
            var char, isShiftCell, isLangCell, isBackspaceCell, isReturnCell, isNavCell, cellOnPress;
            if (raw && typeof raw === 'object') {
                char            = raw.text != null ? raw.text : '';
                isShiftCell     = !!raw.isShift;
                isLangCell      = !!raw.isLang;
                isBackspaceCell = !!raw.isBackspace;
                isReturnCell    = !!raw.isReturn;
                isNavCell       = !!raw.isKeyboardUp || !!raw.isKeyboardDown;
                cellOnPress     = (typeof raw.onPress === 'function') ? raw.onPress : null;
            } else {
                char            = raw;
                isShiftCell     = (char === KEYBOARD_SHIFT_CHAR);
                isLangCell      = (char === KEYBOARD_LANG_CHAR);
                isBackspaceCell = false;
                isReturnCell    = false;
                isNavCell       = false;
                cellOnPress     = null;
            }
            // Brief press flash on the highlighted key — applies
            // to the shift toggle too, so the user gets visual
            // confirmation of the tap independent of the shift
            // state's persistent fill.
            this.pressedRow = this.selectedRow;
            this.pressedCol = this.selectedCol;
            var self = this;
            setTimeout(function() {
                self.pressedRow = -1;
                self.pressedCol = -1;
            }, 100);
            // Cell-level onPress (e.g. the symbols-layout's
            // <>| button switching to the second symbols layout).
            // Fires before / instead of any text emission.
            if (cellOnPress) {
                cellOnPress();
                return;
            }
            // Shift key: tap-cycle between 'off' and 'shift'. From
            // 'caps' a tap also returns to 'off'. The 'caps' state
            // itself is only reachable via long-press — that's
            // handled externally by the owning scene, which sets
            // `this.shiftState = 'caps'` directly.
            if (isShiftCell) {
                this.shiftState = (this.shiftState === 'off') ? 'shift' : 'off';
                return;
            }
            // Language-switcher sentinel: no behaviour wired up at
            // this layer. Press flash already happened above; the
            // owning scene watches `selectedRow`/`Col` directly to
            // implement layout switching if it wants to.
            if (isLangCell) {
                return;
            }
            // Wide backspace key — same semantics as the 'back'
            // action below: emits '\b' through onChar so the
            // owning scene deletes the trailing character.
            if (isBackspaceCell) {
                if (this.onChar) this.onChar('\b');
                return;
            }
            // Wide return key — emit the sentinel return value
            // 'done' so the owning scene can treat it like the
            // bottom-bar Done button (e.g. KeyboardTestScene
            // pops the scene). For multi-line consumers a
            // future patch can route this through onChar('\n')
            // instead; for now the single-line "commit + close"
            // affordance is what every caller wants.
            if (isReturnCell) {
                return 'done';
            }
            // Form-navigation arrow cells (Up / Down). The
            // visual is in place; the actual "move caret to the
            // previous/next field" behaviour is a follow-up
            // task. For now they swallow OK so no character
            // emission leaks out.
            if (isNavCell) {
                return;
            }
            // Uppercase alphabetic chars while shift is active.
            // Non-letters (numbers, punctuation, space) pass through
            // unchanged. After firing one upper-cased letter while
            // in 'shift' (one-shot), auto-release back to 'off' —
            // the Camel-Case affordance the user described. 'caps'
            // stays latched until the next tap on the shift key.
            // Multi-char labels (e.g. SYM layout's "<>|") fall
            // through unchanged.
            var emit = char;
            if (this.shiftState !== 'off' && typeof char === 'string'
                    && char.length === 1 && /^[a-z]$/.test(char)) {
                emit = char.toUpperCase();
                if (this.shiftState === 'shift') this.shiftState = 'off';
            }
            if (this.onChar) this.onChar(emit);
        } else if (action === 'back') {
            // Back key deletes character (backspace)
            if (this.onChar) this.onChar('\b');
        } else if (action === 'esc') {
            if (this.onClose) this.onClose();
        }

        // Peek-row wave driver. Whenever selection moves, retune
        // the wave toward the new (row, col) — covers entering
        // the strip from QWERTY, sliding between digits, and
        // collapsing back down on Down arrow.
        if (this.selectedRow !== prevRow || this.selectedCol !== prevCol) {
            this._driveWaveToCurrentSelection();
        }
    };

    // ── TabHeader ─────────────────────────────────────────────────────────────
    // Tab header above main input box with rounded top corners (r=4)
    // x coincides with TextInputBox (x=6)
    // Black background with white text
    function TabHeader(text) {
        this.x = 6;
        this.y = 3;          // 3px from top
        this.text = text || '';
        this.h = 16;         // Height of tab
        // Width: text width + 3px padding on each side
        this.w = HaxrCorp4090FlipCTL.textWidth(this.text) + 6;
    }

    TabHeader.prototype.render = function(canvas) {
        // Draw black background with rounded top corners
        canvas.drawTabHeader(this.x, this.y, this.w, this.h);
        // Draw white text (centered vertically)
        var textY = this.y + Math.floor((this.h - 11) / 2);  // 11 is font height
        HaxrCorp4090FlipCTL.draw(canvas.ctx, this.text, this.x + 3, textY, '#fff');
    };

    // ── TextInputBox ──────────────────────────────────────────────────────
    // Container for text input with rounded top corners
    // Positioned 16px from top, extends to keyboard at 70px
    // Height: 54px, Width: 244px (256 - 6px padding left - 6px padding right)
    function TextInputBox() {
        this.x = 6;
        this.y = 16;
        this.w = 244;  // 256 - 12 (6px padding each side)
        this.h = 54;  // 70 - 16
    }

    TextInputBox.prototype.render = function(canvas) {
        canvas.drawTextInputBox(this.x, this.y, this.w, this.h, '#fff', '#000');
    };

    // ── InputField ────────────────────────────────────────────────────────────
    // Input field with rounded corners (r=3)
    // Height: 14px, positioned inside TextInputBox with padding
    function InputField() {
        this.x = 22;         // 6px screen padding + 6px box padding + 10px field padding
        this.y = 26;         // Inside TextInputBox (starts at 16) with 10px padding
        this.w = 212;        // 244 (box width) - 6px left padding - 6px right padding - 10px left - 10px right
        this.h = 14;
    }

    InputField.prototype.render = function(canvas) {
        canvas.drawInputField(this.x, this.y, this.w, this.h, 3, '#fff', '#000');
    };

    // ── DeleteConfirmDialog ────────────────────────────────────────────────────
    // Modal dialog for confirming profile deletion or reset
    function DeleteConfirmDialog(profileName, onConfirm, onCancel, action) {
        this.profileName = profileName;
        this.onConfirm = onConfirm || null;
        this.onCancel = onCancel || null;
        this.action = action || 'Delete';  // 'Delete' or 'Reset to default'
    }

    DeleteConfirmDialog.prototype.render = function(canvas) {
        // Draw semi-transparent overlay
        canvas.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        canvas.ctx.fillRect(0, 0, canvas.w, canvas.h);

        // Draw modal box
        var boxW = 200;
        var boxH = 40;
        var boxX = Math.floor((canvas.w - boxW) / 2);
        var boxY = Math.floor((canvas.h - boxH) / 2);

        // White background
        canvas.drawRoundRect(boxX, boxY, boxW, boxH, 3, '#fff');
        // Black border
        canvas.drawRoundFrame(boxX, boxY, boxW, boxH, 3, '#000');

        // Draw text (centered)
        var messageText = this.action + ' "' + this.profileName + '"?';
        var messageWidth = HaxrCorp4090FlipCTL.textWidth(messageText);
        var messageX = boxX + Math.floor((boxW - messageWidth) / 2);
        var messageY = boxY + Math.floor((boxH - 11) / 2);
        HaxrCorp4090FlipCTL.draw(canvas.ctx, messageText, messageX, messageY, '#000');
    };

    DeleteConfirmDialog.prototype.handleInput = function(action) {
        // Handled by app-defined buttons (esc and run)
        if (action === 'esc') {
            if (this.onCancel) this.onCancel();
        } else if (action === 'run') {
            if (this.onConfirm) this.onConfirm();
        }
    };

    // ─── Scrollbar ───────────────────────────────────────────────────────────────
    function Scrollbar(totalItems, visibleItems, currentIndex) {
        this.totalItems = totalItems || 0;
        this.visibleItems = visibleItems || 1;
        this.currentIndex = currentIndex || 0;
    }

    Scrollbar.prototype.shouldShow = function() {
        return this.totalItems > this.visibleItems;
    };

    Scrollbar.prototype.render = function(canvas, x, y, height, thumbPad) {
        if (!this.shouldShow()) return;

        thumbPad = thumbPad || 0;

        // Dotted base line fills the full (y, height) range.
        for (var i = 0; i < height; i += 2) {
            canvas.drawPixel(x, y + i, '#000');
        }

        // Thumb is inset from both ends of the dotted line by `thumbPad`
        // so it never touches the extremes — useful when the bar sits
        // close to another UI element (e.g. the status bar).
        var thumbRange = height - 2 * thumbPad;
        if (thumbRange < 5) thumbRange = 5;
        var thumbHeight = Math.max(5, Math.round(thumbRange * this.visibleItems / this.totalItems));
        var maxScroll = this.totalItems - this.visibleItems;
        var scrollRatio = maxScroll > 0 ? this.currentIndex / maxScroll : 0;
        var thumbY = y + thumbPad + Math.round((thumbRange - thumbHeight) * scrollRatio);

        // Draw thumb (3 pixels wide) centered on the dotted line.
        canvas.drawRect(x - 1, thumbY, 3, thumbHeight, '#000');
    };

    Scrollbar.prototype.update = function(totalItems, visibleItems, currentIndex) {
        this.totalItems = totalItems;
        this.visibleItems = visibleItems;
        this.currentIndex = currentIndex;
    };

    return {
        drawStatusBar:  drawStatusBar,
        drawBattery:    drawBattery,
        drawMenuList:   drawMenuList,
        visibleCount:   visibleCount,
        MiddleButton:   MiddleButton,
        MiddleIconButton: MiddleIconButton,
        MiddleToggleButton: MiddleToggleButton,
        MiddleIconToggleButton: MiddleIconToggleButton,
        LeftButton:     LeftButton,
        RightButton:    RightButton,
        RightButtonTopCut: RightButtonTopCut,
        NumericTabButton: NumericTabButton,
        IconTabButton:    IconTabButton,
        PopupMenuLeft:  PopupMenuLeft,
        Keyboard:       Keyboard,
        TabHeader:      TabHeader,
        TextInputBox:   TextInputBox,
        InputField:     InputField,
        DeleteConfirmDialog: DeleteConfirmDialog,
        Scrollbar:      Scrollbar,
        getWifiInfo:    getWifiInfo,
        getWifiEnabled: getWifiEnabled,
        setWifiEnabled: setWifiEnabled,
        getAirplaneMode: getAirplaneMode,
        setAirplaneMode: setAirplaneMode,
        STATUS_BAR_H:   STATUS_BAR_H,
        ITEM_H:         ITEM_H,
        PAD_LEFT:       PAD_LEFT
    };
})();
