#!/usr/bin/env node
'use strict';

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var util = require('util');
var execSync = require('child_process').execSync;
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var execAsync = util.promisify(exec);

// Async exec helper that swallows errors. Returns { stdout, stderr } on
// success, null on any failure (non-zero exit, timeout, missing binary).
// Endpoints aggregating several commands chain through this so a shell
// failure in one step doesn't fault the whole refresh, and — crucially —
// the Node loop never blocks on a subprocess: that's fatal for the
// touchpad SSE stream that lives in the same process.
function tryExec(cmd, opts) {
    return execAsync(cmd, opts || { encoding: 'utf8' }).then(
        function(r) { return r; },
        function()  { return null; }
    );
}

// Background refresher: invokes `fn` (returns Promise), waits for it to
// settle, sleeps `ms`, repeats. Errors are logged but never break the
// loop. Using setTimeout chains instead of setInterval guarantees no
// overlap when a refresh runs longer than its period.
function startRefreshLoop(name, fn, ms) {
    function tick() {
        Promise.resolve().then(fn).catch(function(e) {
            console.warn('[' + name + '] refresh error: ' + (e && e.message || e));
        }).then(function() {
            setTimeout(tick, ms);
        });
    }
    tick();
}

// ── Network LEDs ─────────────────────────────────────────────────
// "Network LEDs" — the four RGB LEDs along the top of the Flipper
// One that surface networking state: wifi, eth0, eth1, link.
// Backed by sysfs at /sys/class/leds/. Sysfs entries are
// root-owned so every write goes through
// `sudo sh -c 'echo X > /path'` — passwordless sudo is configured
// for the `user` account on these devices, so the shell call
// returns without prompting.
//
// Usage model:
//   • ledState['name'] holds the LAST-applied target so we only
//     rewrite when something actually changes (cuts unnecessary
//     sysfs writes during the 1 Hz tick).
//   • applyLedTarget(name, target) writes only the diff,
//     respecting the kernel's ordering rules (set trigger=none
//     before manual color/brightness, set color BEFORE trigger
//     when activating one).
//   • applyLedsFromState() runs every second + after every wifi
//     state change, mapping (wifiCache + ethernetCache + the
//     transient `ledWifiConnecting` flag) → LED states.
var ledState = {};
function _shellQuote(s) { return JSON.stringify(String(s)); }
function _writeLedFile(led, file, value) {
    var path = '/sys/class/leds/' + led + '/' + file;
    var inner = 'echo ' + value + ' > ' + path;
    var cmd = 'sudo sh -c ' + _shellQuote(inner);
    exec(cmd, { encoding: 'utf8', timeout: 2000 }, function() {});
}
// Apply a target {trigger, multi_intensity?, brightness?,
// delay_on?, delay_off?} to `led`. Diffs against the last
// applied target so untouched fields skip the write.
function applyLedTarget(led, target) {
    var prev = ledState[led] || {};
    var t    = target.trigger || 'none';
    if (t === 'none') {
        // Manual control — release any active trigger first so
        // subsequent multi_intensity / brightness writes stick.
        if (prev.trigger !== 'none') {
            _writeLedFile(led, 'trigger', 'none');
        }
        if (target.multi_intensity != null
            && target.multi_intensity !== prev.multi_intensity) {
            _writeLedFile(led, 'multi_intensity', target.multi_intensity);
        }
        if (target.brightness != null
            && target.brightness !== prev.brightness) {
            _writeLedFile(led, 'brightness', target.brightness);
        }
    } else {
        // Trigger-driven (e.g. timer for breathing). Set
        // multi_intensity FIRST so the trigger has a colour
        // when it activates, then switch trigger, then any
        // trigger-specific knobs.
        if (target.multi_intensity != null
            && target.multi_intensity !== prev.multi_intensity) {
            _writeLedFile(led, 'multi_intensity', target.multi_intensity);
        }
        if (t !== prev.trigger) {
            _writeLedFile(led, 'trigger', t);
        }
        if (target.delay_on != null
            && target.delay_on !== prev.delay_on) {
            _writeLedFile(led, 'delay_on', target.delay_on);
        }
        if (target.delay_off != null
            && target.delay_off !== prev.delay_off) {
            _writeLedFile(led, 'delay_off', target.delay_off);
        }
    }
    ledState[led] = target;
}
function ledOff(led) {
    applyLedTarget(led, { trigger: 'none', brightness: '0' });
}
// Transient flag — set true at the start of POST /api/wifi/connect,
// flipped back to false when the call resolves. Drives the wifi
// LED's "breathing blue" pattern via the timer trigger.
var ledWifiConnecting = false;
// Link LED state — driven entirely by POST /api/led/link from
// other applications. Kept here so applyLedsFromState() doesn't
// stomp it during periodic ticks.
var ledLinkOn = false;
// Manual override — when true, applyLedsFromState() bows out so
// the testing scene's direct /api/led/set writes stick. Toggled
// via /api/led/manual.
var ledManualMode = false;
function applyLedsFromState() {
    if (ledManualMode) return;
    // ── Wi-Fi ──
    // Status colour is full cyan (0,255,255) — picked in the
    // Network LEDs testing scene and confirmed against the
    // physical hardware.
    var wifiLed = 'flipper-one:rgb:wifi';
    if (ledWifiConnecting) {
        // Breathing cyan while a connect is in flight. Timer
        // trigger gives a slow blink (500/500); not a true
        // sine "breath" but cheap and recognisable.
        applyLedTarget(wifiLed, {
            trigger:         'timer',
            multi_intensity: '0 255 255',
            delay_on:        '500',
            delay_off:       '500'
        });
    } else if (wifiCache && wifiCache.connected) {
        applyLedTarget(wifiLed, {
            trigger:         'none',
            multi_intensity: '0 255 255',
            brightness:      '255'
        });
    } else {
        ledOff(wifiLed);
    }
    // ── Ethernet ── interface name → LED slot:
    //   end0 → flipper-one:rgb:eth0
    //   end1 → flipper-one:rgb:eth1
    var ethMap = { 'end0': 'flipper-one:rgb:eth0',
                   'end1': 'flipper-one:rgb:eth1' };
    for (var ei = 0; ei < (ethernetCache || []).length; ei++) {
        var iface = ethernetCache[ei];
        var led   = ethMap[iface.name];
        if (!led) continue;
        // "Connected" = state string contains the word
        // (matches both nmcli's cleaned output and our
        // ip-address fallback).
        var isUp = !!(iface.state
                      && iface.state.indexOf('connected') !== -1
                      && iface.state.indexOf('disconnected') === -1);
        if (isUp) {
            // Status colour for both ETH LEDs is a lime green
            // (120,255,0) — picked in the Network LEDs testing
            // scene against the physical hardware.
            applyLedTarget(led, {
                trigger:         'none',
                multi_intensity: '120 255 0',
                brightness:      '255'
            });
        } else {
            ledOff(led);
        }
    }
    // Always ensure unmapped eth slot is off (e.g. eth1 LED
    // when only end0 is wired).
    for (var k in ethMap) {
        var found = false;
        for (var ej = 0; ej < (ethernetCache || []).length; ej++) {
            if (ethernetCache[ej].name === k) { found = true; break; }
        }
        if (!found) ledOff(ethMap[k]);
    }
    // ── Link ──  Driven by /api/led/link; this branch just
    // re-asserts the flag every tick so nothing else can drift
    // it (e.g. the kernel default coming back after a reboot).
    var linkLed = 'flipper-one:rgb:link';
    if (ledLinkOn) {
        applyLedTarget(linkLed, {
            trigger:         'none',
            multi_intensity: '0 0 255',
            brightness:      '255'
        });
    } else {
        ledOff(linkLed);
    }
}

var PORT = 8899;
var BIND = '0.0.0.0';

// Regenerated on every process start. The browser polls /api/version
// and triggers location.reload() when this value changes, so the UI
// reloads itself after a variant switch without needing cog to restart.
var SERVER_ID = crypto.randomBytes(8).toString('hex');

// On Linux (Flipper), root is required for sysfs access
if (process.platform === 'linux' && process.getuid() !== 0) {
    console.error('Error: server must be run as root on Linux');
    process.exit(1);
}

var MIME = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
    '.wav':  'audio/wav'
};

var BASE = __dirname;

// Directory the "UI PNG viewer" Testing app browses.
var UI_PNG_DIR = '/media/ui_png';

// ── UI PNG viewer: MP4 → sprite-sheet frames ────────────────────
// WPE/GStreamer <video> cannot loop seamlessly on the device: the
// wrap is a seek + decoder restart that freezes the last frame for
// ~66 ms (measured; two-element ping-pong is worse at ~98 ms). So
// the viewer plays short clips from a pre-rendered sprite sheet:
// one PNG holding every frame in a cols×rows grid. The client blits
// frame rects from memory and the wrap becomes index arithmetic —
// zero seam. Sheets are built on first use with the on-device
// ffmpeg and cached in /tmp keyed by source mtime+size.
var FRAMES_DIR = '/tmp/ui-png-frames';
var FRAMES_MAX = 400;      // ≈16 s @ 25fps — sheets get huge past this;
                           // longer clips fall back to the <video> path
var framesInFlight = {};   // name → [cb, …] while ffprobe/ffmpeg run
try { fs.mkdirSync(FRAMES_DIR, { recursive: true }); } catch (e) {}

// spawn() + collected stdout; cb(stdout|null). Argument-array exec —
// the media names contain spaces/parens, no shell quoting involved.
function uiPngRunTool(cmd, args, timeoutMs, cb) {
    var out = '', done = false;
    var child;
    try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { cb(null); return; }
    var killer = setTimeout(function() {
        try { child.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);
    child.stdout.on('data', function(d) { out += d; });
    child.stderr.resume();   // drain so ffmpeg never blocks on a full pipe
    child.on('error', function() {
        if (done) return; done = true;
        clearTimeout(killer); cb(null);
    });
    child.on('close', function(code) {
        if (done) return; done = true;
        clearTimeout(killer); cb(code === 0 ? out : null);
    });
}

// Resolve (building if needed) the frame-sheet meta for one MP4.
// cb({ ok:true, frames, cols, rows, w, h, fps }) or { ok:false,
// error } — refusals are cached too so a too-long clip is probed
// only once per edit. Concurrent requests for the same name share
// one ffmpeg run via framesInFlight.
function uiPngFramesEnsure(name, cb) {
    var src = UI_PNG_DIR + '/' + name;
    fs.stat(src, function(errS, st) {
        if (errS || !st.isFile()) { cb({ ok: false, error: 'Not found' }); return; }
        var metaPath  = FRAMES_DIR + '/' + name + '.json';
        var sheetPath = FRAMES_DIR + '/' + name + '.sheet.png';
        var cached = null;
        try { cached = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
        if (cached && cached.srcMtimeMs === st.mtimeMs && cached.srcSize === st.size
                && (!cached.ok || fs.existsSync(sheetPath))) {
            cb(cached); return;
        }
        if (framesInFlight[name]) { framesInFlight[name].push(cb); return; }
        framesInFlight[name] = [cb];
        var settle = function(meta) {
            meta.srcMtimeMs = st.mtimeMs;
            meta.srcSize    = st.size;
            try { fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch (e) {}
            var cbs = framesInFlight[name] || [];
            delete framesInFlight[name];
            cbs.forEach(function(f) { try { f(meta); } catch (e) {} });
        };
        // -count_frames decodes the stream for an exact count — the
        // header's nb_frames can lie, and an off-by-one would leave a
        // black padding cell flashing at every wrap.
        uiPngRunTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
                '-count_frames', '-show_entries',
                'stream=nb_read_frames,avg_frame_rate,r_frame_rate,width,height',
                '-of', 'json', src], 30000, function(probeOut) {
            var frames = 0, fps = 0, w = 0, h = 0;
            try {
                var s = JSON.parse(probeOut).streams[0];
                frames = parseInt(s.nb_read_frames, 10) || 0;
                w = s.width | 0; h = s.height | 0;
                var fr = (s.avg_frame_rate && s.avg_frame_rate !== '0/0')
                       ? s.avg_frame_rate : s.r_frame_rate;
                var p = String(fr || '').split('/');
                fps = (parseFloat(p[0]) / (parseFloat(p[1]) || 1)) || 0;
            } catch (e) {}
            if (!frames || !w || !h || !fps) {
                settle({ ok: false, error: 'probe failed' }); return;
            }
            if (frames > FRAMES_MAX) {
                settle({ ok: false, error: 'too long (' + frames + ' frames)' });
                return;
            }
            var cols = Math.ceil(Math.sqrt(frames));
            var rows = Math.ceil(frames / cols);
            uiPngRunTool('ffmpeg', ['-v', 'error', '-y', '-i', src,
                    '-vf', 'tile=' + cols + 'x' + rows,
                    '-frames:v', '1', '-update', '1', sheetPath],
                    60000, function(ffOut) {
                if (ffOut === null || !fs.existsSync(sheetPath)) {
                    settle({ ok: false, error: 'ffmpeg failed' }); return;
                }
                settle({ ok: true, frames: frames, cols: cols, rows: rows,
                         w: w, h: h, fps: fps });
            });
        });
    });
}

// Drop a stale sheet (source renamed / deleted / overwritten).
function uiPngFramesEvict(name) {
    try { fs.unlinkSync(FRAMES_DIR + '/' + name + '.json'); } catch (e) {}
    try { fs.unlinkSync(FRAMES_DIR + '/' + name + '.sheet.png'); } catch (e) {}
}

// name= query param for the two frames endpoints; null when invalid.
function uiPngFramesName(url) {
    var name = null;
    (url.split('?')[1] || '').split('&').forEach(function(kv) {
        var i = kv.indexOf('=');
        if (i > 0 && kv.slice(0, i) === 'name') {
            try { name = decodeURIComponent(kv.slice(i + 1)); } catch (e) {}
        }
    });
    if (!name || !/^[^/]+\.mp4$/i.test(name) || name.indexOf('..') !== -1) return null;
    return name;
}

// Browser-mirror relay: the device (COG) posts its framebuffer here and
// PC viewers fetch it; PC viewers post button presses which the device
// drains and injects. In-memory, latest-frame-wins.
var mirrorFrame = null;    // latest device screen as a PNG Buffer
var mirrorViewerAt = 0;    // ms of the last viewer frame fetch (presence)
var MIRROR_VIEWER_TTL = 3000;  // a viewer is "watching" if seen within this
var mirrorSSE = [];        // device Server-Sent-Events connections
var mirrorWatching = false;  // server's current presence state
var mirrorCheck = null;      // presence-expiry timer (alive only while watched)

// Push an event to every connected device stream.
function mirrorBroadcast(evt, obj) {
    var payload = 'event: ' + evt + '\ndata: ' + JSON.stringify(obj) + '\n\n';
    for (var i = 0; i < mirrorSSE.length; i++) { try { mirrorSSE[i].write(payload); } catch (e) {} }
}
// Flip watch-state and tell the device. The only mirror timer runs here,
// and only while a viewer is present, to expire presence after the TTL.
function mirrorSetWatching(w) {
    if (w === mirrorWatching) return;
    mirrorWatching = w;
    mirrorBroadcast('watch', { watching: w });
    if (w && !mirrorCheck) {
        mirrorCheck = setInterval(function() {
            if (Date.now() - mirrorViewerAt >= MIRROR_VIEWER_TTL) {
                clearInterval(mirrorCheck); mirrorCheck = null;
                mirrorSetWatching(false);
            }
        }, 1000);
    }
}

var PSU = '/sys/class/power_supply/bq28z610-0';
var QMI_DEV = '/dev/cdc-wdm0';

// ── Touchpad ABS_X / ABS_Y SSE stream ──────────────────────────────────
//
// Resolve the Touchpad evdev node BY NAME at startup — event* numbers
// aren't stable: the Buttons and Touchpad share one i2c platform device
// and can enumerate in either order, so a hardcoded number can land on
// the Buttons node (no ABS_X/Y / BTN_TOUCH → the stream stays frozen at
// 0,0,0). The kernel emits 24-byte input_event structs (16-byte timeval
// + u16 type + u16 code + s32 value); on each EV_SYN/SYN_REPORT we flush
// the current "x,y,touching" triple to every SSE subscriber as one short
// line. With no subscribers we skip the write entirely, so idle cost is
// zero.
var TOUCHPAD_NAME     = 'Flipper One Touchpad';
var TOUCHPAD_FALLBACK = '/dev/input/event2';
var touchpadClients = new Set();
var tpX = 0, tpY = 0, tpTouching = false;

// /dev/input/eventN whose /sys/class/input/eventN/device/name is the
// Touchpad, or TOUCHPAD_FALLBACK when no match is found.
function resolveTouchpadDev() {
    try {
        var dir = '/sys/class/input';
        var entries = fs.readdirSync(dir);
        for (var i = 0; i < entries.length; i++) {
            if (!/^event\d+$/.test(entries[i])) continue;
            var nm;
            try { nm = fs.readFileSync(dir + '/' + entries[i] + '/device/name', 'utf8').trim(); }
            catch (e) { continue; }
            if (nm === TOUCHPAD_NAME) return '/dev/input/' + entries[i];
        }
    } catch (e) { /* /sys unavailable */ }
    return TOUCHPAD_FALLBACK;
}

function startTouchpadStream() {
    var dev = resolveTouchpadDev();
    var stream;
    try { stream = fs.createReadStream(dev); }
    catch (e) { console.warn('[touchpad] open failed: ' + e.message); return; }

    stream.on('data', function(chunk) {
        for (var off = 0; off + 24 <= chunk.length; off += 24) {
            var type = chunk.readUInt16LE(off + 16);
            var code = chunk.readUInt16LE(off + 18);
            var val  = chunk.readInt32LE (off + 20);
            if (type === 3) {                            // EV_ABS
                if      (code === 0) tpX = val;          // ABS_X
                else if (code === 1) tpY = val;          // ABS_Y
            } else if (type === 1 && code === 330) {     // EV_KEY / BTN_TOUCH
                tpTouching = (val === 1);
            } else if (type === 0 && code === 0 && touchpadClients.size) {
                // EV_SYN / SYN_REPORT — frame complete, push to subscribers.
                var line = 'data:' + tpX + ',' + tpY + ',' + (tpTouching ? 1 : 0) + '\n\n';
                touchpadClients.forEach(function(res) { res.write(line); });
            }
        }
    });
    stream.on('error', function(e) { console.warn('[touchpad] ' + e.message); });
    console.log('[touchpad] streaming ABS_X/ABS_Y from ' + dev);
}

// Bandwidth tracking: previous byte counters + timestamp
var bwPrev = { rx: 0, tx: 0, ts: 0, iface: null };

function readSysInt(p) {
    try { return parseInt(fs.readFileSync(p, 'utf8').trim(), 10); }
    catch (e) { return null; }
}

function getBandwidth(iface) {
    if (!iface) return { dlMbps: null, ulMbps: null };
    var rx = readSysInt('/sys/class/net/' + iface + '/statistics/rx_bytes');
    var tx = readSysInt('/sys/class/net/' + iface + '/statistics/tx_bytes');
    var now = Date.now();

    if (rx === null || tx === null) return { dlMbps: null, ulMbps: null };

    var result = { dlMbps: null, ulMbps: null };
    if (bwPrev.iface === iface && bwPrev.ts > 0) {
        var dtSec = (now - bwPrev.ts) / 1000;
        if (dtSec > 0.05) {
            result.dlMbps = +((rx - bwPrev.rx) * 8 / 1000000 / dtSec).toFixed(1);
            result.ulMbps = +((tx - bwPrev.tx) * 8 / 1000000 / dtSec).toFixed(1);
        }
    }
    bwPrev.rx = rx;
    bwPrev.tx = tx;
    bwPrev.ts = now;
    bwPrev.iface = iface;
    return result;
}

function deepGet(obj, keyPath) {
    var parts = keyPath.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return null;
        cur = cur[parts[i]];
    }
    return cur !== undefined && cur !== null ? cur : null;
}

function rxMatch(str, re) {
    var m = str.match(re);
    return m ? m[1] : null;
}

// Last-known modem snapshot. Refreshed asynchronously every second by
// refreshModem(); HTTP /api/modem returns this object directly without
// any shell-out, so modem info is never on the request path's hot loop.
var modemCache = { available: false };

async function refreshModem() {
    var result = { available: false };

    var mmRes = await tryExec('mmcli -m 0 -J 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
    if (!mmRes) { modemCache = result; return; }
    var mm;
    try { mm = JSON.parse(mmRes.stdout); }
    catch (e) { modemCache = result; return; }

    var modem = mm.modem || mm;
    result.available = true;

    result.model = deepGet(modem, 'generic.model') || deepGet(modem, 'hardware.model') || null;
    result.operator = deepGet(modem, '3gpp.operator-name') || null;
    result.operatorCode = deepGet(modem, '3gpp.operator-code') || null;
    result.state = deepGet(modem, 'generic.state') || null;

    var techs = deepGet(modem, 'generic.access-technologies') || [];
    if (typeof techs === 'string') techs = techs.split(',').map(function(s) { return s.trim(); });
    result.accessTech = techs;

    var sq = deepGet(modem, 'generic.signal-quality');
    if (sq && typeof sq === 'object') {
        result.signalQuality = parseInt(sq.value, 10) || null;
    } else if (sq) {
        result.signalQuality = parseInt(sq, 10) || null;
    } else {
        result.signalQuality = null;
    }

    result.ip4 = null;
    result.ip6 = null;
    result.iface = null;
    var bearers = deepGet(modem, 'generic.bearers') || [];
    if (bearers.length > 0) {
        var bPath = bearers[bearers.length - 1];
        var bNum = bPath.match(/(\d+)$/);
        if (bNum) {
            var bRes = await tryExec('mmcli -b ' + bNum[1] + ' -J 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
            if (bRes) {
                try {
                    var bearer = JSON.parse(bRes.stdout);
                    var b = bearer.bearer || bearer;
                    result.ip4 = deepGet(b, 'ipv4-config.address') || null;
                    result.ip6 = deepGet(b, 'ipv6-config.address') || null;
                    result.iface = deepGet(b, 'status.interface') || null;
                } catch (e) {}
            }
        }
    }

    var bw = getBandwidth(result.iface);
    result.dlMbps = bw.dlMbps;
    result.ulMbps = bw.ulMbps;

    var ssRes = await tryExec(
        'qmicli -d ' + QMI_DEV + ' --device-open-proxy --nas-get-serving-system 2>/dev/null',
        { encoding: 'utf8', timeout: 2000 });
    if (ssRes) {
        var ss = ssRes.stdout;
        result.cellId = rxMatch(ss, /3GPP cell ID:\s*'(\d+)'/);
        result.tac = rxMatch(ss, /LTE tracking area code:\s*'(\d+)'/);
        result.mcc = rxMatch(ss, /MCC:\s*'(\d+)'/);
        result.mnc = rxMatch(ss, /MNC:\s*'(\d+)'/);
    }

    var clRes = await tryExec(
        'qmicli -d ' + QMI_DEV + ' --device-open-proxy --nas-get-cell-location-info 2>/dev/null',
        { encoding: 'utf8', timeout: 2000 });
    if (clRes) {
        var cl = clRes.stdout;
        var earfcnMatch = cl.match(/EUTRA Absolute RF Channel Number:\s*'(\d+)'\s*\(([^)]+)\)/);
        if (earfcnMatch) {
            result.earfcn = earfcnMatch[1];
            result.band = earfcnMatch[2];
        }
        result.pci = rxMatch(cl, /Serving Cell ID:\s*'(\d+)'/);
    }

    var sigRes = await tryExec(
        'qmicli -d ' + QMI_DEV + ' --device-open-proxy --nas-get-signal-strength 2>/dev/null',
        { encoding: 'utf8', timeout: 2000 });
    if (sigRes) {
        var sig = sigRes.stdout;
        result.rsrp = rxMatch(sig, /RSRP:[\s\S]*?Network '[^']*':\s*'([^']+)'/);
        result.rsrq = rxMatch(sig, /RSRQ:[\s\S]*?Network '[^']*':\s*'([^']+)'/);
        result.sinr = rxMatch(sig, /SINR[^:]*:\s*'([^']+)'/);
    }

    modemCache = result;
}

function readInt(filePath) {
    try {
        return parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    } catch (e) {
        return null;
    }
}

function readStr(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (e) {
        return null;
    }
}

// Find the thermal zone registered by the battery fuel-gauge driver
// (bq28z610-0 on FlipperOne). We scan every /sys/class/thermal/thermal_zoneN
// and match the `type` file against the PSU driver name — zone indices can
// vary between kernels, so matching by type is more robust than hard-coding
// a zone number. Returns { zone, type, tempC } or null.
function getBatteryTemp() {
    var base = '/sys/class/thermal';
    var entries;
    try { entries = fs.readdirSync(base); }
    catch (e) { return null; }

    // The PSU path ends with the driver instance (e.g. "bq28z610-0") and
    // that's exactly the string exposed in thermal_zone*/type.
    var psuName = PSU.split('/').pop();

    for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        if (name.indexOf('thermal_zone') !== 0) continue;
        var type = readStr(base + '/' + name + '/type');
        if (!type) continue;
        // Prefer exact match on the PSU driver name; fall back to any
        // zone whose type starts with "bq" (battery gauge) if the rename
        // changes between board revisions.
        var isBattery = (type === psuName) || /^bq\d/i.test(type);
        if (!isBattery) continue;
        var milliC = readInt(base + '/' + name + '/temp');
        if (milliC === null) continue;
        return { zone: name, type: type, tempC: +(milliC / 1000).toFixed(1) };
    }
    return null;
}

// SoC package temperature. Scans /sys/class/thermal for the zone whose
// `type` is `package-thermal` (the Rockchip SoC package sensor on FlipperOne);
// falls back to any zone whose type contains "package". Zone indices can
// vary between kernels, so matching by type is the robust approach.
// Returns { zone, type, tempC } or null.
function getCpuTemp() {
    var base = '/sys/class/thermal';
    var entries;
    try { entries = fs.readdirSync(base); }
    catch (e) { return null; }

    var fallback = null;
    for (var i = 0; i < entries.length; i++) {
        var name = entries[i];
        if (name.indexOf('thermal_zone') !== 0) continue;
        var type = readStr(base + '/' + name + '/type');
        if (!type) continue;
        var exact = (type === 'package-thermal');
        var fuzzy = /package/i.test(type);
        if (!exact && !fuzzy) continue;
        var milliC = readInt(base + '/' + name + '/temp');
        if (milliC === null) continue;
        var entry = { zone: name, type: type, tempC: +(milliC / 1000).toFixed(1) };
        if (exact) return entry;
        if (!fallback) fallback = entry;
    }
    return fallback;
}

// Battery power flow in watts. The bq28z610 gauge writes a smoothed
// average to `power_avg` in microwatts. Sign convention: negative values
// mean the pack is discharging (load draws from battery), positive means
// charging.
function getPowerUsage() {
    var uW = readInt(PSU + '/power_avg');
    if (uW === null) return null;
    return { watts: +(uW / 1000000).toFixed(2) };
}

function getPowerInfo() {
    var result = { available: false };
    if (!fs.existsSync(PSU)) return result;

    result.available = true;
    result.status = readStr(PSU + '/status');
    result.capacity = readInt(PSU + '/capacity');

    var v_uV = readInt(PSU + '/voltage_now');
    var i_uA = readInt(PSU + '/current_now');
    var p_uW = readInt(PSU + '/power_now');

    result.voltage = v_uV !== null ? +(v_uV / 1000000).toFixed(3) : null;
    result.current = i_uA !== null ? +(i_uA / 1000000).toFixed(3) : null;

    // Power: prefer power_now, fallback to V*I
    if (p_uW !== null) {
        result.power = +(p_uW / 1000000).toFixed(3);
    } else if (v_uV !== null && i_uA !== null) {
        result.power = +((v_uV * i_uA) / 1000000000000).toFixed(3);
    } else {
        result.power = null;
    }

    var chNow = readInt(PSU + '/charge_now');
    var chFull = readInt(PSU + '/charge_full');
    result.chargeNow = chNow !== null ? +(chNow / 1000000).toFixed(3) : null;
    result.chargeFull = chFull !== null ? +(chFull / 1000000).toFixed(3) : null;

    result.timeToEmpty = readInt(PSU + '/time_to_empty_now');
    result.timeToFull = readInt(PSU + '/time_to_full_now');
    result.temp = readInt(PSU + '/temp');

    return result;
}

var UPDATE_REPO = '/flipperone-testing';
var UPDATE_BRANCH = 'meshcore_demo';

function getUpdateStatus() {
    var result = { available: false, currentCommit: null, commits: [], error: null };
    try {
        result.currentCommit = execSync('git -C ' + UPDATE_REPO + ' log --oneline -1', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch (e) {
        result.error = 'Cannot read local repo';
        return result;
    }
    try {
        execSync('git -C ' + UPDATE_REPO + ' fetch origin ' + UPDATE_BRANCH + ' 2>&1', { encoding: 'utf8', timeout: 15000 });
    } catch (e) {
        result.error = 'No internet';
        return result;
    }
    try {
        var log = execSync('git -C ' + UPDATE_REPO + ' log --oneline HEAD..origin/' + UPDATE_BRANCH, { encoding: 'utf8', timeout: 5000 }).trim();
        if (log) {
            result.available = true;
            result.commits = log.split('\n');
        }
    } catch (e) {
        result.error = 'Cannot compare branches';
    }
    return result;
}

function logUpdate(msg) {
    var ts = new Date().toISOString();
    try { fs.appendFileSync('/tmp/fake-flipctl-update.log', ts + ' ' + msg + '\n'); } catch (e) {}
    console.log('[update] ' + msg);
}

function doUpdate() {
    var result = { success: false, error: null };
    logUpdate('Starting update');
    try {
        logUpdate('git reset --hard HEAD');
        var r1 = execSync('git -C ' + UPDATE_REPO + ' reset --hard HEAD 2>&1', { encoding: 'utf8', timeout: 5000 });
        logUpdate('reset: ' + r1.trim());
    } catch (e) {
        logUpdate('reset failed: ' + e.message);
        result.error = 'reset failed';
        return result;
    }
    try {
        logUpdate('git clean -fd');
        var r2 = execSync('git -C ' + UPDATE_REPO + ' clean -fd 2>&1', { encoding: 'utf8', timeout: 5000 });
        logUpdate('clean: ' + r2.trim());
    } catch (e) {
        logUpdate('clean failed: ' + e.message);
    }
    try {
        logUpdate('git pull origin ' + UPDATE_BRANCH);
        var r3 = execSync('git -C ' + UPDATE_REPO + ' pull origin ' + UPDATE_BRANCH + ' 2>&1', { encoding: 'utf8', timeout: 30000 });
        logUpdate('pull: ' + r3.trim());
        result.success = true;
    } catch (e) {
        var msg = (e.stderr || e.stdout || e.message || 'Unknown error').toString();
        var lines = msg.split('\n').filter(function(l) { return l.trim(); });
        result.error = (lines[0] || 'Unknown error').substring(0, 120);
        logUpdate('pull failed: ' + msg);
    }
    logUpdate('Done, success=' + result.success);
    return result;
}

var routingCache = [];

async function refreshRouting() {
    var routes = [];
    var r4 = await tryExec('ip -4 route show default 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    if (r4) {
        var lines4 = r4.stdout.trim().split('\n');
        for (var i = 0; i < lines4.length; i++) {
            if (!lines4[i]) continue;
            var m4 = lines4[i].match(/default via (\S+) dev (\S+).*?metric (\d+)/);
            if (m4) routes.push({ family: 'IPv4', gateway: m4[1], dev: m4[2], metric: parseInt(m4[3], 10) });
            else {
                var m4b = lines4[i].match(/default via (\S+) dev (\S+)/);
                if (m4b) routes.push({ family: 'IPv4', gateway: m4b[1], dev: m4b[2], metric: null });
            }
        }
    }
    var r6 = await tryExec('ip -6 route show default 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    if (r6) {
        var lines6 = r6.stdout.trim().split('\n');
        for (var j = 0; j < lines6.length; j++) {
            if (!lines6[j]) continue;
            var m6 = lines6[j].match(/default via (\S+) dev (\S+).*?metric (\d+)/);
            if (m6) routes.push({ family: 'IPv6', gateway: m6[1], dev: m6[2], metric: parseInt(m6[3], 10) });
            else {
                var m6b = lines6[j].match(/default via (\S+) dev (\S+)/);
                if (m6b) routes.push({ family: 'IPv6', gateway: m6b[1], dev: m6b[2], metric: null });
            }
        }
    }
    routingCache = routes;
}

// `flipusb0` is the USB-gadget Ethernet device created on builds
// that ship the cdc_ether/g_ether kernel module. NetworkManager
// usually treats it as `unmanaged`, so its IPs (typically a
// link-local 169.254.x.x set by a startup script) won't appear
// via `nmcli device show` — the fallback `ip -j addr show <iface>`
// pass below picks them up.
var ETH_IFACES = ['end0', 'end1', 'flipusb0'];

var ethernetCache = [];

async function refreshEthernet() {
    var ifaces = [];
    for (var i = 0; i < ETH_IFACES.length; i++) {
        var name = ETH_IFACES[i];
        if (!fs.existsSync('/sys/class/net/' + name)) continue;

        var info = { name: name, state: null, ip4: [], ip6: [], gateway4: null, gateway6: null, dns: [] };
        var nmRes = await tryExec('nmcli -t device show ' + name + ' 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        if (nmRes) {
            var lines = nmRes.stdout.split('\n');
            for (var j = 0; j < lines.length; j++) {
                var parts = lines[j].split(':');
                var key = parts[0];
                var val = parts.slice(1).join(':');
                if (key === 'GENERAL.STATE') info.state = val;
                else if (key.match(/^IP4\.ADDRESS/)) info.ip4.push(val);
                else if (key.match(/^IP6\.ADDRESS/)) info.ip6.push(val);
                else if (key === 'IP4.GATEWAY') info.gateway4 = val || null;
                else if (key === 'IP6.GATEWAY') info.gateway6 = val || null;
                else if (key.match(/^IP4\.DNS/)) info.dns.push(val);
            }
        } else {
            info.state = 'unavailable';
        }
        var carrier = readSysInt('/sys/class/net/' + name + '/carrier');
        if (carrier === 0) info.state = 'disconnected (no carrier)';

        info.speed = null;
        if (carrier !== 0) {
            var ethRes = await tryExec('ethtool ' + name + ' 2>/dev/null', { encoding: 'utf8', timeout: 1500 });
            if (ethRes) {
                var speedMatch = ethRes.stdout.match(/^\s*Speed:\s*([^\s]+)/m);
                if (speedMatch && speedMatch[1] !== 'Unknown!' && speedMatch[1] !== 'Unknown') {
                    info.speed = speedMatch[1];
                }
            }
        }
        info.rxBytes = readSysInt('/sys/class/net/' + name + '/statistics/rx_bytes');
        info.txBytes = readSysInt('/sys/class/net/' + name + '/statistics/tx_bytes');

        if (info.ip4.length === 0 && carrier !== 0) {
            var ipRes = await tryExec('ip -j addr show ' + name + ' 2>/dev/null',
                { encoding: 'utf8', timeout: 1500 });
            if (ipRes) {
                try {
                    var ipdata = JSON.parse(ipRes.stdout);
                    if (Array.isArray(ipdata) && ipdata[0]
                            && Array.isArray(ipdata[0].addr_info)) {
                        var addrs = ipdata[0].addr_info;
                        for (var ki = 0; ki < addrs.length; ki++) {
                            var a = addrs[ki];
                            if (!a || !a.local) continue;
                            var cidr = a.local + '/' + a.prefixlen;
                            if (a.family === 'inet')       info.ip4.push(cidr);
                            else if (a.family === 'inet6') info.ip6.push(cidr);
                        }
                        if (info.ip4.length > 0
                            && (!info.state || info.state.indexOf('connected') === -1)) {
                            info.state = 'connected';
                        }
                    }
                } catch (e) {}
            }
        }

        info.ipv4Method = null;
        if (carrier !== 0) {
            var actRes = await tryExec('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null',
                { encoding: 'utf8', timeout: 1500 });
            if (actRes) {
                var actLines = actRes.stdout.split('\n');
                var connName = null;
                for (var ai = 0; ai < actLines.length; ai++) {
                    var ln = actLines[ai];
                    if (!ln) continue;
                    var idx = -1;
                    for (var p = ln.length - 1; p >= 0; p--) {
                        if (ln.charAt(p) === ':' && (p === 0 || ln.charAt(p - 1) !== '\\')) { idx = p; break; }
                    }
                    if (idx === -1) continue;
                    var dev = ln.substring(idx + 1);
                    if (dev === name) {
                        connName = ln.substring(0, idx).replace(/\\:/g, ':');
                        break;
                    }
                }
                if (connName) {
                    var methodRes = await tryExec(
                        'nmcli -t -f ipv4.method connection show "' + connName.replace(/"/g, '\\"') + '" 2>/dev/null',
                        { encoding: 'utf8', timeout: 1500 });
                    if (methodRes) {
                        var mm = methodRes.stdout.match(/ipv4\.method:(.+)/);
                        if (mm) info.ipv4Method = mm[1].trim();
                    }
                }
            }
        }
        ifaces.push(info);
    }
    ethernetCache = ifaces;
}

var diskCache = { device: '/dev/mmcblk0p2', mounted: false };

async function refreshDisk() {
    var result = { device: '/dev/mmcblk0p2', mounted: false };
    var r = await tryExec('df -k /dev/mmcblk0p2 2>/dev/null', { encoding: 'utf8' });
    if (r) {
        var lines = r.stdout.trim().split('\n');
        if (lines.length >= 2) {
            var parts = lines[1].trim().split(/\s+/);
            var totalKB = parseInt(parts[1], 10);
            var usedKB = parseInt(parts[2], 10);
            result.mounted = true;
            result.totalGB = +(totalKB / 1048576).toFixed(1);
            result.usedGB = +(usedKB / 1048576).toFixed(1);
        }
    }
    diskCache = result;
}

var SOUND_DIR = '/flipperone-testing/sound/audio_files';
var DRIVER_SCRIPT = '/flipperone-testing/sound/audio-driver-restart.sh';
var audioChild = null;
// True only while a radio stream's mpg123 child is alive. Set
// when playRadioStream starts, cleared when that child exits (a
// dead URL makes mpg123 quit within a second or two) or when any
// stopSound() runs. /api/radio/status reports it so the UI shows
// "Playing" only for an actually-live stream.
var radioPlaying = false;

// Extra sound entries that live outside SOUND_DIR — the device
// has its stock list under /flipperone-testing/sound/audio_files
// but we also want to expose project-bundled assets (e.g. the
// Walkie Talkie loop) in the same Play sound picker. Keys are the
// display filenames the picker shows; values are entry objects
// with `path` (absolute path on disk) and optional `effects`
// (sox effect string appended to the play command — used here to
// reverse the on-disk reversed file so the picker plays it
// forwards while leaving the asset itself reversed for whatever
// else consumes it). Entries whose path doesn't resolve at read
// time are silently skipped so nothing breaks if the asset is
// missing.
var EXTRA_SOUND_FILES = {
    // Do not modify the on-disk file — playback applies the sox
    // `reverse` effect to flip the stream at play time, leaving
    // the bytes untouched. Format matches spk_mono.wav (PCM
    // s16le, 48000 Hz, mono).
    '415_audio.wav': {
        path:    path.join(BASE, 'assets/apps/walkie_talkie/415_audio.wav'),
        effects: 'reverse'
    }
};

function getSoundFiles() {
    var files = [];
    try {
        var entries = fs.readdirSync(SOUND_DIR);
        for (var i = 0; i < entries.length; i++) {
            if (/\.(wav|flac|ogg|aiff?|mp3|au|snd|caf|w64|wv|amr|voc|sph|xi)$/i.test(entries[i])) files.push(entries[i]);
        }
    } catch (e) {}
    // Append project-bundled extras when their backing file
    // actually exists. Skip names that already appeared in the
    // device listing so we don't end up with duplicates.
    Object.keys(EXTRA_SOUND_FILES).forEach(function(name) {
        if (files.indexOf(name) !== -1) return;
        try {
            if (fs.existsSync(EXTRA_SOUND_FILES[name].path)) files.push(name);
        } catch (e) {}
    });
    files.sort();
    return files;
}

// Resolve a connector's preferred mode as "WxH NNHz". Resolution comes
// from sysfs `modes` (first line = preferred); the refresh rate is
// parsed from the EDID's preferred timing via edid-decode. Cached per
// connector so edid-decode only runs when the resolution changes, not
// on every status poll. Falls back to resolution-only if edid-decode
// is unavailable.
var hdmiModeCache = {};   // connName -> { res, mode }
function getHdmiMode(connName, res) {
    if (!res) return null;
    var c = hdmiModeCache[connName];
    if (c && c.res === res) return c.mode;
    var mode = res;
    try {
        var out = execSync('edid-decode /sys/class/drm/' + connName + '/edid 2>/dev/null',
            { encoding: 'utf8', timeout: 4000 });
        var m = out.match(new RegExp(res + '\\s+([\\d.]+)\\s*Hz'));
        if (m) mode = res + ' ' + Math.round(parseFloat(m[1])) + 'Hz';
    } catch (e) {}
    hdmiModeCache[connName] = { res: res, mode: mode };
    return mode;
}

// DRM HDMI connector status from sysfs. Usually a single
// card2-HDMI-A-1, but we scan every HDMI-A-N so a multi-output board
// still reports correctly. `connected` is true if any HDMI connector
// reads "connected". Note: a TV in standby may keep HPD asserted
// (stays "connected") or drop it (flips to "disconnected") — this
// reflects HPD only, not the TV's actual power state.
function getHdmiStatus() {
    var DRM_DIR = '/sys/class/drm';
    var connectors = [];
    var connected = false;
    var resolution = null;
    try {
        var entries = fs.readdirSync(DRM_DIR);
        for (var i = 0; i < entries.length; i++) {
            if (!/-HDMI-A-\d+$/.test(entries[i])) continue;
            var base = DRM_DIR + '/' + entries[i];
            var status = 'unknown';
            try { status = fs.readFileSync(base + '/status', 'utf8').trim(); } catch (e) {}
            // This connector's `status` can stick at "unknown" after a
            // hot-plug — it isn't the active display, so the kernel
            // doesn't poll it. EDID presence is the reliable attach
            // signal (it clears to 0 bytes on unplug), so treat
            // EDID-present (and not explicitly "disconnected") as connected.
            var edidBytes = 0;
            try { edidBytes = fs.readFileSync(base + '/edid').length; } catch (e) {}
            var isConn = (status === 'connected') || (status !== 'disconnected' && edidBytes > 0);
            var res = null;
            if (isConn) {
                connected = true;
                var res0 = null;
                try {
                    // First line of `modes` is the preferred/native mode.
                    var modes = fs.readFileSync(base + '/modes', 'utf8').trim();
                    if (modes) res0 = modes.split('\n')[0].trim() || null;
                } catch (e) {}
                res = getHdmiMode(entries[i], res0);   // adds " NNHz" when available
                if (!resolution && res) resolution = res;
            }
            connectors.push({ name: entries[i], status: status, connected: isConn, resolution: res });
        }
    } catch (e) {}
    return { connected: connected, resolution: resolution, connectors: connectors };
}

// TV Media Box runtime dependencies → the package that provides each.
// cec-ctl: CEC control (v4l-utils); edid-decode: refresh-rate parsing.
var TVMB_DEPS = [
    { bin: 'cec-ctl',     pkg: 'v4l-utils' },
    { bin: 'edid-decode', pkg: 'edid-decode' }
];
function missingDeps() {
    var missing = [];
    TVMB_DEPS.forEach(function(d) {
        try { execSync('which ' + d.bin, { timeout: 2000 }); }
        catch (e) { if (missing.indexOf(d.pkg) === -1) missing.push(d.pkg); }
    });
    return missing;
}

// Preset launcher — child process currently rendering to HDMI
// (kodi-standalone, weston, etc.). Single slot: launching a new
// preset SIGTERMs the old one first. We spawn under `su - user`
// because Kodi refuses to run as root, and weston is happier as
// a non-root user too.
var tvmbPresetChild = null;
var tvmbPresetName  = null;   // 'Kodi TV' | 'Linux Desktop' | null
// Preset name → shell command. Each command is invoked via
// `sh -c` so we can pipe through `su` and pick up the user's
// XDG/runtime dirs.
var TVMB_PRESET_CMD = {
    // Kodi as a Wayland client inside the running KDE session. The
    // `su - login` does NOT inherit XDG_RUNTIME_DIR here, so we set it
    // explicitly — without it libwayland can't find the socket and
    // Kodi falls back to GBM, which collides with KWin on the HDMI
    // and renders nothing. WAYLAND_DISPLAY picks the session's socket.
    'Kodi TV':       "su - user -c 'XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 kodi'",
    'Linux Desktop': "su - user -c 'weston'"
    // 'AirPlay' deferred — needs a video-capable RPiPlay/uxplay
    // build and TBD audio routing.
};
function stopPreset() {
    if (tvmbPresetChild) {
        try { tvmbPresetChild.kill('SIGTERM'); } catch (e) {}
        tvmbPresetChild = null;
        tvmbPresetName  = null;
    }
    // The tracked handle can't reach Kodi once `su - login` detaches it
    // into its own session, so reap by process NAME with killall. The
    // names match comm exactly — `kodi` (the launcher) and `kodi.bin`
    // (the binary) — never a bystander that merely mentions "kodi" in
    // its arguments (an editor, a `grep kodi`). SIGTERM (killall's
    // default) lets Kodi shut down cleanly and leaves no core dump, so
    // /usr/bin/kodi's crash-restart loop won't respawn it.
    try { execSync('killall kodi.bin kodi', { timeout: 2000 }); } catch (e) {}
}
function startPreset(presetName) {
    var cmd = TVMB_PRESET_CMD[presetName];
    if (!cmd) return { success: false, error: 'Unknown / unsupported preset: ' + presetName };
    stopPreset();
    try {
        var child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
        child.unref();
        // If the child dies on its own (crash, missing binary,
        // user-side weston exits), clear our slot so a subsequent
        // Start request spawns fresh instead of being a silent no-op.
        child.on('exit', function() {
            if (tvmbPresetChild === child) {
                tvmbPresetChild = null;
                tvmbPresetName  = null;
            }
        });
        tvmbPresetChild = child;
        tvmbPresetName  = presetName;
        return { success: true, preset: presetName };
    } catch (e) {
        return { success: false, error: (e.message || String(e)) };
    }
}

// Current HDMI-CEC adapter state, parsed from `cec-ctl`'s settings
// dump. `installed`/`cecDevice` gate the dependency modal; `enabled`
// is true once the adapter has claimed a CEC logical address (i.e.
// it's configured as a playback device and live on the bus — which
// also requires HDMI to be connected). All probes are best-effort.
function getCecState() {
    var state = { installed: false, cecDevice: false, enabled: false, physicalAddress: null, missing: [], depsOk: false };
    state.missing = missingDeps();
    state.depsOk  = state.missing.length === 0;
    try { execSync('which cec-ctl', { timeout: 2000 }); state.installed = true; } catch (e) {}
    try { state.cecDevice = fs.existsSync('/dev/cec0'); } catch (e) {}
    if (state.installed && state.cecDevice) {
        try {
            var out = execSync('cec-ctl -d /dev/cec0', { encoding: 'utf8', timeout: 3000 });
            var mask = out.match(/Logical Address Mask\s*:\s*(0x[0-9a-fA-F]+)/);
            if (mask && parseInt(mask[1], 16) !== 0) state.enabled = true;
            var pa = out.match(/Physical Address\s*:\s*([0-9a-fA-F.]+)/);
            if (pa) state.physicalAddress = pa[1];
        } catch (e) {}
    }
    return state;
}

// Query the TV's CEC power state (TV = logical address 0). Returns
// 'on' | 'standby' | 'to-on' | 'to-standby', or null when the TV
// doesn't reply (off / no CEC / not enabled).
function getTvPower() {
    try {
        var out = execSync('cec-ctl -d /dev/cec0 --to 0 --give-device-power-status 2>&1',
            { encoding: 'utf8', timeout: 4000 });
        var m = out.match(/pwr-state:\s*([a-z-]+)/i);
        if (m) return m[1];
    } catch (e) {}
    return null;
}

// "Is the TV on the CEC bus" probe. Reuses getTvPower's
// give-device-power-status query — only a real CEC device writes
// "pwr-state: …" to stdout, so a non-null return is a reliable
// "TV is on the bus" signal. PC monitors / non-CEC screens
// produce no such field.
function isTvPresent() {
    return getTvPower() !== null;
}

// Ask the CEC bus which device is currently the active source —
// the one whose HDMI input the TV is actually displaying. Returns
// the physical address ('1.0.0.0', '2.0.0.0', …) the active source
// broadcasts back. null if the TV doesn't reply (e.g. it's on its
// own tuner / smart-TV apps, or we already ARE the active source
// and no other device claims it).
function getActiveSource() {
    try {
        var out = execSync('cec-ctl -d /dev/cec0 --request-active-source 2>&1',
            { encoding: 'utf8', timeout: 3000 });
        var m = out.match(/phys-addr:\s*([0-9a-fA-F.]+)/);
        if (m) return m[1];
    } catch (e) {}
    return null;
}

function playSoundFile(filename) {
    // Sanitize: only allow filenames, no path separators
    if (/[\/\\]/.test(filename)) return { success: false, error: 'Invalid filename' };
    // Extras take precedence — if the picked name is in our
    // override map, point sox at the bundled asset instead of
    // SOUND_DIR. Falls through to the device path otherwise.
    var extra    = EXTRA_SOUND_FILES[filename];
    var filePath = (extra && fs.existsSync(extra.path))
        ? extra.path
        : path.join(SOUND_DIR, filename);
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };

    // Kill any currently playing audio
    stopSound();

    // `channels 2` forces a stereo output stream. The NAU8822's
    // SAI is wired stereo at the I2S level — opening hw:N,0 in
    // mono mode drains samples ~4× too fast (chipmunk pitch and
    // tempo). Asking sox to up-mix to two channels keeps the
    // codec in its native frame format; a no-op on already-stereo
    // input.
    var cmd = 'play ' + JSON.stringify(filePath) + ' channels 2';
    // Append per-entry sox effects (e.g. `reverse`) after the
    // baseline `channels 2` so they apply to the resampled stream.
    if (extra && extra.effects) {
        cmd += ' ' + extra.effects;
    }
    if (selectedAlsaDevice) {
        cmd = 'AUDIODEV=' + selectedAlsaDevice + ' ' + cmd;
    }

    audioChild = exec(cmd, { timeout: 30000 }, function(err) {
        audioChild = null;
    });

    return { success: true, file: filename };
}

// Promise that resolves when the last-killed `audioChild` has
// actually exited (and therefore released its ALSA handle).
// `playRecording` waits on this before spawning a new sox so
// the new process doesn't race the old one for the codec and
// die with EBUSY. Resolves immediately when nothing was killed.
var _audioChildExit = Promise.resolve();

// Build a promise that resolves once `child` has emitted `exit`
// or `error`. Includes a 500-ms safety-net timeout in case
// neither event fires (shouldn't happen, but the consequence
// of waiting forever is a hung playback).
function _trackChildExit(child) {
    return new Promise(function(resolve) {
        var done = false;
        function finish() { if (done) return; done = true; resolve(); }
        child.once('exit',  finish);
        child.once('error', finish);
        setTimeout(finish, 500);
    });
}

// Kill the current audioChild (if any) and update `_audioChildExit`
// so the next spawn knows when it's safe to claim the codec.
// If there's no audioChild, leave `_audioChildExit` alone — a
// previous caller (pausePlayback) may have set it to a real
// exit promise that the next playRecording still needs to wait
// on. Resetting to Promise.resolve() here would let the next
// spawn race the dying child.
function _killAudioChild() {
    if (!audioChild) return;
    var oldChild = audioChild;
    audioChild = null;
    _audioChildExit = _trackChildExit(oldChild);
    // SIGKILL, not SIGTERM — graceful shutdown lets sox flush
    // ALSA for tens of ms, during which the next spawn races
    // and hits "Device or resource busy". SIGKILL has the
    // kernel reap the process; ALSA's release happens
    // synchronously inside the kernel's cleanup, so the
    // `exit`-event resolve is a true "codec is free" signal.
    try { oldChild.kill('SIGKILL'); } catch (e) { /* already dead */ }
}

function stopSound() {
    // Break the walkie-talkie respawn loop, if one is running.
    walkieActive = false;
    radioPlaying = false;
    _killAudioChild();
    // Clear the recorder's playback state too — /api/sound/stop
    // is the canonical "stop everything" call, so the player
    // overlay's status should reflect a fully-stopped state on
    // its next poll.
    if (typeof audioPlay !== 'undefined') {
        audioPlay = null;
    }
}

// ── Walkie Talkie audio loop ─────────────────────────────────────
// The Walkie Talkie scene wants 415_audio.wav playing on repeat
// for as long as the user is in the app. Playback applies the
// sox `reverse` effect — same trick the Sound > Play sound
// picker uses for the same file.
//
// Loops by respawning sox each time the previous child exits,
// guarded by `walkieActive` so an external stop (e.g. user picks
// another file in Play sound, or the scene's exit hook fires)
// breaks the cycle. Shares the global `audioChild` slot so the
// existing one-thing-at-a-time invariant the rest of the audio
// stack relies on still holds.
var walkieActive      = false;
var WALKIE_AUDIO_PATH = path.join(BASE, 'assets/apps/walkie_talkie/415_audio.wav');

function spawnWalkieOnce() {
    if (!walkieActive) return;
    if (!fs.existsSync(WALKIE_AUDIO_PATH)) {
        walkieActive = false;
        return;
    }
    // spawn (not exec) so SIGKILL hits sox directly instead of
    // the wrapping shell — with exec, killing the shell leaves
    // sox orphaned and it plays its 17.9 s iteration through to
    // completion before the loop actually goes silent. spawn
    // also makes the argv unambiguous (no shell-quoting).
    var spawn = require('child_process').spawn;
    var args  = [WALKIE_AUDIO_PATH, 'channels', '2', 'reverse'];
    var envCopy = Object.assign({}, process.env);
    if (selectedAlsaDevice) envCopy.AUDIODEV = selectedAlsaDevice;
    var child = spawn('play', args, { env: envCopy, stdio: 'ignore' });
    function onLeave() {
        // Identity-guard: only null the global if we're still the
        // tracked child. Avoids stomping on a successor that some
        // other producer (Play sound, radio) installed in the
        // meantime.
        if (audioChild === child) audioChild = null;
        if (walkieActive) {
            // Brief gap so ALSA can release the device before the
            // next sox attempts to open it — without this, the
            // next spawn frequently hits "Device or resource busy"
            // and exits immediately, which would make the loop
            // race itself into a tight respawn storm.
            setTimeout(spawnWalkieOnce, 80);
        }
    }
    child.on('exit',  onLeave);
    child.on('error', onLeave);
    audioChild = child;
}

function startWalkieLoop() {
    if (walkieActive) return { success: true, already: true };
    if (!fs.existsSync(WALKIE_AUDIO_PATH)) {
        return { success: false, error: 'Walkie audio not found' };
    }
    // Free the codec first — any other producer (Play sound, a
    // radio stream) yields immediately. `stopSound()` flips
    // walkieActive off, so we re-arm it AFTER.
    stopSound();
    walkieActive = true;
    spawnWalkieOnce();
    return { success: true };
}

function stopWalkieLoop() {
    if (!walkieActive) return { success: true, already: true };
    // stopSound() resets walkieActive to false and kills the
    // current child; the exit handler then sees walkieActive
    // false and skips the respawn.
    stopSound();
    return { success: true };
}

// ── Microphone level monitor ─────────────────────────────────────
// Spawns arecord against hw:1,0 in S16_LE stereo 48 kHz, reads the
// raw PCM stream off stdout, and tracks the peak amplitude per
// channel as integer percentages 0..100. Clients poll
// /api/mic/level for the latest values to drive on-screen meters.
//
// arecord writes ~192 KB/s; we only ever inspect the chunks that
// arrive (no accumulation), so memory and CPU stay bounded. A
// trailing odd byte at the end of a chunk is dropped — the next
// chunk's leading byte will pair up naturally.
var micChild         = null;
var micLeft          = 0;
var micRight         = 0;
// SSE subscribers receiving live level pushes. Populated by the
// /api/mic/level/stream handler; emptied as connections close.
// `_lastNotifyAt` rate-limits broadcasts to ~20 Hz even if
// arecord chunks arrive faster, so the network and the renderer
// stay calm.
var micSubscribers   = [];
var micLastNotifyAt  = 0;
var MIC_NOTIFY_MIN_MS = 50;

function notifyMicSubscribers() {
    if (!micSubscribers.length) return;
    var now = Date.now();
    if (now - micLastNotifyAt < MIC_NOTIFY_MIN_MS) return;
    micLastNotifyAt = now;
    var payload = 'data: ' + JSON.stringify({ left: micLeft, right: micRight }) + '\n\n';
    // Iterate in reverse so a write-error splice doesn't skip a
    // neighbouring subscriber.
    for (var i = micSubscribers.length - 1; i >= 0; i--) {
        try { micSubscribers[i].write(payload); }
        catch (e) { micSubscribers.splice(i, 1); }
    }
}

// Lowest-CPU peak walker for the live meter:
//
//  1. `--period-size=2048` asks ALSA for ~43-ms periods so
//     stdout 'data' fires ~23×/sec instead of the default
//     ~200×/sec. Fewer event-loop wake-ups beats clever inner
//     loops every time.
//  2. The MIC_COMPUTE_MIN_MS throttle is a safety net in case
//     the device ignores the period hint and gives us small
//     chunks anyway — we short-circuit fast and skip the
//     peak walk.
//  3. Inside the walk we stride by MIC_DECIMATE_STRIDE frames
//     (32 bytes per step at 8× decimation). Peaks at audio
//     frequencies are sustained across many samples, so 1-in-8
//     reads chase the same envelope at a fraction of the JS
//     loop cost.
var MIC_COMPUTE_MIN_MS  = 45;
var MIC_DECIMATE_STRIDE = 32;   // bytes per inner-loop step = 8 stereo frames
var micLastComputeAt    = 0;

// Client-intent flag for the live mic-level monitor. The recorder
// temporarily kills arecord while sox owns the codec but leaves
// this flag alone, so the record-finalize callbacks know whether
// to bring the meter back up. /api/mic/level/start and
// /api/mic/level/stop are the only writers.
var micMonitorRequested = false;

// Low-level mic-monitor lifecycle — spawns / kills arecord
// without touching `micMonitorRequested`. Called from
// startRecording and the record-finalize paths, which swap the
// codec owner without flipping the client-visible intent.
function startMicLevelMonitorLowLevel() {
    if (micChild) return { success: true, already: true };
    // Apply the cached input gain so the on-screen meters
    // reflect whatever the slider was last set to, not whatever
    // mixer state the codec happens to be in.
    var gainCard = getNau8822Card();
    if (gainCard) applyInputGain(gainCard, inputGainDb);
    var spawn = require('child_process').spawn;
    try {
        // --buffer-size=4096 caps mic buffer at ~85 ms (2 periods
        // at 2048 frames / 48 kHz). ALSA's default buffer is 8+
        // periods (~340 ms+) which made the meter visibly lag the
        // codec — a gain change would fire instantly but the
        // bars would only react half a second later.
        micChild = spawn('arecord', [
            '-D', 'hw:1,0',
            '-f', 'S16_LE',
            '-r', '48000',
            '-c', '2',
            '--period-size=2048',
            '--buffer-size=4096'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
        micChild = null;
        return { success: false, error: String(e.message || e) };
    }

    micChild.stdout.on('data', function(chunk) {
        // Coarse throttle so a chatty device can't make us walk
        // chunks more often than we need to. The peak we
        // sample is at most 45 ms stale — invisible at meter
        // refresh rates.
        var now = Date.now();
        if (now - micLastComputeAt < MIC_COMPUTE_MIN_MS) return;
        micLastComputeAt = now;
        // Each interleaved stereo frame is 4 bytes: L low, L high,
        // R low, R high. Stride by MIC_DECIMATE_STRIDE bytes so
        // we only inspect 1-in-N frames; with N=8 this is ~60
        // reads per period at 2048 frames, plenty for a peak
        // meter while keeping the loop nearly free.
        var len = chunk.length - (chunk.length % 4);
        var pL  = 0, pR = 0;
        for (var i = 0; i + 3 < len; i += MIC_DECIMATE_STRIDE) {
            var sL = chunk.readInt16LE(i);
            var sR = chunk.readInt16LE(i + 2);
            if (sL < 0) sL = -sL;
            if (sR < 0) sR = -sR;
            if (sL > pL) pL = sL;
            if (sR > pR) pR = sR;
        }
        // 32767 is the max int16. Round to integer percent so the
        // JSON stays compact and the meter pixel math is clean.
        micLeft  = Math.round(pL * 100 / 32767);
        micRight = Math.round(pR * 100 / 32767);
        notifyMicSubscribers();
    });
    var onLeave = function() {
        if (micChild) micChild = null;
        micLeft = 0; micRight = 0;
    };
    micChild.on('exit',  onLeave);
    micChild.on('error', onLeave);
    return { success: true };
}

function stopMicLevelMonitorLowLevel() {
    if (!micChild) return { success: true, already: true };
    try { micChild.kill('SIGKILL'); } catch (e) {}
    micChild = null;
    micLeft  = 0;
    micRight = 0;
    return { success: true };
}

// API-facing wrappers — update the client-intent flag and
// delegate to the low-level lifecycle.
function startMicLevelMonitor() {
    micMonitorRequested = true;
    return startMicLevelMonitorLowLevel();
}
function stopMicLevelMonitor() {
    micMonitorRequested = false;
    return stopMicLevelMonitorLowLevel();
}

// ── UI input forwarding ──────────────────────────────────────
// Runs the python-evdev forwarder scripts under ../scripts that
// clone the Flipper One's key / touchpad evdev devices onto a
// uinput device on seat0. Start = detached background run
// (`nohup … &`) so the forwarder survives this request and the
// node server; stop = `pkill -f`; status = `pgrep -f`. These
// mirror the manual commands exactly:
//   sudo nohup python3 forward-keys.py > /dev/null 2>&1 &
//   sudo pkill -f forward-keys.py
var SCRIPTS_DIR = path.join(BASE, '..', 'scripts');

function forwardScriptName(kind) {
    var names = {
        keys:     'forward-keys.py',
        touchpad: 'forward-touchpad.py',
        remote:   'forward-remote.py'    // d-pad + OK + Back only
    };
    return names[kind] || null;
}

function startForward(kind) {
    var script = forwardScriptName(kind);
    if (!script) {
        return { success: false, error: 'Invalid kind' };
    }
    if (!fs.existsSync(path.join(SCRIPTS_DIR, script))) {
        return { success: false, error: 'Script not found' };
    }
    // Detached so it keeps running independently. cwd = scripts
    // dir so the bare script name resolves (matches the manual
    // command). Fire-and-forget — `&` makes the shell return at
    // once; the python process is reparented to init.
    exec('sudo nohup python3 ' + script + ' > /dev/null 2>&1 &',
        { cwd: SCRIPTS_DIR }, function() {});
    return { success: true };
}

function stopForward(kind) {
    var script = forwardScriptName(kind);
    if (!script) {
        return { success: false, error: 'Invalid kind' };
    }
    exec('sudo pkill -f ' + script, function() {});
    return { success: true };
}

// Is a forwarder currently running? Uses `pgrep -f` with the
// classic bracket trick on the first letter ([f]orward-…) so the
// pgrep command's own shell — whose argv contains the pattern —
// isn't counted as a match.
function isForwardRunning(kind, cb) {
    var script = forwardScriptName(kind);                    // forward-keys.py
    var pat    = '[' + script.charAt(0) + ']' + script.slice(1);  // [f]orward-keys.py
    exec('pgrep -f "' + pat + '"', function(err, stdout) {
        cb(!!(stdout && String(stdout).trim()));
    });
}

// ── UInput typer (synthetic key injection) ───────────────────
// A persistent uinput-type.py keyboard fed key specs on stdin —
// started when the TV Media Box keyboard view opens, stopped when
// it closes. Managed (not detached) so we can pipe keystrokes to
// its stdin; EOF on stdin makes it exit cleanly.
var typeProc = null;

function startType() {
    if (typeProc) return { success: true };
    if (!fs.existsSync(path.join(SCRIPTS_DIR, 'uinput-type.py'))) {
        return { success: false, error: 'Script not found' };
    }
    try {
        typeProc = spawn('sudo', ['python3', 'uinput-type.py'],
            { cwd: SCRIPTS_DIR, stdio: ['pipe', 'ignore', 'ignore'] });
        typeProc.on('error', function() { typeProc = null; });
        typeProc.on('exit',  function() { typeProc = null; });
    } catch (e) {
        typeProc = null;
        return { success: false, error: String((e && e.message) || e) };
    }
    return { success: true };
}

function stopType() {
    if (typeProc) {
        try { typeProc.stdin.end(); } catch (e) {}   // EOF -> clean exit
        try { typeProc.kill('SIGTERM'); } catch (e) {}
        typeProc = null;
    }
    exec('sudo pkill -f uinput-type.py', function() {});   // stray-daemon backstop
    return { success: true };
}

// One key spec to the typer's stdin. keyName must be a KEY_* evdev
// name; shift holds Left-Shift for the tap (uppercase / shifted).
function sendTypeKey(keyName, shift) {
    if (!typeProc || !typeProc.stdin || !typeProc.stdin.writable) {
        return { success: false, error: 'Typer not running' };
    }
    if (typeof keyName !== 'string' || !/^KEY_[A-Z0-9_]+$/.test(keyName)) {
        return { success: false, error: 'Bad key name' };
    }
    var line = (shift ? 'shift ' : '') + keyName + '\n';
    try { typeProc.stdin.write(line); }
    catch (e) { return { success: false, error: String((e && e.message) || e) }; }
    return { success: true };
}

// ── Haptic (force-feedback) ──────────────────────────────────
// scripts/fo-haptic-test.py runs as a long-lived DAEMON: it opens the
// FF device once (holding the fd open so each effect plays its full
// library waveform) and plays a library effect for every index it
// reads on stdin. Started once at server boot and kept alive; playing
// is just writing an index to its stdin. No per-call duration.
var hapticProc = null;

// First /dev/input/eventN whose device advertises FF effects (the
// `B: FF=` bitmap in /proc/bus/input/devices is non-zero). Used only
// for the status endpoint — the daemon auto-detects on its own.
function findHapticEvent() {
    try {
        var blocks = fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\s*\n/);
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            var ffm = b.match(/^B:\s*FF=([0-9a-fA-F ]+)$/m);
            if (!ffm || !/[1-9a-fA-F]/.test(ffm[1])) continue;   // no / all-zero FF
            var hm = b.match(/Handlers=([^\n]*)/);
            var em = hm && hm[1].match(/\bevent(\d+)\b/);
            if (em) return '/dev/input/event' + em[1];
        }
    } catch (e) { /* /proc unavailable */ }
    return null;
}

// Spawn the haptic daemon if it isn't already running (idempotent).
// Detached-ish managed child with a stdin pipe; auto-detects the FF
// device itself. Returns true if a daemon is (now) running.
function ensureHapticDaemon() {
    if (hapticProc) return true;
    if (!fs.existsSync(path.join(SCRIPTS_DIR, 'fo-haptic-test.py'))) return false;
    try {
        hapticProc = spawn('sudo', ['python3', 'fo-haptic-test.py'],
            { cwd: SCRIPTS_DIR, stdio: ['pipe', 'ignore', 'ignore'] });
        hapticProc.on('error', function() { hapticProc = null; });
        hapticProc.on('exit',  function() { hapticProc = null; });
    } catch (e) {
        hapticProc = null;
        return false;
    }
    return true;
}

// Play a library effect: ensure the daemon is up, then write the
// command to its stdin. durationMs is optional — 2..255 plays for that
// many ms; 0 / omitted plays the full library waveform.
function playHapticEffect(effectId, durationMs) {
    var eff = parseInt(effectId, 10);
    if (isNaN(eff) || eff < 0 || eff > 255) return { success: false, error: 'Bad effectId' };
    if (!ensureHapticDaemon() || !hapticProc || !hapticProc.stdin || !hapticProc.stdin.writable) {
        return { success: false, error: 'Haptic daemon not running' };
    }
    var dur  = parseInt(durationMs, 10);
    var hasDur = !isNaN(dur) && dur >= 2 && dur <= 255;
    var line = hasDur ? (eff + ' ' + dur) : String(eff);
    try { hapticProc.stdin.write(line + '\n'); }
    catch (e) { return { success: false, error: String((e && e.message) || e) }; }
    return { success: true, effectId: eff, durationMs: hasDur ? dur : 0 };
}

// ── Boot default (extlinux) ──────────────────────────────────
// Parse /boot/extlinux/extlinux.conf for the DEFAULT entry. The
// profile a label boots is identified by the systemd target in
// its `append … systemd.unit=<X>.target` (e.g.
// tv-media-box.target); a label with no systemd.unit override
// boots the normal graphical/KDE default, reported as 'default'.
// Returns { defaultLabel, defaultName (its MENU LABEL),
// defaultTarget } — nulls if the file is missing / has no
// DEFAULT line. The Boot Menu maps defaultTarget → a profile and
// tags it "default".
var EXTLINUX_CONF = '/boot/extlinux/extlinux.conf';

function readExtlinuxDefault() {
    var out = { defaultLabel: null, defaultName: null, defaultTarget: null };
    try {
        if (!fs.existsSync(EXTLINUX_CONF)) return out;
        var txt = fs.readFileSync(EXTLINUX_CONF, 'utf8');
        var dm = txt.match(/^[ \t]*default[ \t]+(\S+)/im);
        if (!dm) return out;
        out.defaultLabel  = dm[1];
        out.defaultName   = dm[1];
        out.defaultTarget = 'default';   // graphical/KDE unless overridden
        // Walk to the DEFAULT label's block and read its MENU
        // LABEL + the systemd.unit in its append line. Stop at
        // the next LABEL.
        var lines = txt.split('\n');
        var inBlock = false;
        for (var i = 0; i < lines.length; i++) {
            var lm = lines[i].match(/^[ \t]*label[ \t]+(\S+)/i);
            if (lm) {
                if (inBlock) break;
                inBlock = (lm[1].toLowerCase() === out.defaultLabel.toLowerCase());
                continue;
            }
            if (inBlock) {
                var mm = lines[i].match(/^[ \t]*menu[ \t]+label[ \t]+(.+?)[ \t]*$/i);
                if (mm) out.defaultName = mm[1];
                var tm = lines[i].match(/systemd\.unit=(\S+)/i);
                if (tm) out.defaultTarget = tm[1];
            }
        }
    } catch (e) {
        out.error = String(e.message || e);
    }
    return out;
}

// Find the extlinux LABEL that boots `target`: the first block
// whose append carries `systemd.unit=<target>`, or — for the
// pseudo-target 'default' — the first block with no systemd.unit
// override (the normal graphical/KDE boot).
function findLabelForTarget(txt, target) {
    var lines    = txt.split('\n');
    var curLabel = null, curUnit = null, result = null;
    function consider() {
        if (curLabel === null || result !== null) return;
        if (target === 'default') { if (!curUnit) result = curLabel; }
        else if (curUnit === target) { result = curLabel; }
    }
    for (var i = 0; i < lines.length; i++) {
        var lm = lines[i].match(/^[ \t]*label[ \t]+(\S+)/i);
        if (lm) { consider(); curLabel = lm[1]; curUnit = null; continue; }
        var tm = lines[i].match(/systemd\.unit=(\S+)/i);
        if (tm) curUnit = tm[1];
    }
    consider();
    return result;
}

// Switch the running system to a systemd target right now
// (`systemctl isolate <target>`). The target is validated to a
// strict `<name>.target` shape so nothing arbitrary reaches the
// shell. Fire-and-forget: isolating may tear down the session
// running this UI, which is the intended mode switch.
function isolateTarget(target) {
    if (typeof target !== 'string' || !/^[a-z0-9][a-z0-9.\-]*\.target$/i.test(target)) {
        return { success: false, error: 'Invalid target' };
    }
    exec('sudo systemctl isolate ' + target, function() {});
    return { success: true, target: target };
}

// Which boot profile is running right now. Mirrors the Boot
// Menu's ISOLATE_TARGET map (profile → runtime target), checked
// in priority order: the most specific profile target wins.
// Desktop runs graphical.target; TV Media Box runs its own
// tv-media-box.target. They're mutually exclusive in practice,
// but tv-media-box is listed first so it's reported even if a
// build ever leaves graphical.target up alongside it. One
// `systemctl is-active a b` call prints one state line per unit
// in argument order, so a single exec covers both. The unit
// names are hard-coded constants — no user input reaches the
// shell. (Minimal system / multi-user.target isn't a profile yet.)
var TARGET_PROFILES = [
    { target: 'tv-media-box.target', profile: 'TV Media Box' },
    { target: 'router.target',       profile: 'Router' },
    { target: 'graphical.target',    profile: 'Desktop Computer' }
];
function currentTargetProfile(cb) {
    var args = TARGET_PROFILES.map(function(c) { return c.target; }).join(' ');
    exec('systemctl is-active ' + args, function(err, stdout) {
        var lines = String(stdout || '').split('\n');
        for (var i = 0; i < TARGET_PROFILES.length; i++) {
            if ((lines[i] || '').trim() === 'active') return cb(TARGET_PROFILES[i]);
        }
        cb(null);
    });
}

// Every systemd target known to the system — installed unit files
// merged with currently-loaded units — deduped. The Boot Menu uses
// this to decide which profiles are actually available (e.g. show
// "TV Media Box" only when tv-media-box.target exists) instead of
// assuming the targets are present. Both unit names are read from
// the first whitespace-delimited column of each output line.
function listTargets(cb) {
    var set = {};
    var harvest = function(out) {
        String(out || '').split('\n').forEach(function(line) {
            var m = line.trim().match(/^(\S+\.target)\b/);
            if (m) set[m[1]] = true;
        });
    };
    // list-unit-files → installed (may be inactive/never loaded);
    // list-units --all → loaded (active or not). Union covers both.
    exec('systemctl list-unit-files --type=target --no-legend --no-pager', function(e1, o1) {
        harvest(o1);
        exec('systemctl list-units --type=target --all --no-legend --no-pager --plain', function(e2, o2) {
            harvest(o2);
            cb(Object.keys(set));
        });
    });
}

// Rewrite the `default <label>` line so it points at the label
// that boots `target`. Only that one line is touched.
function setExtlinuxDefault(target) {
    if (!target) return { success: false, error: 'No target' };
    try {
        if (!fs.existsSync(EXTLINUX_CONF)) return { success: false, error: 'extlinux.conf not found' };
        var txt   = fs.readFileSync(EXTLINUX_CONF, 'utf8');
        var label = findLabelForTarget(txt, target);
        if (!label) return { success: false, error: 'No label for target ' + target };
        var newTxt = txt.replace(/^([ \t]*default[ \t]+)\S+/im, '$1' + label);
        if (newTxt === txt && !/^[ \t]*default[ \t]+/im.test(txt)) {
            return { success: false, error: 'No default line to rewrite' };
        }
        fs.writeFileSync(EXTLINUX_CONF, newTxt, 'utf8');
        return { success: true, label: label };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

// ── Internet radio streaming ─────────────────────────────────────
// mpg123 streams MP3/Shoutcast/Icecast directly over HTTP, so the
// radio scene can hand us a URL and we hand it straight to a
// child process. Reuses the same `audioChild` slot as the
// file-playback path — only one thing plays at a time, and the
// existing `stopSound()` machinery cleans up either case
// uniformly.
//
// `spawn` (not exec/shell) so the URL goes in as its own argv —
// no shell metacharacters in the user-supplied string ever reach
// /bin/sh. URL scheme is also gated to http(s) on the way in.
function playRadioStream(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Invalid URL' };
    }
    // Mark playing now (intent). The child's exit handler flips it
    // back off if the stream fails / ends; set here so a status
    // poll right after Play can't briefly read stale 'false' while
    // a deferred respawn is pending.
    radioPlaying = true;
    var spawn = require('child_process').spawn;

    function doSpawn() {
        var args = ['-q'];
        // Route to the same ALSA device the rest of the audio
        // stack is using when the user has explicitly picked
        // one — but wrap a raw `hw:` form in `plughw:` so ALSA's
        // plug layer handles any sample-rate / format mismatch.
        // mpg123 outputs the MP3's native rate (44.1 kHz for
        // pop stations), which the HDMI card on this SoC
        // rejects through `hw:` even though the rate is inside
        // its [32000–48000] range — plughw resamples on the
        // fly and "Speaker", "Headphone", and "HDMI" all work
        // off the same code path.
        if (selectedAlsaDevice) {
            var dev = selectedAlsaDevice;
            if (/^hw:/.test(dev)) dev = 'plug' + dev;
            args.push('-a', dev);
        }
        args.push(url);
        var child = spawn('mpg123', args, { stdio: 'ignore' });
        // Identity-guard the global reference: only null it
        // out if we still ARE the active child. Without this,
        // a stale predecessor's exit event (which races with
        // the next playRadioStream call) overwrites the new
        // process's reference and the radio orphans. The exit
        // also flips radioPlaying off — a dead stream's mpg123
        // quits on its own, so the UI's "Playing" line clears.
        child.on('exit',  function() { if (audioChild === child) { audioChild = null; radioPlaying = false; } });
        child.on('error', function() { if (audioChild === child) { audioChild = null; radioPlaying = false; } });
        audioChild = child;
    }

    var oldChild = audioChild;
    audioChild = null;
    if (oldChild) {
        // Drop the old process's exit/error listeners so they
        // can't fire later and stomp on `audioChild` after
        // the new mpg123 has been assigned to it. Then SIGKILL
        // and wait for the kernel to actually reap the
        // process before spawning — that's the only way to
        // guarantee the ALSA device is free.
        oldChild.removeAllListeners('exit');
        oldChild.removeAllListeners('error');
        oldChild.once('exit',  doSpawn);
        oldChild.once('error', doSpawn);
        try { oldChild.kill('SIGKILL'); }
        catch (e) { doSpawn(); }
    } else {
        doSpawn();
    }
    return { success: true, url: url };
}

// ── Voice recorder ───────────────────────────────────────────────
// Captures the on-board NAU8822 codec to 16 kHz mono S16_LE WAV
// files via `sox`. arecord was tried first but its WAV header
// patching is broken on this build (placeholder sizes survive
// SIGINT/SIGTERM, files report ~18 hours long; mid-buffer stops
// also doubled the recorded duration). sox handles SIGINT
// cleanly + writes a valid header; the plug layer
// (`plughw:N,0`) transparently resamples the codec's native
// 48 kHz down to 16 kHz inside ALSA.
//
// `recordChild` and `recordState` are nulled together in the
// child's exit listener so a crash mid-recording can't desync
// them — every observer (status endpoint, the next start) sees
// "not recording" once the OS has actually torn the process down.
var RECORDINGS_DIR = '/flipperone-testing/sound/voice_recordings';
var recordChild    = null;            // sox ChildProcess while recording
var recordPaused   = false;           // true while SIGSTOPped via /api/record/pause
var recordState    = null;            // { file, startedAt: ms } while recording
// Peak amplitude over the most recent sox output chunk,
// normalised to 0..1. Updated synchronously by the sox-stdout
// data handler in `startRecording()` (no polling); reset to 0
// between recordings. Streamed to clients via the
// `/api/record/level` SSE endpoint.
var recordLevel    = 0;
try { fs.mkdirSync(RECORDINGS_DIR, { recursive: true }); } catch (e) {}

// ── Real-time level meter ──
// We pipe sox's RAW PCM stdout through Node — Node writes the
// WAV file AND computes the peak per chunk in the same pass.
// File-tail polling (the previous approach) was hostage to
// sox's stdio buffering: a recording that played back fine
// could still leave the on-disk size unchanged for hundreds of
// ms at a time, freezing the meter. Reading from sox.stdout
// gets us samples within tens of ms of capture and decouples
// the meter cadence from the file's flush schedule entirely.
//
// recordWavWriter holds the active fs.createWriteStream so the
// data handler can append to it; recordWavBytes tracks the
// total audio bytes written so we can patch the WAV header
// sizes on stop. Both are nulled together with recordChild.
var recordWavWriter = null;
var recordWavBytes  = 0;

function buildWavHeader(dataBytes, sampleRate, channels, bitsPerSample) {
    var byteRate   = sampleRate * channels * bitsPerSample / 8;
    var blockAlign = channels * bitsPerSample / 8;
    var buf = Buffer.alloc(44);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);          // ChunkSize
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);                     // Subchunk1Size (PCM)
    buf.writeUInt16LE(1, 20);                      // AudioFormat = PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(bitsPerSample, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);              // Subchunk2Size
    return buf;
}

// Patch the RIFF + data chunk size fields in a WAV file that
// was written with placeholder zeros. Called once on
// recording-stop, after the writer has fully drained.
function patchWavHeader(filePath, dataBytes) {
    try {
        var fd = fs.openSync(filePath, 'r+');
        var b  = Buffer.alloc(4);
        b.writeUInt32LE(36 + dataBytes, 0);
        fs.writeSync(fd, b, 0, 4, 4);              // RIFF ChunkSize
        b.writeUInt32LE(dataBytes, 0);
        fs.writeSync(fd, b, 0, 4, 40);             // data Subchunk2Size
        fs.closeSync(fd);
    } catch (e) { /* file may have been unlinked */ }
}

// Update `recordLevel` from a freshly-read S16LE chunk. Peak
// over the chunk → normalised to 0..1.
function updateLevelFromChunk(chunk) {
    var peak = 0;
    for (var i = 0; i + 1 < chunk.length; i += 2) {
        var s = chunk.readInt16LE(i);
        if (s < 0) s = -s;
        if (s > peak) peak = s;
    }
    recordLevel = peak / 32768;
    if (recordLevel > 1) recordLevel = 1;
}

// Mono-PCM sibling of the stereo peak walk in the mic-monitor
// stdout handler. Called from the recorder's data handlers
// while sox owns the codec — the live mic-monitor arecord is
// parked during recording, so without this the on-screen
// bars would freeze the moment Start is pressed.
function updateMicLevelFromRecordingChunk(chunk) {
    var now = Date.now();
    if (now - micLastComputeAt < MIC_COMPUTE_MIN_MS) return;
    micLastComputeAt = now;
    var len = chunk.length - (chunk.length % 2);
    if (len <= 0) return;
    var peak = 0;
    for (var i = 0; i + 1 < len; i += MIC_DECIMATE_STRIDE) {
        var s = chunk.readInt16LE(i);
        if (s < 0) s = -s;
        if (s > peak) peak = s;
    }
    var pct = Math.round(peak * 100 / 32767);
    micLeft  = pct;
    micRight = pct;
    notifyMicSubscribers();
}

// Reset the live level. Called from sox's `exit` / `error`
// handlers via `finalize()` so the meter snaps back to 0 the
// instant a recording ends — without this the last frame's
// peak would linger until something else updated it.
function stopLevelPoll() {
    recordLevel = 0;
}

// Strip everything that could turn a user-supplied filename
// into a path-traversal / weird-file-name footgun.
function sanitizeRecordingName(name) {
    var s = String(name == null ? '' : name);
    s = s.replace(/[\x00-\x1f]/g, '');
    s = s.replace(/[\/\\]/g, '');
    s = s.replace(/\.\./g, '');
    s = s.replace(/\.(wav|mp3|ogg)$/i, '');
    s = s.replace(/^\s+|\s+$/g, '');
    if (s.length > 128) s = s.slice(0, 128);
    return s;
}

// Is `filename` already present in the recordings directory?
// Wrapped so the collision walker below stays readable; uses
// `accessSync` rather than `existsSync` because the latter is
// deprecated in older Node versions on this image.
function recordingExists(filename) {
    try {
        fs.accessSync(path.join(RECORDINGS_DIR, filename), fs.constants.F_OK);
        return true;
    } catch (e) {
        return false;
    }
}

function buildRecordingFilename(ext, name) {
    var safeExt = ext || 'wav';
    var base;
    if (name) {
        var clean = sanitizeRecordingName(name);
        if (clean) base = clean;
    }
    if (!base) {
        // Server-side fallback when the client doesn't send a
        // name. Still sortable + unique-per-second.
        var d   = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : String(n); };
        base = 'rec-'
             + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
             + '-'
             + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }
    // Preferred form is the bare base name. If it's free, take
    // it. Otherwise walk `-1`, `-2`, … and use the first free
    // slot — filling gaps so the suffix stays small and matches
    // how desktop file managers handle duplicates. Cap the walk
    // at 10 000 attempts and fall back to a unix-timestamp
    // suffix in the pathological case, so the API never spins
    // forever on a fully-stuffed directory.
    var candidate = base + '.' + safeExt;
    if (!recordingExists(candidate)) return candidate;
    for (var i = 1; i < 10000; i++) {
        candidate = base + '-' + i + '.' + safeExt;
        if (!recordingExists(candidate)) return candidate;
    }
    return base + '-' + Date.now() + '.' + safeExt;
}

// Cache of audio-file durations so listing the folder doesn't
// shell out to soxi on every poll. Key is `name|mtime|size` so
// a file edited in place (e.g. truncated, overwritten) is
// recognised as new and re-probed automatically.
var durationCacheMs = Object.create(null);

function probeDurationMs(filePath) {
    // soxi -D returns the duration in seconds as a float. We
    // multiply to ms and round. A failed probe (corrupt file,
    // unsupported codec) just yields null — the client falls
    // back to a dash.
    try {
        var out = execSync('soxi -D ' + JSON.stringify(filePath)
                         + ' 2>/dev/null',
                         { encoding: 'utf8', timeout: 2000 });
        var secs = parseFloat(out);
        if (!isFinite(secs) || secs <= 0) return null;
        return Math.round(secs * 1000);
    } catch (e) {
        return null;
    }
}

function getRecordings() {
    var files = [];
    try {
        var entries = fs.readdirSync(RECORDINGS_DIR);
        for (var i = 0; i < entries.length; i++) {
            if (!/\.(wav|mp3|ogg)$/i.test(entries[i])) continue;
            try {
                var full = path.join(RECORDINGS_DIR, entries[i]);
                var st   = fs.statSync(full);
                var key  = entries[i] + '|' + st.mtimeMs + '|' + st.size;
                var dur  = durationCacheMs[key];
                if (dur === undefined) {
                    dur = probeDurationMs(full);
                    durationCacheMs[key] = dur;
                }
                files.push({
                    name:       entries[i],
                    size:       st.size,
                    mtime:      st.mtimeMs,
                    durationMs: dur
                });
            } catch (e) { /* skip unreadable */ }
        }
        // Newest first — list view always lands on most-recent.
        files.sort(function(a, b) { return b.mtime - a.mtime; });
    } catch (e) {}
    return files;
}

// Single-knob input gain. The voice-recorder UI exposes one
// slider in [INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB] dB and POSTs
// every change here; recording start also re-applies the
// cached value so a take begins with the slider position the
// user can see. The "dB" units are nominal — they label the
// slider's UI range, not a calibrated codec dB. We map the
// position linearly onto each writable capture control's
// 0..100 % range for a smooth monotonic ramp without
// depending on amixer's per-build dB scaling.
var INPUT_GAIN_MIN_DB = -20;
var INPUT_GAIN_MAX_DB = 40;
var inputGainDb       = 0;
// Cache of amixer controls that responded on the first
// applyInputGain call. Until populated we fire the full
// discovery volley (~16 amixer calls / ~1 s of blocked event
// loop); once populated we fire only the 1-3 controls that
// actually exist, which keeps the slider responsive AND lets
// arecord stdout drain so the meter doesn't lag a second
// behind the codec.
//   { pctCtrls: [string,…], boostCtrls: [string,…] }
var inputGainCtrlCache = null;
var INPUT_GAIN_PCT_CANDIDATES = [
    'Capture PGA Volume',
    'Capture PGA',
    'PGA Volume',
    'PGA',
    'Capture',
    'Mic',
    'Input PGA',
    'Input PGA Volume',
    'Left Input PGA',
    'Right Input PGA',
    'Left Input PGA Volume',
    'Right Input PGA Volume'
];
var INPUT_GAIN_BOOST_CANDIDATES = [
    'Capture PGA Boost',
    'PGA Boost',
    'Mic Boost',
    'Capture Boost'
];

// Input source selection. Per the board's device-tree routing
// (`simple-audio-card,routing` on the NAU8822 node):
//
//   LMICP ← Internal Microphone
//   LMICN ← Internal Microphone
//   RMICP ← Headset Microphone
//
// so the built-in mic feeds the LEFT ADC channel (differential
// across LMICP/LMICN) and the 3.5-mm jack mic feeds the RIGHT
// ADC channel (single-ended on RMICP). The codec exposes those
// pins to the ADC through the `Left Input Mixer` /
// `Right Input Mixer` MicP / MicN switches — that's the real
// gate. The top-level `Internal Microphone` / `Headset
// Microphone` switches only toggle the upstream DAPM widgets,
// not the channel mixer, which is why simply flipping them
// leaves both mics hot on their respective ADC sides.
//
// Exclusive routing therefore has to operate at the input
// mixer:
//   builtin → Left Input Mixer MicP/MicN on,
//             Right Input Mixer MicP/MicN off
//   jack    → Left Input Mixer MicP/MicN off,
//             Right Input Mixer MicP/MicN on
// (the upstream Internal/Headset pin-switches are still toggled
// alongside so DAPM powers down the unused mic-bias / preamp.)
//
// Recording capture additionally uses sox's `remix` effect to
// take only the populated channel (channel 1 for builtin,
// channel 2 for jack) so the WAV gets the chosen mic at full
// scale instead of (signal + silence) / 2 ≈ -6 dB.
var INPUT_SOURCES = {
    builtin: {
        internal: 'on',  headset: 'off',
        leftMixer: 'on', rightMixer: 'off',
        soxChannel: 1
    },
    jack: {
        internal: 'off', headset: 'on',
        leftMixer: 'off', rightMixer: 'on',
        soxChannel: 2
    }
};
var inputSource = 'builtin';

function applyInputSource(card, source) {
    var trace = { source: null, calls: [] };
    if (!card) return trace;
    var route = INPUT_SOURCES[source];
    if (!route) return trace;
    inputSource  = source;
    trace.source = source;

    function run(ctrl, value) {
        var entry = { ctrl: ctrl, value: value, ok: false };
        try {
            execSync('amixer -c ' + card + ' -- set '
                   + JSON.stringify(ctrl) + ' ' + JSON.stringify(value)
                   + ' 2>/dev/null',
                   { encoding: 'utf8', timeout: 1500 });
            entry.ok = true;
        } catch (e) {
            entry.error = String(e.message || e).slice(0, 120);
        }
        trace.calls.push(entry);
    }
    run('Internal Microphone',     route.internal);
    run('Headset Microphone',      route.headset);
    run('Left Input Mixer MicP',   route.leftMixer);
    run('Left Input Mixer MicN',   route.leftMixer);
    run('Right Input Mixer MicP',  route.rightMixer);
    run('Right Input Mixer MicN',  route.rightMixer);
    return trace;
}

// Apply `db` to the NAU8822 capture chain. First call discovers
// which control names this driver build actually exposes (slow,
// ~16 amixer calls); subsequent calls fire only the cached
// winners (~1-3 calls, ~150 ms). Mic Boost is wired to the
// slider's upper half so even if no PGA name lands we still
// get a +20 dB step the user can feel.
function applyInputGain(card, db) {
    var trace = { db: null, calls: [], discovered: false };
    if (!card) return trace;
    if (db == null || isNaN(db)) db = inputGainDb;
    if (db < INPUT_GAIN_MIN_DB) db = INPUT_GAIN_MIN_DB;
    if (db > INPUT_GAIN_MAX_DB) db = INPUT_GAIN_MAX_DB;
    inputGainDb = db;
    trace.db    = db;

    var pct = Math.round(
        (db - INPUT_GAIN_MIN_DB) * 100 /
        (INPUT_GAIN_MAX_DB - INPUT_GAIN_MIN_DB)
    );
    var boostOn  = db >= ((INPUT_GAIN_MIN_DB + INPUT_GAIN_MAX_DB) / 2);
    var boostVal = boostOn ? 'on' : 'off';

    function run(ctrl, value) {
        var entry = { ctrl: ctrl, value: value, ok: false };
        try {
            execSync('amixer -c ' + card + ' -- set '
                   + JSON.stringify(ctrl) + ' ' + JSON.stringify(value)
                   + ' 2>/dev/null',
                   { encoding: 'utf8', timeout: 1500 });
            entry.ok = true;
        } catch (e) {
            entry.error = String(e.message || e).slice(0, 120);
        }
        trace.calls.push(entry);
        return entry.ok;
    }

    if (inputGainCtrlCache) {
        var pctList   = inputGainCtrlCache.pctCtrls;
        var boostList = inputGainCtrlCache.boostCtrls;
        for (var p = 0; p < pctList.length;   p++) run(pctList[p],   pct + '%');
        for (var b = 0; b < boostList.length; b++) run(boostList[b], boostVal);
        return trace;
    }

    // Cold path: fire every candidate once, cache the winners.
    trace.discovered = true;
    var pctOk = [], boostOk = [];
    for (var i = 0; i < INPUT_GAIN_PCT_CANDIDATES.length; i++) {
        if (run(INPUT_GAIN_PCT_CANDIDATES[i], pct + '%')) {
            pctOk.push(INPUT_GAIN_PCT_CANDIDATES[i]);
        }
    }
    for (var j = 0; j < INPUT_GAIN_BOOST_CANDIDATES.length; j++) {
        if (run(INPUT_GAIN_BOOST_CANDIDATES[j], boostVal)) {
            boostOk.push(INPUT_GAIN_BOOST_CANDIDATES[j]);
        }
    }
    inputGainCtrlCache = { pctCtrls: pctOk, boostCtrls: boostOk };
    return trace;
}

// Per-format encoder pipeline metadata. Null `binary` = sox
// raw → Node WAV header (legacy). For MP3 / OGG we pipe sox's
// WAV stdout into the encoder via stdin; the encoder owns the
// file write end-to-end. Args use WAV-on-stdin so the encoder
// auto-detects rate/channels/bitdepth, dodging per-build
// CLI flag drift.
var RECORD_FORMATS = {
    wav: { ext: 'wav', binary: null, pkg: null },
    mp3: {
        ext: 'mp3',
        binary: 'lame',
        pkg:    'lame',
        buildArgs: function(filePath) {
            // lame autodetects WAV from stdin (no -r/-s needed).
            // -V 4 ≈ ~165 kbps VBR mono — voice transparency
            // with room to spare.
            return ['--quiet', '-V', '4', '-', filePath];
        }
    },
    ogg: {
        ext: 'ogg',
        binary: 'oggenc',
        pkg:    'vorbis-tools',
        buildArgs: function(filePath) {
            // oggenc autodetects WAV from stdin. -q 4 ≈
            // ~128 kbps target — same band as the lame default.
            return ['-Q', '-q', '4', '-o', filePath, '-'];
        }
    }
};
var recordEncoderChild     = null;
var recordEncoderAvailable = {};

function probeEncoder(binary) {
    if (!binary) return true;
    if (recordEncoderAvailable.hasOwnProperty(binary)) {
        return recordEncoderAvailable[binary];
    }
    var ok = false;
    try {
        execSync('which ' + binary, { timeout: 2000 });
        ok = true;
    } catch (e) { /* not installed */ }
    recordEncoderAvailable[binary] = ok;
    return ok;
}

function startRecording(format, name) {
    if (recordChild) {
        return { success: false, error: 'Already recording' };
    }
    var fmtId = (format || 'wav').toLowerCase();
    var fmt   = RECORD_FORMATS[fmtId];
    if (!fmt) {
        return { success: false, error: 'Unsupported format: ' + format };
    }
    if (fmt.binary && !probeEncoder(fmt.binary)) {
        return {
            success: false,
            error: fmt.binary + ' not installed',
            missingFormat:  fmtId,
            missingPackage: fmt.pkg
        };
    }
    var card = getNau8822Card();
    if (!card) {
        return { success: false, error: 'NAU8822 not found' };
    }
    // Codec contention guard — if something is playing back
    // through the same codec, kill it before opening capture.
    // No inverse on the playback side; full-duplex hasn't been
    // exercised on this build so the safer bet is one-at-a-time.
    stopSound();
    // Same problem on the capture side: the mic-level monitor
    // holds hw:1,0 exclusively (ALSA hw: devices are single-
    // reader), so sox's open would fail silently and we'd get
    // a 44-byte header-only WAV. Release it at the LOW level
    // so the client-intent flag stays true — the finalize
    // callbacks bring the monitor back up once sox hands the
    // codec back.
    stopMicLevelMonitorLowLevel();

    var filename = buildRecordingFilename(fmt.ext, name);
    var filePath = path.join(RECORDINGS_DIR, filename);
    applyInputSource(card, inputSource);
    applyInputGain(card, inputGainDb);

    var device   = 'hw:' + card + ',0';
    // sox writes RAW S16LE samples to stdout; we read them
    // here, write them to the WAV file (with our own header),
    // and update the level meter in the same pass. This keeps
    // the meter responsive — sox's file-write buffering used
    // to leave the file's tail stale for hundreds of ms at a
    // time, freezing the meter even though playback was fine.
    //
    // Capture rate matches the NAU8822's native 48 kHz: the
    // codec only opens at 48 k on hw:, and asking the plug
    // layer to resample down to 16 k introduced audible
    // artifacts + cut everything above 8 kHz. 48 k mono S16LE
    // ≈ 96 KB/s on disk — heavier than the old 32 KB/s but
    // still a couple of GB per day max, well within the eMMC
    // budget for voice memos.
    //
    // Effects chain (in order):
    //   remix N       — keeps only the input channel that the
    //                   selected mic feeds (1 = left = built-in
    //                   mic, 2 = right = 3.5-mm jack). The
    //                   `applyInputSource` mute above silences
    //                   the other channel at the ADC, but sox's
    //                   default stereo→mono downmix would still
    //                   average the two and drop the signal
    //                   ~6 dB. remix takes just the live channel.
    //   highpass 80   — rolls off sub-bass rumble + DC drift
    //                   that just amplify into noise on boost.
    //   gain N        — software make-up gain on top of the
    //                   amixer hardware bumps above. Smaller
    //                   than before since the hardware does
    //                   the heavy lifting now.
    var RECORD_GAIN_DB = 6;
    var soxChannel     = (INPUT_SOURCES[inputSource] || INPUT_SOURCES.builtin).soxChannel;
    var spawn = require('child_process').spawn;

    // ── WAV legacy path ─────────────────────────────────────────
    // sox emits raw mono S16LE on stdout, Node writes the WAV
    // header + data and patches the size fields on stop.
    if (fmtId === 'wav') {
        var soxArgsRaw = ['-q', '-t', 'alsa', device,
                          '-r', '48000', '-c', '1', '-b', '16',
                          '-t', 'raw', '-e', 'signed-integer', '-L', '-',
                          'remix', String(soxChannel),
                          'highpass', '80',
                          'gain', String(RECORD_GAIN_DB)];
        var fileStream = null;
        try {
            fileStream = fs.createWriteStream(filePath);
            fileStream.write(buildWavHeader(0, 48000, 1, 16));
        } catch (e) {
            return { success: false, error: String(e.message || e) };
        }
        try {
            recordChild = spawn('sox', soxArgsRaw, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            try { fileStream.end(); } catch (e2) {}
            recordChild = null;
            return { success: false, error: String(e.message || e) };
        }
        recordWavWriter = fileStream;
        recordWavBytes  = 0;
        recordState     = { file: filename, startedAt: Date.now(), format: 'wav' };

        var wavSoxErr = '';
        if (recordChild.stderr) {
            recordChild.stderr.on('data', function(chunk) {
                wavSoxErr = (wavSoxErr + chunk.toString()).slice(-4096);
            });
        }
        recordChild.stdout.on('data', function(chunk) {
            // Drop file writes while paused — sox keeps running
            // (so the input-level meter, which reads from this
            // same stream, keeps updating), but the chunk
            // doesn't land in the WAV. That gives the user
            // both:
            //   1. A live meter while paused (the codec is still
            //      capturing; they can confirm the mic is hot).
            //   2. A gap-free output file — the seconds spent
            //      paused don't end up in the recording.
            // The level updates still fire so the meter reads
            // current mic activity.
            if (!recordPaused) {
                try {
                    if (recordWavWriter) recordWavWriter.write(chunk);
                } catch (e) { /* writer closed mid-flight */ }
                recordWavBytes += chunk.length;
            }
            updateLevelFromChunk(chunk);
            updateMicLevelFromRecordingChunk(chunk);
        });

        var wavFinalized = false;
        var wavFilePath  = filePath;
        function wavFinalize() {
            if (wavFinalized) return;
            wavFinalized = true;
            var path0  = wavFilePath;
            var bytes0 = recordWavBytes;
            if (recordWavWriter) {
                try {
                    recordWavWriter.end(function() {
                        patchWavHeader(path0, bytes0);
                    });
                } catch (e) {
                    patchWavHeader(path0, bytes0);
                }
            }
            if (bytes0 === 0) {
                console.warn('[record] empty WAV output',
                    JSON.stringify({
                        file:   path0,
                        soxErr: wavSoxErr.trim().slice(-512)
                    }));
            }
            recordChild     = null;
            recordState     = null;
            recordPaused    = false;
            recordWavWriter = null;
            recordWavBytes  = 0;
            stopLevelPoll();
            if (micMonitorRequested) {
                startMicLevelMonitorLowLevel();
            }
        }
        recordChild.on('exit',  wavFinalize);
        recordChild.on('error', wavFinalize);
        return { success: true, file: filename, format: 'wav' };
    }

    // ── MP3 / OGG piped path ────────────────────────────────────
    // sox writes a WAV stream to stdout; we pipe it into the
    // encoder's stdin. The encoder owns the file write end to
    // end (proper container header + footer). Both children
    // are tracked so stopRecording can finalize cleanly.
    var soxArgsWav = ['-q', '-t', 'alsa', device,
                      '-r', '48000', '-c', '1', '-b', '16',
                      '-t', 'wav', '-',
                      'remix', String(soxChannel),
                      'highpass', '80',
                      'gain', String(RECORD_GAIN_DB)];
    try {
        recordChild = spawn('sox', soxArgsWav, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        recordChild = null;
        return { success: false, error: String(e.message || e) };
    }
    try {
        recordEncoderChild = spawn(fmt.binary, fmt.buildArgs(filePath),
                                   { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
        try { recordChild.kill('SIGKILL'); } catch (e2) {}
        recordChild        = null;
        recordEncoderChild = null;
        return { success: false, error: String(e.message || e) };
    }
    recordChild.stdout.pipe(recordEncoderChild.stdin);
    recordEncoderChild.stdin.on('error', function() { /* swallow EPIPE */ });

    // stderr capture for diagnostics on both sides of the pipe.
    var soxErr = '';
    if (recordChild.stderr) {
        recordChild.stderr.on('data', function(chunk) {
            soxErr = (soxErr + chunk.toString()).slice(-4096);
        });
    }
    var encErr = '';
    if (recordEncoderChild.stderr) {
        recordEncoderChild.stderr.on('data', function(chunk) {
            encErr = (encErr + chunk.toString()).slice(-4096);
        });
    }

    // Tally piped bytes + drive the on-screen meter bars. sox
    // emits a WAV stream (44-byte RIFF prefix, then raw PCM),
    // so we skip the header before feeding the helper.
    var pipedBytes      = 0;
    var meterHeaderSeen = 0;
    recordChild.stdout.on('data', function(chunk) {
        pipedBytes += chunk.length;
        if (meterHeaderSeen < 44) {
            if (chunk.length + meterHeaderSeen <= 44) {
                meterHeaderSeen += chunk.length;
                return;
            }
            var skip = 44 - meterHeaderSeen;
            meterHeaderSeen = 44;
            updateMicLevelFromRecordingChunk(chunk.slice(skip));
            return;
        }
        updateMicLevelFromRecordingChunk(chunk);
    });

    recordState = { file: filename, startedAt: Date.now(), format: fmtId };

    var pipeFinalized = false;
    var pipedFilePath = filePath;
    function pipeFinalize() {
        if (recordChild        && recordChild.exitCode        === null) return;
        if (recordEncoderChild && recordEncoderChild.exitCode === null) return;
        if (pipeFinalized) return;
        pipeFinalized = true;
        var outSize = 0;
        try { outSize = fs.statSync(pipedFilePath).size; } catch (e) {}
        if (pipedBytes === 0 || outSize === 0) {
            console.warn('[record] empty pipeline output',
                JSON.stringify({
                    file:       pipedFilePath,
                    piped:      pipedBytes,
                    outputSize: outSize,
                    soxErr:     soxErr.trim().slice(-512),
                    encErr:     encErr.trim().slice(-512)
                }));
        }
        recordChild        = null;
        recordEncoderChild = null;
        recordState        = null;
        recordPaused       = false;
        stopLevelPoll();
        if (micMonitorRequested) {
            startMicLevelMonitorLowLevel();
        }
    }
    recordChild.on('exit',          pipeFinalize);
    recordChild.on('error',         pipeFinalize);
    recordEncoderChild.on('exit',   pipeFinalize);
    recordEncoderChild.on('error',  pipeFinalize);

    return { success: true, file: filename, format: fmtId };
}

function stopRecording() {
    if (!recordChild) {
        return { success: true, recording: false };
    }
    var file = recordState ? recordState.file : null;
    try {
        // SIGINT lets sox flush its WAV header cleanly and
        // closes its stdout so the encoder pipe (MP3 / OGG
        // path) sees EOF and finalizes a valid container.
        recordChild.kill('SIGINT');
    } catch (e) { /* already gone */ }
    // Safety net: force-kill the encoder if it doesn't exit
    // within a few seconds of sox closing (flushing a small
    // tail buffer is fast; longer means stuck).
    if (recordEncoderChild) {
        var encoderRef = recordEncoderChild;
        setTimeout(function() {
            try {
                if (encoderRef && encoderRef.exitCode === null) {
                    encoderRef.kill('SIGKILL');
                }
            } catch (e) { /* already gone */ }
        }, 3000);
    }
    return { success: true, recording: false, file: file };
}

function deleteRecording(filename) {
    if (typeof filename !== 'string') {
        return { success: false, error: 'Missing filename' };
    }
    if (/[\/\\]/.test(filename) || !/\.(wav|mp3|ogg)$/i.test(filename)) {
        return { success: false, error: 'Invalid filename' };
    }
    var filePath = path.join(RECORDINGS_DIR, filename);
    try {
        fs.unlinkSync(filePath);
        return { success: true };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

// Playback state for the voice-recorder player UI. Tracks
// which file is loaded, where we are in it, and whether the
// child is currently producing audio. Position is calculated
// on demand from `startedAt + startOffsetMs` while playing,
// or from `pausedAtMs` while paused — sox doesn't surface a
// live cursor so the elapsed-time math is the source of truth.
var audioPlay = null;
//   { file, durationMs, startedAt, startOffsetMs,
//     playing, paused, pausedAtMs, child }

// Compute the current playback position in ms. Returns 0 when
// no playback is loaded. When playback has stopped, the
// returned value depends on WHY it stopped: a natural
// end-of-file completion lands at durationMs (so the progress
// bar shows full); a failed spawn or early exit lands at the
// start offset (so the bar doesn't lie about where playback
// "got to"). The `completed` flag is set by the exec callback
// once it can tell whether the run went the distance.
function playbackPositionMs() {
    if (!audioPlay) return 0;
    if (audioPlay.paused) return audioPlay.pausedAtMs || 0;
    if (!audioPlay.playing) {
        return audioPlay.completed
            ? (audioPlay.durationMs || 0)
            : (audioPlay.startOffsetMs || 0);
    }
    var pos = audioPlay.startOffsetMs + (Date.now() - audioPlay.startedAt);
    if (audioPlay.durationMs > 0 && pos > audioPlay.durationMs) {
        pos = audioPlay.durationMs;
    }
    return pos;
}

function playRecording(filename, positionMs) {
    // Mirror playSoundFile but sourced from RECORDINGS_DIR. We
    // share the global audioChild so /api/sound/play and
    // /api/record/play can't end up dueling over the codec —
    // whichever fires last wins, and stopSound() cleanly kills
    // the predecessor.
    if (typeof filename !== 'string' || /[\/\\]/.test(filename)) {
        return { success: false, error: 'Invalid filename' };
    }
    var filePath = path.join(RECORDINGS_DIR, filename);
    if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
    }
    // stopSound first — it may kill an active audioChild and
    // update _audioChildExit. THEN capture the exit promise:
    // whichever child was killed most recently (either by us
    // just now, or by pausePlayback before resumePlayback
    // called us) is the one we have to wait on before spawning
    // new sox.
    stopSound();
    var prevExit = _audioChildExit;
    var startMs = Math.max(0, Number(positionMs) || 0);
    // Build the sox argv. We use spawn() not exec() so SIGKILL
    // goes DIRECTLY to the sox process — exec()'s `/bin/sh -c`
    // wrapper would leave sox as an orphan child of init when
    // the shell is killed, so the audio would keep playing
    // even after pause. argv:
    //   /usr/bin/play <file> channels 2 [trim <sec>]
    // `channels 2` upsamples mono to stereo so the NAU8822's
    // I2S frame doesn't drain 4× too fast (chipmunk effect).
    // `trim <sec>` is sox's seek primitive — used to resume
    // from a paused position or to land a ±N s seek.
    var soxArgs = [filePath, 'channels', '2'];
    if (startMs > 0) {
        soxArgs.push('trim', (startMs / 1000).toFixed(3));
    }
    // Pin AUDIODEV so sox doesn't try to use ALSA's "default"
    // (pipewire, only visible to the desktop user — this
    // server runs as root). Passed via env to spawn() instead
    // of being prepended to a shell string.
    var audioDev = selectedAlsaDevice;
    if (!audioDev) {
        var card = getNau8822Card();
        if (card != null) audioDev = 'plughw:' + card + ',0';
    }
    var soxEnv = Object.assign({}, process.env);
    if (audioDev) soxEnv.AUDIODEV = audioDev;
    var dur = probeDurationMs(filePath) || 0;
    // Set audioPlay state synchronously so /status reflects
    // "playing" from the moment this function returns. The
    // actual sox spawn is deferred until the previous child
    // has fully exited (to avoid ALSA EBUSY races), but the
    // user-visible state shouldn't blink through a "nothing
    // is loaded" frame.
    var pendingState = {
        file:          filename,
        durationMs:    dur,
        startedAt:     Date.now(),
        startOffsetMs: startMs,
        playing:       true,
        paused:        false,
        pausedAtMs:    0,
        completed:     false,
        child:         null
    };
    audioPlay = pendingState;
    // Async: once the previous child has actually exited (and
    // released ALSA), spawn the new sox. Skip the spawn if
    // someone replaced or cleared audioPlay in the meantime
    // (e.g. user hit Stop before sox could start).
    prevExit.then(function() {
        if (audioPlay !== pendingState) return;
        var child;
        try {
            child = spawn('play', soxArgs, {
                env:   soxEnv,
                stdio: ['ignore', 'ignore', 'pipe']
            });
        } catch (e) { return; }
        // 60 s safety timeout — replaces the timeout option
        // that exec() carried. Cleared on natural exit.
        var hardTimeout = setTimeout(function() {
            try { child.kill('SIGKILL'); } catch (e) {}
        }, 60000);
        child.once('exit', function(code) {
            clearTimeout(hardTimeout);
            // `completed` distinguishes a healthy playthrough
            // from a failed spawn: the position reporter uses
            // it to pick between "park at the end" and "park
            // at the start offset".
            if (audioChild === child) audioChild = null;
            if (audioPlay && audioPlay.child === child) {
                var elapsed  = Date.now() - audioPlay.startedAt;
                var expected = (audioPlay.durationMs || 0)
                             - (audioPlay.startOffsetMs || 0);
                audioPlay.completed = code === 0 && expected > 0
                    && (elapsed + 500) >= expected;
                audioPlay.child   = null;
                audioPlay.playing = false;
            }
        });
        child.once('error', function() { clearTimeout(hardTimeout); });
        audioChild           = child;
        pendingState.child   = child;
        // Re-anchor startedAt at the actual spawn time so the
        // reported position doesn't drift forward during the
        // tiny window between API return and spawn firing.
        pendingState.startedAt = Date.now();
    });
    return {
        success:    true,
        file:       filename,
        positionMs: startMs,
        durationMs: dur
    };
}

function pausePlayback() {
    if (!audioPlay || !audioPlay.playing) {
        return { success: false, error: 'Not playing' };
    }
    var pos = playbackPositionMs();
    audioPlay.pausedAtMs = pos;
    audioPlay.paused     = true;
    audioPlay.playing    = false;
    // _killAudioChild captures the exit promise into
    // _audioChildExit, which the next playRecording (i.e.
    // resume) waits on before spawning new sox.
    _killAudioChild();
    audioPlay.child = null;
    return { success: true, positionMs: Math.round(pos) };
}

function resumePlayback() {
    if (!audioPlay || !audioPlay.paused) {
        return { success: false, error: 'Not paused' };
    }
    return playRecording(audioPlay.file, audioPlay.pausedAtMs || 0);
}

function seekPlayback(deltaMs) {
    if (!audioPlay) {
        return { success: false, error: 'Nothing loaded' };
    }
    var current = playbackPositionMs();
    var target  = current + (Number(deltaMs) || 0);
    if (target < 0) target = 0;
    if (audioPlay.durationMs > 0 && target > audioPlay.durationMs) {
        target = audioPlay.durationMs;
    }
    // Was paused: stay paused at new position (sox restart on
    // resume picks it up via trim).
    if (audioPlay.paused) {
        audioPlay.pausedAtMs = target;
        return { success: true, positionMs: Math.round(target), paused: true };
    }
    // Was playing: restart sox at the new position.
    return playRecording(audioPlay.file, target);
}

function getPlaybackStatus() {
    if (!audioPlay) {
        return {
            file:       null,
            playing:    false,
            paused:     false,
            positionMs: 0,
            durationMs: 0
        };
    }
    return {
        file:       audioPlay.file,
        playing:    !!audioPlay.playing,
        paused:     !!audioPlay.paused,
        positionMs: Math.round(playbackPositionMs()),
        durationMs: audioPlay.durationMs
    };
}

var selectedAlsaDevice = null; // e.g. "hw:3,0" — persists for this server session

function getAudioDevices() {
    var result = { devices: [], defaultDevice: selectedAlsaDevice };
    try {
        var out = execSync('aplay -l 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        var lines = out.split('\n');
        for (var i = 0; i < lines.length; i++) {
            // Match: card 3: NAU8822 [On-board Analog NAU8822], device 0: ...
            var m = lines[i].match(/^card (\d+): (\S+) \[([^\]]+)\], device (\d+): (.+)/);
            if (m) {
                var hwName = 'hw:' + m[1] + ',' + m[4];
                result.devices.push({
                    name: hwName,
                    cardName: m[2],
                    description: m[3],
                    device: m[4],
                    detail: m[5]
                });
            }
        }
    } catch (e) {}
    return result;
}

function setDefaultDevice(deviceName) {
    // Validate it's a real hw: device string
    if (!/^hw:\d+,\d+$/.test(deviceName)) {
        return { success: false, error: 'Invalid device name' };
    }
    selectedAlsaDevice = deviceName;
    return { success: true, device: deviceName };
}

// Find NAU8822 card number dynamically
function getNau8822Card() {
    try {
        var cards = fs.readFileSync('/proc/asound/cards', 'utf8');
        var m = cards.match(/^\s*(\d+)\s+\[NAU8822/m);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

function getVolume() {
    var result = { speaker: null, headphone: null, speakerMuted: false, headphoneMuted: false };
    var card = getNau8822Card();
    if (!card) return result;
    try {
        var spk = execSync('amixer -c ' + card + ' get Speaker 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
        var ms = spk.match(/\[(\d+)%\]/);
        if (ms) result.speaker = parseInt(ms[1], 10);
        result.speakerMuted = /\[off\]/.test(spk);
    } catch (e) {}
    try {
        var hp = execSync('amixer -c ' + card + ' get Headphone 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
        var mh = hp.match(/\[(\d+)%\]/);
        if (mh) result.headphone = parseInt(mh[1], 10);
        result.headphoneMuted = /\[off\]/.test(hp);
    } catch (e) {}
    return result;
}

// ── High-level audio outputs ─────────────────────────────────────
// The radio app's "Audio device" picker thinks in terms of where
// the user wants the sound to come out (Speaker / Headphone / HDMI
// / DisplayPort), not which hw:N,0 device is involved. Speaker
// and Headphone share the same NAU8822 card — the split happens
// in the codec mixer (Speaker Switch / Headphones Switch +
// per-channel Playback Switches), which has no jack detection
// on this board, so the user picks explicitly and we mute the
// non-active path.
//
// Loopback (snd_aloop) is intentionally absent: it has no
// physical output and listening through it gives silence.
//
// `selectedOutputId` is best-effort state — it's only read when
// the radio app refreshes its picker and reset whenever the
// user explicitly picks an output. The Sound app's lower-level
// AudioDevicesScene still uses /api/sound/device directly and
// is unaffected.
var selectedOutputId = 'speaker';

function getSoundOutputs() {
    var result = { outputs: [], current: selectedOutputId };
    // Fixed mapping by card description. aplay -l's free-form
    // strings ("HDMI", "DP0", "On-board Analog NAU8822", …) are
    // stable on this device tree, so a description match is
    // enough to route each card to its high-level identity.
    var cards = {};
    try {
        var out = execSync('aplay -l 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        var lines = out.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(/^card (\d+): (\S+) \[([^\]]+)\], device (\d+):/);
            if (m) cards[m[3]] = 'hw:' + m[1] + ',' + m[4];
        }
    } catch (e) {}
    if (cards['On-board Analog NAU8822']) {
        result.outputs.push({ id: 'speaker',   label: 'Speaker',   device: cards['On-board Analog NAU8822'] });
        result.outputs.push({ id: 'headphone', label: 'Headphone', device: cards['On-board Analog NAU8822'] });
    }
    if (cards['HDMI']) result.outputs.push({ id: 'hdmi', label: 'HDMI', device: cards['HDMI'] });
    if (cards['DP0'])  result.outputs.push({ id: 'dp',   label: 'DisplayPort', device: cards['DP0'] });

    // Lazy default. Until the user picks something explicitly,
    // selectedAlsaDevice is null — which makes mpg123 fall
    // through to ALSA's `default` device. On this build that's
    // Loopback (card 0), which has no physical output, so the
    // first /api/radio/play silently writes into a virtual sink.
    // Apply the current selectedOutputId here so the picker's
    // displayed value and the actual codec routing line up
    // before the user touches anything.
    if (!selectedAlsaDevice && result.outputs.length) {
        var def = null;
        for (var i = 0; i < result.outputs.length; i++) {
            if (result.outputs[i].id === selectedOutputId) {
                def = result.outputs[i]; break;
            }
        }
        if (!def) def = result.outputs[0];
        // Direct apply — must NOT call setSoundOutput here
        // because that re-enters getSoundOutputs() and the
        // HTTP request never completes (infinite recursion).
        _applyOutputState(def);
        result.current = def.id;
    }
    return result;
}

// Apply an output's device + codec mixer state without re-
// querying the output list. Split out from setSoundOutput so
// getSoundOutputs() can use it during lazy default-init
// without recursing back through setSoundOutput → getSoundOutputs.
//
// Codec mixer is only meaningful when the chosen card is the
// NAU8822: for HDMI / DP playback the mute state can't reach
// those cards. For Speaker / Headphone we toggle the simple-
// mixer playback switches that gate the DAC routes (`Speaker`
// and `Headphone` simple-control names — joined stereo
// p-switches over the per-channel Playback Switch numids the
// codec exposes). The mono `Headphones` amp-enable switch is
// set to on in both cases so headphone audio is never blocked
// by a stale amp-disable from a prior path.
function _applyOutputState(match) {
    selectedAlsaDevice = match.device;
    selectedOutputId   = match.id;
    var card = getNau8822Card();
    if (card && (match.id === 'speaker' || match.id === 'headphone')) {
        var spkOn = (match.id === 'speaker')   ? 'on' : 'off';
        var hpOn  = (match.id === 'headphone') ? 'on' : 'off';
        var cmds = [
            "amixer -c " + card + " set Speaker "    + spkOn,
            "amixer -c " + card + " set Headphone "  + hpOn,
            "amixer -c " + card + " set Headphones on"
        ];
        for (var ci = 0; ci < cmds.length; ci++) {
            try { execSync(cmds[ci] + ' 2>/dev/null', { timeout: 2000 }); }
            catch (e) { /* tolerate per-control failures */ }
        }
    }
}

function setSoundOutput(id) {
    var outs = getSoundOutputs().outputs;
    var match = null;
    for (var i = 0; i < outs.length; i++) if (outs[i].id === id) match = outs[i];
    if (!match) return { success: false, error: 'Unknown output' };
    _applyOutputState(match);
    return { success: true, id: id, device: match.device };
}

function setVolume(control, pct) {
    var card = getNau8822Card();
    if (!card) return { success: false, error: 'NAU8822 not found' };
    if (control !== 'Speaker' && control !== 'Headphone') return { success: false, error: 'Invalid control' };
    pct = Math.max(0, Math.min(100, parseInt(pct, 10)));
    try {
        // Chain `mute` / `unmute` onto the same amixer call so
        // 0 % genuinely silences the channel (some codec builds
        // still leak a small audible signal at 0 % volume), and
        // anything > 0 actively un-mutes — handles the case
        // where the user nudged volume up after a previous 0 %
        // muted the channel without dragging the unmute state
        // along for the ride.
        var muteArg = (pct === 0) ? 'mute' : 'unmute';
        execSync('amixer -c ' + card + ' set ' + control + ' '
                 + pct + '% ' + muteArg + ' 2>/dev/null',
                 { encoding: 'utf8', timeout: 2000 });
        return { success: true, volume: pct, muted: pct === 0 };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function restartAudioDriver() {
    try {
        var out = execSync(DRIVER_SCRIPT + ' 2>&1', { encoding: 'utf8', timeout: 15000 });
        return { success: true, output: out };
    } catch (e) {
        var output = (e.stdout || '') + (e.stderr || '');
        return { success: false, output: output || e.message };
    }
}

function readJsonBody(req, callback) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
        try { callback(null, JSON.parse(body)); }
        catch (e) { callback(e, null); }
    });
}

function serveStatic(req, res) {
    var urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    // Prevent directory traversal
    var filePath = path.join(BASE, path.normalize(urlPath));
    if (filePath.indexOf(BASE) !== 0) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    var ext = path.extname(filePath);
    var mime = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, function(err, data) {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
}

// Wi-Fi connection info.
//
// Previously parsed `nmcli dev wifi` (the scan list) and relied on the
// IN-USE `*` marker. That list is unstable — background rescans, roaming,
// and cache refreshes briefly drop the `*` row, which looked like
// disconnections in the UI.
//
// New approach: query the active connection state directly. `nmcli c show
// --active` reflects NetworkManager's state machine, not the scan list,
// so it doesn't flap during rescans. If an 802-11-wireless connection is
// activated, we're connected; then fetch signal via `iw dev link` which
// reads kernel-side link state (also not tied to scan cache).
var wifiCache = { connected: false, quality: 0, ssid: '', iface: '', ip4: [], ip6: [] };

async function refreshWifi() {
    var result = { connected: false, quality: 0, ssid: '', iface: '', ip4: [], ip6: [] };
    var actRes = await tryExec('nmcli -t -f NAME,TYPE,STATE c show --active',
        { encoding: 'utf8', timeout: 2000 });
    if (!actRes) { wifiCache = result; return; }

    var wifiName = null;
    var lines = actRes.stdout.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var parts = line
            .replace(/\\:/g, '\x01')
            .split(':')
            .map(function(p) { return p.replace(/\x01/g, ':'); });
        if (parts[1] === '802-11-wireless' && parts[2] === 'activated') {
            wifiName = parts[0] || '';
            break;
        }
    }
    if (!wifiName) { wifiCache = result; return; }

    var ssid = wifiName;
    var quality = 0;
    var iface = null;
    var ip4 = [];
    var ip6 = [];

    var devRes = await tryExec(
        'nmcli -t -f GENERAL.DEVICE,GENERAL.TYPE,GENERAL.CONNECTION d show',
        { encoding: 'utf8', timeout: 2000 });
    if (devRes) {
        var blocks = devRes.stdout.split(/\n(?=GENERAL\.DEVICE:)/);
        var escName = wifiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (var b = 0; b < blocks.length; b++) {
            if (/GENERAL\.TYPE:wifi/.test(blocks[b]) &&
                new RegExp('GENERAL\\.CONNECTION:' + escName).test(blocks[b])) {
                var m = blocks[b].match(/GENERAL\.DEVICE:([^\n]+)/);
                if (m) iface = m[1];
                break;
            }
        }
        if (iface) {
            var linkRes = await tryExec('iw dev ' + iface + ' link',
                { encoding: 'utf8', timeout: 1500 });
            if (linkRes) {
                var link = linkRes.stdout;
                var ssidM = link.match(/SSID:\s*(.+)/);
                if (ssidM) ssid = ssidM[1].trim();
                var sigM = link.match(/signal:\s*(-?\d+)\s*dBm/);
                if (sigM) {
                    var dbm = parseInt(sigM[1], 10);
                    quality = Math.max(0, Math.min(100, 2 * (dbm + 100)));
                }
            }
        }
    }

    if (iface) {
        var ipRes = await tryExec('nmcli -t device show ' + iface + ' 2>/dev/null',
            { encoding: 'utf8', timeout: 2000 });
        if (ipRes) {
            var ipLines = ipRes.stdout.split('\n');
            for (var li = 0; li < ipLines.length; li++) {
                var lp = ipLines[li].split(':');
                var key = lp[0];
                var val = lp.slice(1).join(':');
                if (key.match(/^IP4\.ADDRESS/))      ip4.push(val);
                else if (key.match(/^IP6\.ADDRESS/)) ip6.push(val);
            }
        }
    }

    if (quality === 0) {
        var scanRes = await tryExec('nmcli -t -f IN-USE,SSID,SIGNAL dev wifi',
            { encoding: 'utf8', timeout: 2000 });
        if (scanRes) {
            var sl = scanRes.stdout.split('\n');
            for (var j = 0; j < sl.length; j++) {
                if (!sl[j] || sl[j][0] !== '*') continue;
                var sp = sl[j].replace(/\\:/g, '\x01').split(':').map(
                    function(p) { return p.replace(/\x01/g, ':'); });
                var s = parseInt(sp[2], 10);
                if (!isNaN(s)) quality = Math.max(0, Math.min(100, s));
                if (sp[1]) ssid = sp[1];
                break;
            }
        }
    }

    wifiCache = {
        connected: true,
        quality: quality,
        ssid: ssid,
        iface: iface || '',
        ip4: ip4,
        ip6: ip6
    };
}

// ── /api/wifi/scan ──────────────────────────────────────────────
// Visible-networks list. `nmcli device wifi list` returns whatever
// scan results NetworkManager already has cached; we don't trigger
// a fresh `nmcli dev wifi rescan` here because that takes ~2-3 s
// and the polling cadence is enough to keep the list reasonably
// fresh on its own. Output is parsed into a deduplicated list of
// { ssid, signal (0-100), security } objects, sorted by signal.
// Hidden networks (empty SSID) and duplicate SSIDs (multiple BSSIDs
// for the same network) are collapsed.
// `ready` flips to true after the FIRST successful refresh that
// either has results OR follows a completed nmcli rescan.
// Subsequent failures keep the most recent successful list intact
// — the client distinguishes "scan in progress" (ready=false) from
// "scan finished, nothing visible" (ready=true, networks=[]) and
// shows a spinner only in the former case.
var wifiScanCache = { ready: false, networks: [] };

// Per-profile size cache for the Boot Menu Edit popup. `btrfs filesystem du`
// is a ~2-4s tree walk (no quotas), so results are memoised per subvol name.
var profileSizeCache = {};
var PROFILE_SIZE_TTL = 60000;

// Subvolume id of a profile by exact name, parsed from list-profiles (same
// positional columns as /api/boot/profiles). Empty string if not found.
function profileSubvolId(name, cb) {
    exec('sudo list-profiles', { encoding: 'utf8', timeout: 20000 }, function(err, stdout) {
        if (err) { cb(err, ''); return; }
        var id = '';
        (stdout || '').split('\n').forEach(function(raw) {
            var t = raw.trim();
            if (!t || /^NAME\b/.test(t)) return;
            var cols = t.split(/\s{2,}/);
            var base = /^<-\s*booted$/.test(cols[1] || '') ? 2 : 1;
            if (cols[0] === name) id = cols[base + 1] || '';
        });
        cb(null, id);
    });
}

// Reap <booted>_old_<ts> backups left when the booted profile was factory-reset:
// --no-keep cannot drop the live root, so create-profile keeps the moved-aside
// copy and we soft-reboot; once we are running the fresh root (this startup) the
// copy is dead weight. Only the booted profile's own _old_<timestamp> copies are
// removed, so unrelated profiles and manual backups are left alone.
function reapOldBackups() {
    exec('findmnt -no FSROOT /', { encoding: 'utf8', timeout: 3000 }, function(e, fsroot) {
        var booted = String(fsroot || '').trim().replace(/^\//, '');
        if (!/^@[A-Za-z0-9_-]+$/.test(booted)) return;
        var oldRe = new RegExp('^' + booted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                               '_old_\\d{4}-\\d\\d-\\d\\d_\\d\\d-\\d\\d-\\d\\d(_\\d+)?$');
        exec('sudo list-profiles', { encoding: 'utf8', timeout: 20000 }, function(err, stdout) {
            if (err) return;
            (stdout || '').split('\n').forEach(function(raw) {
                var t = raw.trim();
                if (!t || /^NAME\b/.test(t)) return;
                var nm = t.split(/\s{2,}/)[0];
                if (!oldRe.test(nm)) return;
                exec('sudo delete-profile -y ' + nm, { timeout: 60000 }, function(de) {
                    if (!de) console.log('[reap] removed leftover backup ' + nm);
                });
            });
        });
    });
}

// DTBO overlays applied to a profile, read from its BLS entry's
// devicetree-overlay line (/boot/loader/entries is shared, so every profile's
// entry is readable here). Split system (kernel dir) vs user (/etc/kernel/dtbo
// drop-ins) by path. Returns { system: [names], user: [names] }.
function readProfileDtbo(name) {
    var dir = '/boot/loader/entries', out = { system: [], user: [] };
    var files;
    try { files = fs.readdirSync(dir); } catch (e) { return out; }
    var esc = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    var reSub = new RegExp('rootflags=subvol=' + esc + '(?:\\s|$)', 'm');
    var chosen = null;
    files.filter(function(f) { return /\.conf$/.test(f); }).sort().forEach(function(f) {
        var txt;
        try { txt = fs.readFileSync(dir + '/' + f, 'utf8'); } catch (e) { return; }
        var opt = txt.match(/^options\s+.*/m);
        if (opt && reSub.test(opt[0])) chosen = txt;   // sorted asc → last match is newest kernel
    });
    if (!chosen) return out;
    var ov = chosen.match(/^devicetree-overlay\s+(.*)$/m);
    if (!ov) return out;
    ov[1].trim().split(/\s+/).forEach(function(p) {
        if (!p) return;
        var base = p.split('/').pop();
        if (p.indexOf('/etc/kernel/dtbo/') >= 0) out.user.push(base);
        else out.system.push(base);
    });
    return out;
}
// Timestamp of the first successful `nmcli dev wifi rescan`. Until
// it's set we treat an empty list as "scan still in progress" and
// hold `ready` at false — otherwise the client would prematurely
// flip from spinner to "No networks" while NetworkManager is
// still warming up its scan cache.
var wifiRescanCompletedAt = 0;
// Server start time, used for a hard fallback: even if every
// rescan fails (e.g. no wifi adapter), we don't keep the spinner
// on forever — after this grace period an empty list is accepted
// as the genuine state.
var wifiScanStartedAt = Date.now();
var WIFI_SCAN_GRACE_MS = 30000;

async function triggerWifiRescan() {
    // Fire-and-await the rescan; nmcli blocks until the kernel-
    // initiated scan returns or times out. A 6 s ceiling protects
    // against driver hangs without forcing the loop to wait too
    // long between attempts.
    var r = await tryExec('nmcli dev wifi rescan',
        { encoding: 'utf8', timeout: 6000 });
    if (r && wifiRescanCompletedAt === 0) {
        wifiRescanCompletedAt = Date.now();
    }
}

async function refreshWifiScan() {
    var r = await tryExec(
        'nmcli -t -f SSID,SIGNAL,SECURITY device wifi list',
        { encoding: 'utf8', timeout: 3000 });
    // On failure, keep the previous cache as-is — clients keep
    // showing the most recent results rather than reverting to
    // "loading" mid-session.
    if (!r) return;
    var lines = r.stdout.split('\n');
    var byName = {};
    var nets = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        // nmcli escapes ':' inside fields as '\:' — temporarily
        // substitute to a sentinel byte so split(':') doesn't
        // shred SSIDs containing colons, then restore.
        var parts = line.replace(/\\:/g, '\x01').split(':').map(
            function(p) { return p.replace(/\x01/g, ':'); });
        var ssid     = parts[0];
        var signal   = parseInt(parts[1], 10);
        var security = parts[2] || '';
        if (!ssid) continue;
        if (isNaN(signal)) signal = 0;
        if (byName[ssid] !== undefined) {
            // Same SSID seen on a stronger BSSID — promote it.
            if (signal > byName[ssid].signal) {
                byName[ssid].signal   = signal;
                byName[ssid].security = security;
            }
            continue;
        }
        var net = { ssid: ssid, signal: signal, security: security };
        byName[ssid] = net;
        nets.push(net);
    }
    nets.sort(function(a, b) { return b.signal - a.signal; });
    // Gate the `ready` flag so the client doesn't prematurely flip
    // from spinner to "No networks":
    //   - Empty list + no rescan completed yet + still in startup
    //     grace window → keep ready=false (spinner stays).
    //   - Otherwise (non-empty, OR a rescan finished, OR grace
    //     window elapsed) → ready=true.
    var inGrace = (Date.now() - wifiScanStartedAt) < WIFI_SCAN_GRACE_MS;
    var rescanDone = wifiRescanCompletedAt !== 0;
    if (nets.length === 0 && !rescanDone && inGrace) return;
    wifiScanCache = { ready: true, networks: nets };
}

// ── /api/wifi/power ─────────────────────────────────────────────
// Wi-Fi radio on/off, mirroring `nmcli radio wifi` state. POST to
// `/api/wifi/power` with `{ enabled: true|false }` to flip it.
// Optimistically writes the cache before the nmcli call returns
// so the client can poll back the new state immediately; the
// 3-second refresh loop reconciles if the actual state differs.
var wifiPowerCache = { enabled: true };

async function refreshWifiPower() {
    var r = await tryExec('nmcli -t -f WIFI radio',
        { encoding: 'utf8', timeout: 2000 });
    if (!r) return;   // keep last value on failure
    var line = r.stdout.split('\n').find(function(l) { return l; }) || '';
    wifiPowerCache = { enabled: line.trim() === 'enabled' };
}

function setWifiPower(enabled, cb) {
    exec('nmcli radio wifi ' + (enabled ? 'on' : 'off'),
        { encoding: 'utf8', timeout: 3000 },
        function(err) {
            if (err) cb({ ok: false, error: String(err.message || err) });
            else cb({ ok: true });
        });
}

var airplaneCache = { enabled: false };

async function refreshAirplane() {
    var r = await tryExec('nmcli -t -f WIFI,WWAN radio', { encoding: 'utf8', timeout: 2000 });
    if (!r) { airplaneCache = { enabled: false }; return; }
    var line = r.stdout.split('\n').find(function(l) { return l; }) || '';
    var parts = line.split(':');
    var wifi = parts[0] || '';
    var wwan = parts[1] || '';
    airplaneCache = { enabled: wifi === 'disabled' && wwan === 'disabled' };
}

function setAirplaneMode(enabled, cb) {
    exec('nmcli radio all ' + (enabled ? 'off' : 'on'),
        { encoding: 'utf8', timeout: 3000 },
        function(err) {
            if (err) cb({ ok: false, error: String(err.message || err) });
            else cb({ ok: true });
        });
}

var server = http.createServer(function(req, res) {
    // ── Browser mirror relay (Server-Sent Events; no device polling) ──
    // The device holds one SSE stream; the server pushes watch-state and
    // forwarded presses down it, so the device issues no requests while idle.
    if (req.url === '/api/mirror-events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('retry: 3000\n\n');
        res.write('event: watch\ndata: ' + JSON.stringify({ watching: mirrorWatching }) + '\n\n');
        mirrorSSE.push(res);
        req.on('close', function() {
            var i = mirrorSSE.indexOf(res);
            if (i >= 0) mirrorSSE.splice(i, 1);
        });
        return;
    }
    // Device posts its screen (base64 PNG body).
    if (req.url === '/api/screen' && req.method === 'POST') {
        var sChunks = [];
        req.on('data', function(c) { sChunks.push(c); });
        req.on('end', function() {
            try { mirrorFrame = Buffer.from(Buffer.concat(sChunks).toString('utf8'), 'base64'); } catch (e) {}
            res.writeHead(204); res.end();
        });
        return;
    }
    // Viewer fetches the frame; the fetch marks a viewer present, which
    // pushes watch:true to the device so it starts streaming.
    if (req.url === '/api/screen' && req.method === 'GET') {
        mirrorViewerAt = Date.now();
        mirrorSetWatching(true);
        if (!mirrorFrame) { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(mirrorFrame);
        return;
    }
    // Viewer posts a press; push it straight to the device stream.
    if (req.url === '/api/mirror-input' && req.method === 'POST') {
        readJsonBody(req, function(err, d) {
            if (d && d.action) mirrorBroadcast('input', { action: String(d.action), down: !!d.down });
            res.writeHead(204); res.end();
        });
        return;
    }
    // Booted btrfs profile (the root subvolume), read cheaply from the
    // mount table — e.g. "/@Minimal" -> "@Minimal". Home screen shows it.
    if (req.url === '/api/profile/current' && req.method === 'GET') {
        var bootedProfile = '';
        try {
            bootedProfile = execSync('findmnt -no FSROOT /', { encoding: 'utf8', timeout: 3000 })
                .trim().replace(/^\/+/, '');
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile: bootedProfile }));
        return;
    }
    // ── UI PNG viewer ────────────────────────────────────────────
    // List + serve the PNGs / MP4s dropped in /media/ui_png for the
    // Testing "UI PNG viewer" app.
    if (req.url === '/api/ui-png' && req.method === 'GET') {
        var pngFiles = [];
        try {
            pngFiles = fs.readdirSync(UI_PNG_DIR)
                .filter(function(n) { return /\.(png|mp4)$/i.test(n); })
                .sort();
        } catch (e) { /* dir missing → empty list */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: pngFiles }));
        return;
    }
    // Frame-sheet meta for one MP4, building the sheet on first use
    // (ffprobe + ffmpeg, so the first hit takes a few seconds — the
    // client shows its spinner). { ok:false } → client falls back to
    // the <video> element.
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/ui-png/frames') {
        var framesName = uiPngFramesName(req.url);
        if (!framesName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Bad name' }));
            return;
        }
        uiPngFramesEnsure(framesName, function(meta) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(meta));
        });
        return;
    }
    // The sheet PNG itself (meta must have been built OK).
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/ui-png/frames-sheet') {
        var sheetName = uiPngFramesName(req.url);
        if (!sheetName) { res.writeHead(400); res.end('Bad name'); return; }
        uiPngFramesEnsure(sheetName, function(meta) {
            if (!meta.ok) { res.writeHead(404); res.end('No sheet'); return; }
            var sheetFile = FRAMES_DIR + '/' + sheetName + '.sheet.png';
            fs.stat(sheetFile, function(errSt, stSt) {
                if (errSt || !stSt.isFile()) {
                    res.writeHead(404); res.end('No sheet'); return;
                }
                res.writeHead(200, {
                    'Content-Type':   'image/png',
                    'Content-Length': stSt.size
                });
                fs.createReadStream(sheetFile).pipe(res);
            });
        });
        return;
    }
    if (req.method === 'GET' && req.url.split('?')[0].indexOf('/media/ui_png/') === 0) {
        // Serve one file by basename only — the regex forbids any
        // slash, so no path traversal reaches the fs. Supports HTTP
        // Range (206) — <video> needs it to seek back to 0, which
        // is exactly what loop playback does at every wrap.
        var pngName = decodeURIComponent(req.url.split('?')[0].slice('/media/ui_png/'.length));
        if (!/^[^/]+\.(png|mp4)$/i.test(pngName)) { res.writeHead(400); res.end('Bad name'); return; }
        var pngMime = /\.mp4$/i.test(pngName) ? 'video/mp4' : 'image/png';
        var pngPath = UI_PNG_DIR + '/' + pngName;
        fs.stat(pngPath, function(err, st) {
            if (err || !st.isFile()) { res.writeHead(404); res.end('Not found'); return; }
            var range = req.headers.range;
            var m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m && (m[1] !== '' || m[2] !== '')) {
                var start = m[1] === '' ? Math.max(0, st.size - parseInt(m[2], 10))
                                        : parseInt(m[1], 10);
                var end   = (m[1] !== '' && m[2] !== '') ? parseInt(m[2], 10)
                                                         : st.size - 1;
                if (end > st.size - 1) end = st.size - 1;
                if (start > end || start >= st.size) {
                    res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
                    res.end();
                    return;
                }
                res.writeHead(206, {
                    'Content-Type':   pngMime,
                    'Content-Range':  'bytes ' + start + '-' + end + '/' + st.size,
                    'Content-Length': end - start + 1,
                    'Accept-Ranges':  'bytes'
                });
                fs.createReadStream(pngPath, { start: start, end: end }).pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Type':   pngMime,
                    'Content-Length': st.size,
                    'Accept-Ranges':  'bytes'
                });
                fs.createReadStream(pngPath).pipe(res);
            }
        });
        return;
    }
    // Rename one PNG / MP4. Body { from, to } — both basenames
    // ("to" may omit the extension; the source's is appended).
    // Refuses to clobber an existing file.
    if (req.url === '/api/ui-png/rename' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var from = data && data.from, to = data && data.to;
            var bad  = function(msg) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: msg }));
            };
            if (err || typeof from !== 'string' || typeof to !== 'string') {
                return bad('Invalid request');
            }
            var extM = from.match(/\.(png|mp4)$/i);
            var ext  = extM ? extM[0].toLowerCase() : '.png';
            if (!/\.(png|mp4)$/i.test(to)) to += ext;
            if (!/^[^/]+\.(png|mp4)$/i.test(from) || !/^[^/]+\.(png|mp4)$/i.test(to)
                    || from.indexOf('..') !== -1 || to.indexOf('..') !== -1) {
                return bad('Bad name');
            }
            var src = UI_PNG_DIR + '/' + from, dst = UI_PNG_DIR + '/' + to;
            if (from !== to && fs.existsSync(dst)) return bad('Name already exists');
            try { fs.renameSync(src, dst); }
            catch (e) { return bad(String((e && e.message) || e)); }
            uiPngFramesEvict(from);   // sheet cache is keyed by name
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: to }));
        });
        return;
    }
    // Delete one PNG / MP4. Body { name } — basename only.
    if (req.url === '/api/ui-png/delete' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var name = data && data.name;
            if (err || typeof name !== 'string' || !/^[^/]+\.(png|mp4)$/i.test(name)
                    || name.indexOf('..') !== -1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Bad name' }));
                return;
            }
            try { fs.unlinkSync(UI_PNG_DIR + '/' + name); }
            catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
                return;
            }
            uiPngFramesEvict(name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }
    if (req.url === '/api/wifi') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wifiCache));
        return;
    }
    if (req.url === '/api/wifi/scan') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wifiScanCache));
        return;
    }
    if (req.url === '/api/wifi/power' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wifiPowerCache));
        return;
    }
    if (req.url === '/api/wifi/power' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
                return;
            }
            var enabled = !!(data && data.enabled);
            // Optimistic write so the next GET reflects the
            // request immediately even before nmcli returns; the
            // 3-second refresh loop reconciles if the actual
            // radio state differs.
            wifiPowerCache = { enabled: enabled };
            setWifiPower(enabled, function(result) {
                refreshWifiPower();
                res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(Object.assign({ enabled: enabled }, result)));
            });
        });
        return;
    }
    if (req.url === '/api/wifi/disconnect' && req.method === 'POST') {
        // Disconnect from a Wi-Fi network without deleting the
        // saved profile. Body: { name }. Maps to
        // `nmcli connection down <name>`. Profile sticks around
        // for a future reconnect; only the active link drops.
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Missing name' }));
                return;
            }
            var nameQ = JSON.stringify(String(data.name));
            exec('nmcli connection down ' + nameQ,
                { encoding: 'utf8', timeout: 10000 },
                function(execErr, stdout, stderr) {
                    if (execErr) {
                        var msg = String(stderr || execErr.message || execErr).trim();
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: msg }));
                        return;
                    }
                    refreshWifi();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                });
        });
        return;
    }
    if (req.url === '/api/wifi/connect' && req.method === 'POST') {
        // Join a Wi-Fi network. Body: { ssid, password }.
        // Password may be empty for open networks. Internally we
        // call `nmcli device wifi connect <ssid> [password <pwd>]`,
        // which CREATES a connection profile if none exists for
        // that SSID and brings the link up. On success, refresh
        // the wifi/scan caches so the next client poll already
        // reflects the new state without a 2 s lag.
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.ssid) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Missing ssid' }));
                return;
            }
            var ssid = String(data.ssid);
            var pwd  = String(data.password || '');
            var ssidQ = JSON.stringify(ssid);
            // Build the nmcli invocation. Quoting via
            // JSON.stringify gets us proper shell-safe escaping
            // for SSIDs / passphrases that contain spaces or
            // shell-special characters.
            var cmd = 'nmcli device wifi connect ' + ssidQ;
            if (pwd) cmd += ' password ' + JSON.stringify(pwd);
            // Flip the wifi LED to "breathing blue" while the
            // connect runs. Cleared in every exit path so a
            // failed / timed-out attempt doesn't leave the LED
            // pulsing forever.
            ledWifiConnecting = true;
            applyLedsFromState();
            exec(cmd,
                { encoding: 'utf8', timeout: 30000 },
                function(execErr, stdout, stderr) {
                    ledWifiConnecting = false;
                    if (execErr) {
                        // nmcli writes the user-facing reason to
                        // stderr ("Secrets were required, but not
                        // provided", "No network with SSID '…'
                        // found", etc.). Pass it through verbatim
                        // so the client can surface it.
                        var msg = String(stderr || execErr.message || execErr).trim();
                        applyLedsFromState();
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: msg }));
                        return;
                    }
                    refreshWifi().then(function() { applyLedsFromState(); });
                    refreshWifiScan();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, output: String(stdout || '').trim() }));
                });
        });
        return;
    }
    if (req.url === '/api/wifi/forget' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Missing name' }));
                return;
            }
            // Quote the connection name so SSIDs containing spaces
            // / colons survive the shell. JSON.stringify gives us
            // a properly-escaped double-quoted form.
            var nameQ = JSON.stringify(String(data.name));
            exec('nmcli connection delete ' + nameQ,
                { encoding: 'utf8', timeout: 5000 },
                function(execErr) {
                    if (execErr) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: false,
                            error: String(execErr.message || execErr)
                        }));
                    } else {
                        // Refresh the wifi caches so the active
                        // connection / scan list update on the
                        // next GET.
                        refreshWifi();
                        refreshWifiScan();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    }
                });
        });
        return;
    }
    if (req.url.indexOf('/api/wifi/connection') === 0 && req.method === 'GET') {
        // Read full settings for a Wi-Fi profile. Two modes:
        //   • No `name=` param → return the currently-active
        //     connection (back-compat with the old contract).
        //   • `name=<encoded>` → return THAT specific saved
        //     profile, regardless of whether it's active. Lets a
        //     single client component render verbose detail for
        //     both the live network and any saved one.
        // `secrets=1` adds the WPA passphrase via
        // `nmcli --show-secrets`. Server runs as root so the
        // lookup just works.
        var qs = req.url.indexOf('?') >= 0 ? req.url.substring(req.url.indexOf('?') + 1) : '';
        var withSecrets = qs.indexOf('secrets=1') >= 0;
        // Tiny query-string parser — pulls `name=<value>` out of
        // the qs (URL-decoded). Other params untouched.
        var qName = '';
        var pairs = qs.split('&');
        for (var qi = 0; qi < pairs.length; qi++) {
            var eq = pairs[qi].indexOf('=');
            if (eq < 0) continue;
            var k = pairs[qi].substring(0, eq);
            var v = pairs[qi].substring(eq + 1);
            if (k === 'name') {
                try { qName = decodeURIComponent(v.replace(/\+/g, ' ')); }
                catch (e) { qName = v; }
            }
        }
        var connName = qName || wifiCache.ssid;
        if (!connName) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ connected: false }));
            return;
        }
        var nameQ = JSON.stringify(String(connName));
        var cmd = 'nmcli ' + (withSecrets ? '--show-secrets ' : '')
            + '-t connection show ' + nameQ;
        exec(cmd, { encoding: 'utf8', timeout: 3000 }, function(execErr, stdout) {
            if (execErr) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: String(execErr.message || execErr) }));
                return;
            }
            // Parse field-per-line output. Same colon-escape
            // trick the other nmcli parsers use.
            var fields = {};
            var lines = stdout.split('\n');
            for (var i = 0; i < lines.length; i++) {
                var ln = lines[i];
                if (!ln) continue;
                var idx = ln.indexOf(':');
                if (idx < 0) continue;
                var k = ln.substring(0, idx);
                var v = ln.substring(idx + 1).replace(/\\:/g, ':');
                fields[k] = v;
            }
            function pickAddrs(prefix) {
                var addrs = [];
                for (var key in fields) {
                    if (key.indexOf(prefix) === 0) addrs.push(fields[key]);
                }
                return addrs;
            }
            var details = {
                connected: true,
                ssid:        connName,
                autoconnect: (fields['connection.autoconnect'] || '').toLowerCase() === 'yes',
                ipv4: {
                    method:    fields['ipv4.method']    || '',
                    gateway:   fields['ipv4.gateway']   || '',
                    dns:       fields['ipv4.dns']       || '',
                    addresses: pickAddrs('IP4.ADDRESS')
                },
                ipv6: {
                    method:    fields['ipv6.method']    || '',
                    gateway:   fields['ipv6.gateway']   || '',
                    dns:       fields['ipv6.dns']       || '',
                    addresses: pickAddrs('IP6.ADDRESS')
                }
            };
            if (withSecrets && fields['802-11-wireless-security.psk']) {
                details.password = fields['802-11-wireless-security.psk'];
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(details));
        });
        return;
    }
    if (req.url === '/api/wifi/saved' && req.method === 'GET') {
        // Return every saved Wi-Fi connection profile NetworkManager
        // knows about — i.e. networks the device has ever connected
        // to. Each entry: { name, ssid, security, autoconnect,
        // lastConnected }.
        //
        // First pass: list all 802-11-wireless connections via the
        // terse `nmcli -t -f NAME,TYPE connection show` form.
        // Second pass: per-profile `connection show <name>` to pull
        // the richer fields. We do these sequentially in a small
        // loop rather than firing N parallel nmcli calls — saved
        // networks tend to be a handful, and serial keeps load low.
        exec('nmcli -t -f NAME,TYPE connection show',
             { encoding: 'utf8', timeout: 4000 },
             function(listErr, listOut) {
            if (listErr) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ networks: [] }));
                return;
            }
            var lines = (listOut || '').split('\n');
            var names = [];
            for (var li = 0; li < lines.length; li++) {
                var ln = lines[li];
                if (!ln) continue;
                // Terse output is `NAME:TYPE`. NAME may itself
                // contain literal colons escaped as `\:`. Walk
                // back from the trailing TYPE field using the
                // last unescaped `:`.
                var idx = -1;
                for (var ci = ln.length - 1; ci >= 0; ci--) {
                    if (ln.charAt(ci) === ':' && (ci === 0 || ln.charAt(ci - 1) !== '\\')) {
                        idx = ci; break;
                    }
                }
                if (idx < 0) continue;
                var nm = ln.substring(0, idx).replace(/\\:/g, ':');
                var tp = ln.substring(idx + 1);
                if (tp !== '802-11-wireless') continue;
                // Skip internal device-managed profiles. These
                // are connection entries the firmware creates
                // for its own networking (e.g. the Flipper One's
                // 2.4 GHz / 5 GHz router profiles created during
                // factory provisioning) — not user-saved
                // networks. Easy to extend with more patterns if
                // new internal naming conventions show up.
                if (/^wifi-router/i.test(nm)) continue;
                if (/^flipper-/i.test(nm))    continue;
                names.push(nm);
            }
            // Resolve detail fields one connection at a time. As
            // each resolves, decrement `pending`; when the last
            // one lands, write the response.
            var results = [];
            var pending = names.length;
            if (pending === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ networks: [] }));
                return;
            }
            names.forEach(function(name, i) {
                var quoted = JSON.stringify(String(name));
                exec('nmcli -t connection show ' + quoted,
                     { encoding: 'utf8', timeout: 3000 },
                     function(dErr, dOut) {
                    var fields = {};
                    if (!dErr && dOut) {
                        var dlines = dOut.split('\n');
                        for (var j = 0; j < dlines.length; j++) {
                            var dl = dlines[j];
                            if (!dl) continue;
                            var di = dl.indexOf(':');
                            if (di < 0) continue;
                            var k = dl.substring(0, di);
                            var v = dl.substring(di + 1).replace(/\\:/g, ':');
                            fields[k] = v;
                        }
                    }
                    var ts = parseInt(fields['connection.timestamp'] || '0', 10);
                    results[i] = {
                        name:          name,
                        ssid:          fields['802-11-wireless.ssid'] || name,
                        security:      fields['802-11-wireless-security.key-mgmt'] || '',
                        autoconnect:   (fields['connection.autoconnect'] || '').toLowerCase() === 'yes',
                        lastConnected: ts > 0 ? ts : null
                    };
                    if (--pending === 0) {
                        // Sort by last-connected descending so the
                        // most recently used profiles top the
                        // list. Nulls (never connected) sink to
                        // the bottom in name order.
                        results.sort(function(a, b) {
                            if (a.lastConnected && b.lastConnected) return b.lastConnected - a.lastConnected;
                            if (a.lastConnected) return -1;
                            if (b.lastConnected) return 1;
                            return a.name.localeCompare(b.name);
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ networks: results }));
                    }
                });
            });
        });
        return;
    }
    if (req.url === '/api/airplane' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(airplaneCache));
        return;
    }
    if (req.url === '/api/led/manual' && req.method === 'POST') {
        // Network-LED tuning takeover. When `enabled: true` the
        // periodic apply loop steps aside so direct /api/led/set
        // writes from the testing scene aren't trampled. When
        // `enabled: false` the auto state takes over again
        // immediately (fires applyLedsFromState() so the LEDs
        // snap back to their state-driven look without waiting
        // for the next tick).
        readJsonBody(req, function(err, data) {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
                return;
            }
            ledManualMode = !!(data && data.enabled);
            if (!ledManualMode) applyLedsFromState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, enabled: ledManualMode }));
        });
        return;
    }
    if (req.url === '/api/led/set' && req.method === 'POST') {
        // Direct LED control — used by the Network LEDs testing
        // scene. Body: { led: 'wifi'|'eth0'|'eth1'|'link',
        //                 r, g, b, on }.  RGB values clamped to
        // 0-255. When on=false the LED is turned off (brightness
        // 0) regardless of the colour values. Effective only in
        // manual mode (the auto-loop will overwrite otherwise).
        readJsonBody(req, function(err, data) {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
                return;
            }
            var ledMap = {
                'wifi': 'flipper-one:rgb:wifi',
                'eth0': 'flipper-one:rgb:eth0',
                'eth1': 'flipper-one:rgb:eth1',
                'link': 'flipper-one:rgb:link'
            };
            var sysled = ledMap[(data && data.led) || ''];
            if (!sysled) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Unknown LED' }));
                return;
            }
            function clamp(v) {
                v = parseInt(v, 10);
                if (isNaN(v)) v = 0;
                if (v < 0)   v = 0;
                if (v > 255) v = 255;
                return v;
            }
            var r  = clamp(data.r);
            var g  = clamp(data.g);
            var b  = clamp(data.b);
            var on = !!(data && data.on);
            if (on) {
                applyLedTarget(sysled, {
                    trigger:         'none',
                    multi_intensity: r + ' ' + g + ' ' + b,
                    brightness:      '255'
                });
            } else {
                ledOff(sysled);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, led: data.led, r: r, g: g, b: b, on: on }));
        });
        return;
    }
    if (req.url === '/api/led/link' && req.method === 'GET') {
        // Tiny status query so callers can confirm what they
        // last set without keeping their own bookkeeping.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ on: ledLinkOn, color: 'blue' }));
        return;
    }
    if (req.url === '/api/led/link' && req.method === 'POST') {
        // Hand-off endpoint for OTHER applications to control the
        // physical "Link" RGB LED. Body: `{ on: bool }`. Solid
        // blue at full brightness when on; off (brightness 0)
        // when off. Colour is hard-wired — callers don't pick.
        readJsonBody(req, function(err, data) {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
                return;
            }
            ledLinkOn = !!(data && data.on);
            applyLedsFromState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, on: ledLinkOn }));
        });
        return;
    }
    if (req.url === '/api/airplane' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
                return;
            }
            setAirplaneMode(!!(data && data.enabled), function(result) {
                // Optimistically refresh the cache so the next GET reflects
                // the new state without waiting for the 3 s background poll.
                refreshAirplane();
                res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(Object.assign({ enabled: !!(data && data.enabled) }, result)));
            });
        });
        return;
    }
    if (req.url === '/api/power') {
        var power = getPowerInfo();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(power));
        return;
    }
    if (req.url === '/api/battery/temp') {
        var bt = getBatteryTemp();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bt || { tempC: null }));
        return;
    }
    if (req.url === '/api/cpu/temp') {
        var ct = getCpuTemp();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ct || { tempC: null }));
        return;
    }
    if (req.url === '/api/power/usage') {
        var pu = getPowerUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pu || { watts: null }));
        return;
    }
    if (req.url === '/api/touchpad/xy') {
        // SSE messages are short (~15 B). With Nagle on the kernel
        // batches them up to ~40 ms — fatal for an interactive feed.
        req.socket.setNoDelay(true);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write('\n');
        touchpadClients.add(res);
        req.on('close', function() { touchpadClients.delete(res); });
        return;
    }
    if (req.url === '/api/modem') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(modemCache));
        return;
    }
    if (req.url === '/api/update/check') {
        var update = getUpdateStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(update));
        return;
    }
    if (req.url === '/api/update/apply' && req.method === 'POST') {
        var upResult = doUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(upResult));
        if (upResult.success) {
            // Restart the node service only. The client's /api/version watcher
            // will detect the new SERVER_ID and reload the page inside the
            // already-running cog — no cog restart needed. daemon-reload in
            // case the pull updated the .service file on disk.
            var spawn = require('child_process').spawn;
            spawn('systemd-run', ['--collect', '--no-block', 'sh', '-c',
                'systemctl daemon-reload' +
                ' && systemctl restart fake-flipctl-node-server.service'], {
                detached: true,
                stdio: 'ignore'
            }).unref();
        }
        return;
    }
    if (req.url === '/api/routing') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(routingCache));
        return;
    }
    if (req.url === '/api/ethernet') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ethernetCache));
        return;
    }
    if (req.url === '/api/disk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diskCache));
        return;
    }
    if (req.url === '/api/hdmi') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getHdmiStatus()));
        return;
    }
    // ── /api/cec/status ──────────────────────────────────────────
    // Reports whether the cec-ctl CLI (v4l-utils) needed to query the
    // TV over HDMI-CEC is installed, plus whether a CEC device node is
    // present. TV Media Box polls this on enter() and gates an install
    // modal behind a missing binary (mirrors /api/radio/status).
    if (req.url === '/api/cec/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getCecState()));
        return;
    }
    // ── /api/cec/enable ──────────────────────────────────────────
    // Configure the adapter as a CEC Playback device (claims a logical
    // address) — equivalent to `cec-ctl -d /dev/cec0 --playback`. Runs
    // as root, no sudo. Idempotent: re-running just re-claims. Returns
    // the resulting `enabled` so the client can confirm immediately.
    if (req.url === '/api/cec/enable' && req.method === 'POST') {
        var enOk = false, enOut = '';
        try {
            enOut = execSync('cec-ctl -d /dev/cec0 --playback 2>&1', { encoding: 'utf8', timeout: 5000 });
            enOk = true;
        } catch (e) {
            enOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: enOk, enabled: getCecState().enabled, output: enOut.slice(-500) }));
        return;
    }
    // ── /api/cec/start-tv ────────────────────────────────────────
    // Wake the TV and switch it to our input over CEC:
    //   1. --to 0 --image-view-on   (TV is logical address 0 by CEC
    //                                 standard; this powers it on)
    //   2. --active-source phys-addr=<our PA>   (TV switches to our
    //                                 HDMI input). Our physical address
    //                                 is read LIVE from the adapter, not
    //                                 hardcoded — it changes with the
    //                                 HDMI port we're plugged into.
    if (req.url === '/api/cec/start-tv' && req.method === 'POST') {
        var st = getCecState();
        if (!st.enabled) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'CEC not enabled' }));
            return;
        }
        var tvOk = false, tvOut = '';
        try {
            tvOut += execSync('cec-ctl -d /dev/cec0 --to 0 --image-view-on 2>&1',
                { encoding: 'utf8', timeout: 5000 });
            var pa = st.physicalAddress;
            if (pa && /^[0-9a-fA-F.]+$/.test(pa) && pa !== 'f.f.f.f') {
                tvOut += execSync('cec-ctl -d /dev/cec0 --active-source phys-addr=' + pa + ' 2>&1',
                    { encoding: 'utf8', timeout: 5000 });
            }
            tvOk = true;
        } catch (e) {
            tvOut += (e.stdout || '') + (e.stderr || '') + (e.message || '');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: tvOk, physicalAddress: st.physicalAddress, output: tvOut.slice(-500) }));
        return;
    }
    // ── /api/cec/tv-off ──────────────────────────────────────────
    // Put the TV into standby via CEC: --to 0 --standby (0x36).
    if (req.url === '/api/cec/tv-off' && req.method === 'POST') {
        var ost = getCecState();
        if (!ost.enabled) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'CEC not enabled' }));
            return;
        }
        var offOk = false, offOut = '';
        try {
            offOut = execSync('cec-ctl -d /dev/cec0 --to 0 --standby 2>&1',
                { encoding: 'utf8', timeout: 5000 });
            offOk = true;
        } catch (e) {
            offOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: offOk, output: offOut.slice(-500) }));
        return;
    }
    // ── /api/cec/tv-power ────────────────────────────────────────
    // Live TV power state over CEC: { power: 'on'|'standby'|'to-on'|
    // 'to-standby'|null }. Used to verify the TV woke after Start TV.
    if (req.url === '/api/cec/tv-power' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ power: getTvPower() }));
        return;
    }
    // ── /api/cec/active-source ───────────────────────────────────
    // Returns the TV's currently displayed source and our adapter's
    // physical address, plus a convenience boolean for whether we
    // are the active one. Used by the client to prompt the user
    // when the TV is showing something other than us.
    if (req.url === '/api/cec/active-source' && req.method === 'GET') {
        var asState = getCecState();
        var tvPa    = getActiveSource();
        var ourPa   = asState.physicalAddress;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            tvPhysicalAddress:  tvPa,
            ourPhysicalAddress: ourPa,
            isUs: !!(tvPa && ourPa && tvPa === ourPa)
        }));
        return;
    }
    // ── /api/cec/tv-present ──────────────────────────────────────
    // Cheap CEC bus ping → { present: bool }. ACK from logical
    // address 0 ⇒ TV is on the bus and supports CEC. Client polls
    // this during connect-time detection; once positive, support
    // is sticky for the HDMI session (no more probes needed).
    if (req.url === '/api/cec/tv-present' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ present: isTvPresent() }));
        return;
    }
    // ── /api/cec/install ─────────────────────────────────────────
    // Installs v4l-utils (provides cec-ctl) via apt-get. Same shape as
    // /api/radio/install: root server, noninteractive, lean, last 1000
    // chars of output returned so the client can surface failures.
    if (req.url === '/api/cec/install' && req.method === 'POST') {
        var pkgs = missingDeps();
        var cecOk = false;
        var cecOut = '';
        if (pkgs.length === 0) {
            cecOk = true;
            cecOut = 'already installed';
        } else {
            try {
                // All missing deps in a single apt-get transaction.
                cecOut = execSync(
                    'DEBIAN_FRONTEND=noninteractive apt-get install -y ' +
                    '--no-install-recommends ' + pkgs.join(' ') + ' 2>&1',
                    { encoding: 'utf8', timeout: 90000 });
                cecOk = true;
            } catch (e) {
                cecOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: cecOk, output: cecOut.slice(-1000) }));
        return;
    }
    // ── /api/tvmb/start ──────────────────────────────────────────
    // Spawn the binary for the requested preset (Kodi / weston / …)
    // and route its output to HDMI. Replaces any preset already
    // running. Returns { success, preset } on launch, or
    // { success: false, error } when the preset is unknown or the
    // spawn itself fails synchronously (e.g. /bin/sh missing).
    // A binary that's installed-but-missing-runtime-deps will spawn
    // OK here and die in the child; the exit handler clears state.
    if (req.url === '/api/tvmb/start' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var preset = data && data.preset;
            var result = startPreset(preset);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        });
        return;
    }
    // ── /api/tvmb/stop ───────────────────────────────────────────
    // SIGTERM whatever preset child we're currently tracking.
    // Idempotent — returns success even if nothing was running.
    if (req.url === '/api/tvmb/stop' && req.method === 'POST') {
        stopPreset();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }
    // ── /api/tvmb/kodi-send ──────────────────────────────────────
    // Body: { action }. Runs the EXACT shell command that works over
    // SSH — `kodi-send --action="<action>"` — via /bin/sh so PATH /
    // wrapper resolution matches the interactive shell. The action is
    // allowlisted (no ", $, `, \, ;, |, & …) and wrapped in double
    // quotes, so the parens stay literal and nothing can break out.
    if (req.url === '/api/tvmb/kodi-send' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var action = data && data.action;
            if (typeof action !== 'string' || !/^[A-Za-z0-9_.,():\- ]+$/.test(action)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid action' }));
                return;
            }
            var cmd = 'kodi-send --action="' + action + '"';
            exec(cmd, { timeout: 5000 }, function(e2, stdout, stderr) {
                if (e2) console.error('[kodi-send] failed:', e2.message,
                                      String(stderr || '').trim());
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }
    // ── /api/tvmb/status ─────────────────────────────────────────
    // { running, preset } — tells the client which preset (if any)
    // is currently spawned. Survives across HTTP requests because
    // the child handle lives in module scope.
    if (req.url === '/api/tvmb/status' && req.method === 'GET') {
        // kodiRunning is a *truthful* probe via `pgrep -a kodi`. The
        // tracked-child handle (tvmbPresetChild) misses Kodi instances
        // that get orphaned/reparented, so we ask the OS directly.
        // pgrep exits 0 when >=1 match, 1 when none (throws). The `-a`
        // only changes stdout formatting; we rely solely on exit code.
        var kodiRunning = false;
        try {
            execSync('pgrep -a kodi', { timeout: 2000 });
            kodiRunning = true;
        } catch (e) {
            kodiRunning = false;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            running:     !!tvmbPresetChild,
            preset:      tvmbPresetName,
            kodiRunning: kodiRunning
        }));
        return;
    }
    if (req.url === '/api/sound/files') {
        var soundFiles = getSoundFiles();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files: soundFiles }));
        return;
    }
    if (req.url === '/api/sound/play' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var playResult = playSoundFile(data.file);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(playResult));
        });
        return;
    }
    if (req.url === '/api/sound/stop' && req.method === 'POST') {
        stopSound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }
    if (req.url === '/api/record/list' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            files:      getRecordings(),
            folderPath: RECORDINGS_DIR
        }));
        return;
    }
    if (req.url === '/api/record/status' && req.method === 'GET') {
        var st = { recording: !!recordChild, paused: recordPaused };
        if (recordState) {
            st.file      = recordState.file;
            st.format    = recordState.format;
            st.elapsedMs = Date.now() - recordState.startedAt;
            // Live file size — drives the client-side "how many
            // bytes per second is THIS take actually writing" so
            // the time-left estimate reflects the real codec
            // bitrate (which can differ from the nominal: VBR
            // encoders dip in silence, WAV stays flat).
            try {
                var sz = fs.statSync(path.join(RECORDINGS_DIR, recordState.file));
                st.bytes = sz.size;
            } catch (e) { /* file gone — leave bytes undefined */ }
        }
        // Free bytes on the recordings filesystem. statfsSync is
        // Node 18.15+; we're on 20, so it's safe. Bytes here so
        // the client can do GB / MB formatting itself rather
        // than us baking a precision choice in.
        try {
            var sf = fs.statfsSync(RECORDINGS_DIR);
            st.freeBytes  = sf.bavail * sf.bsize;
            st.totalBytes = sf.blocks * sf.bsize;
        } catch (e) { /* leave undefined — client falls back */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(st));
        return;
    }
    if (req.url === '/api/record/start' && req.method === 'POST') {
        // Body is optional — bare POSTs default to WAV with the
        // legacy "rec-YYYYMMDD-HHMMSS" filename pattern.
        readJsonBody(req, function(err, data) {
            var fmt  = (data && data.format) ? String(data.format) : 'wav';
            var name = data && data.name ? String(data.name) : null;
            var startResult = startRecording(fmt, name);
            // 409 when the dependency is missing — the client
            // distinguishes that from a real 500 (codec gone /
            // sox missing) to know whether to pop the install
            // modal vs. surface a hard error.
            var status = 200;
            if (!startResult.success) {
                status = startResult.missingPackage ? 409 : 500;
            }
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(startResult));
        });
        return;
    }
    if (req.url === '/api/record/stop' && req.method === 'POST') {
        var stopResult = stopRecording();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stopResult));
        return;
    }
    // ── /api/record/pause ───────────────────────────────────────
    // Two pause paths depending on the recording format:
    //
    //   WAV  — sox keeps running; the stdout handler stops
    //          writing chunks to the file while recordPaused
    //          is true. The input-level meter (which reads
    //          peak from the same chunks) keeps updating, so
    //          the user sees the mic is still live while
    //          paused.
    //   MP3 / OGG — sox writes through a piped encoder, so
    //          dropping writes mid-stream isn't trivial.
    //          Fall back to SIGSTOPping both processes; the
    //          kernel pauses them, ALSA capture overflows and
    //          drops samples, so the pause-window audio
    //          doesn't end up in the file. The meter freezes
    //          in this mode (no chunks flowing).
    if (req.url === '/api/record/pause' && req.method === 'POST') {
        if (!recordChild) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not recording' }));
            return;
        }
        if (recordPaused) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, paused: true, already: true }));
            return;
        }
        var pauseFmt = recordState && recordState.format;
        if (pauseFmt !== 'wav') {
            try { recordChild.kill('SIGSTOP'); } catch (e) {}
            if (recordEncoderChild) {
                try { recordEncoderChild.kill('SIGSTOP'); } catch (e) {}
            }
        }
        recordPaused = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: true }));
        return;
    }
    // ── /api/record/resume ──────────────────────────────────────
    // Mirror of pause. For WAV: just flip the flag and the
    // stdout handler starts writing again. For MP3 / OGG:
    // SIGCONT both processes so they resume reading from ALSA.
    if (req.url === '/api/record/resume' && req.method === 'POST') {
        if (!recordChild) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not recording' }));
            return;
        }
        if (!recordPaused) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, paused: false, already: true }));
            return;
        }
        var resumeFmt = recordState && recordState.format;
        if (resumeFmt !== 'wav') {
            try { recordChild.kill('SIGCONT'); } catch (e) {}
            if (recordEncoderChild) {
                try { recordEncoderChild.kill('SIGCONT'); } catch (e) {}
            }
        }
        recordPaused = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: false }));
        return;
    }
    // ── /api/record/formats ─────────────────────────────────────
    // Lists every format with a live availability flag derived
    // from `which <binary>`. The client populates the Format
    // picker from this; selecting an unavailable format pops
    // the install modal.
    if (req.url === '/api/record/formats' && req.method === 'GET') {
        var formatsOut = [];
        var meta = [
            { id: 'wav', label: 'WAV' },
            { id: 'mp3', label: 'MP3' },
            { id: 'ogg', label: 'OGG' }
        ];
        for (var fi = 0; fi < meta.length; fi++) {
            var def = RECORD_FORMATS[meta[fi].id];
            if (!def) continue;
            var entry = {
                id:        meta[fi].id,
                label:     meta[fi].label,
                ext:       def.ext,
                available: !def.binary || probeEncoder(def.binary)
            };
            if (def.pkg) entry.package = def.pkg;
            formatsOut.push(entry);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ formats: formatsOut }));
        return;
    }
    // ── /api/record/install ─────────────────────────────────────
    // apt-get the encoder package — `lame` for MP3,
    // `vorbis-tools` for OGG. Mirrors /api/radio/install.
    if (req.url === '/api/record/install' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var fmtId = (data && data.id) ? String(data.id).toLowerCase() : '';
            var def   = RECORD_FORMATS[fmtId];
            if (!def || !def.pkg) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error:   'No installable package for format ' + fmtId
                }));
                return;
            }
            var instOk  = false;
            var instOut = '';
            try {
                instOut = execSync(
                    'DEBIAN_FRONTEND=noninteractive apt-get install -y ' +
                    '--no-install-recommends ' + def.pkg + ' 2>&1',
                    { encoding: 'utf8', timeout: 60000 });
                instOk = true;
            } catch (e) {
                instOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
            }
            // Invalidate the encoder probe so the next formats
            // poll picks up the new binary state.
            if (def.binary) delete recordEncoderAvailable[def.binary];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: instOk,
                output:  instOut.slice(-1000)
            }));
        });
        return;
    }
    // ── /api/sound/input/gain ───────────────────────────────────
    // Single-knob input-gain endpoint for the Voice recorder.
    //   GET  → { db, min, max }
    //   POST → { db } applies the value; returns the clamped
    //          db + a trace of every amixer call attempted
    //          (which landed vs which failed).
    if (req.url === '/api/sound/input/gain' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            db:  inputGainDb,
            min: INPUT_GAIN_MIN_DB,
            max: INPUT_GAIN_MAX_DB
        }));
        return;
    }
    if (req.url === '/api/sound/input/gain' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var db = data ? Number(data.db) : NaN;
            if (err || !isFinite(db)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var gainCard = getNau8822Card();
            if (!gainCard) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'NAU8822 not found' }));
                return;
            }
            var trace = applyInputGain(gainCard, db);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                db:      inputGainDb,
                min:     INPUT_GAIN_MIN_DB,
                max:     INPUT_GAIN_MAX_DB,
                trace:   trace
            }));
        });
        return;
    }
    // ── /api/sound/input/source ─────────────────────────────────
    // Pick which physical mic feeds the ADC.
    //   GET  → { source }                  ('builtin' | 'jack')
    //   POST → { source } sets it; returns the value and a trace
    //          of every amixer call attempted. The two NAU8822
    //          switches are toggled exclusively so only the
    //          selected path is hot.
    if (req.url === '/api/sound/input/source' && req.method === 'GET') {
        // `cardPresent` lets the client lock the input-device
        // picker when the NAU8822 isn't enumerable — without
        // the codec there's nothing to switch between, so the
        // row should read as "Not found" and stop accepting
        // cycle / pick input.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            source:      inputSource,
            cardPresent: !!getNau8822Card()
        }));
        return;
    }
    if (req.url === '/api/sound/input/source' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var src = data && data.source;
            if (err || !INPUT_SOURCES[src]) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid source' }));
                return;
            }
            var srcCard = getNau8822Card();
            if (!srcCard) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'NAU8822 not found' }));
                return;
            }
            var trace = applyInputSource(srcCard, src);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                source:  inputSource,
                trace:   trace
            }));
        });
        return;
    }
    // ── /api/sound/input/controls ───────────────────────────────
    // Diagnostic-only: returns raw `amixer scontents` output for
    // the NAU8822 card so we can see which controls actually
    // exist on this driver build when the gain slider seems
    // inert.
    if (req.url === '/api/sound/input/controls' && req.method === 'GET') {
        var ctlCard = getNau8822Card();
        if (!ctlCard) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NAU8822 not found' }));
            return;
        }
        var ctlOut = '';
        try {
            ctlOut = execSync('amixer -c ' + ctlCard + ' scontents 2>&1',
                              { encoding: 'utf8', timeout: 3000 });
        } catch (e) {
            ctlOut = String(e.message || e);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(ctlOut);
        return;
    }
    // ── /api/record/rename ──────────────────────────────────────
    // POST { from, to } — rename `from` → `to.<originalExt>` in
    // RECORDINGS_DIR. `to` is sanitized via the same filter
    // start uses; the original extension is preserved (the
    // recording's bytes don't change just because the user
    // wants a new label). Collisions get the same `-1`, `-2`,
    // … suffix walker that buildRecordingFilename uses so the
    // request can't accidentally overwrite another take.
    if (req.url === '/api/record/rename' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.from || !data.to) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var from = String(data.from);
            // Guard against path-traversal in the source name.
            if (/[\/\\]/.test(from) || from.indexOf('..') !== -1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid source' }));
                return;
            }
            var fromPath = path.join(RECORDINGS_DIR, from);
            if (!recordingExists(from)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'File not found' }));
                return;
            }
            // Don't rename a take that's currently being written
            // — sox still has the file open and an in-flight
            // rename would orphan the writer.
            if (recordState && recordState.file === from) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Recording in progress' }));
                return;
            }
            var cleanTo = sanitizeRecordingName(String(data.to));
            if (!cleanTo) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Empty name' }));
                return;
            }
            // Build the exact target name and refuse to rename
            // if anything else is already using it. Renames are
            // an explicit user action — silently appending a
            // `-1` would hide the collision from the user.
            // (The CREATE path in startRecording still auto-
            // suffixes; only rename is strict.)
            var extMatch  = from.match(/\.(wav|mp3|ogg)$/i);
            var ext       = extMatch ? extMatch[1].toLowerCase() : 'wav';
            var targetName = cleanTo + '.' + ext;
            if (targetName === from) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, file: from, unchanged: true }));
                return;
            }
            if (recordingExists(targetName)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error:   'duplicate',
                    file:    targetName
                }));
                return;
            }
            var toPath = path.join(RECORDINGS_DIR, targetName);
            try {
                fs.renameSync(fromPath, toPath);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: String(e.message || e).slice(0, 200)
                }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                from:    from,
                file:    targetName
            }));
        });
        return;
    }
    if (req.url === '/api/record/delete' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var delResult = deleteRecording(data.file);
            res.writeHead(delResult.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(delResult));
        });
        return;
    }
    if (req.url === '/api/record/play' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            // Optional `positionMs` lets the client start
            // playback at an offset (used after a seek; also
            // useful for "resume from where it was" flows).
            var positionMs = (typeof data.positionMs === 'number')
                ? data.positionMs : 0;
            var playResult = playRecording(data.file, positionMs);
            res.writeHead(playResult.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(playResult));
        });
        return;
    }
    // ── /api/record/play/status ─────────────────────────────────
    // Polled by the player overlay to drive the progress bar
    // and toggle button labels. Returns the live position in
    // ms (computed on demand from startedAt + elapsed) so the
    // client never has to track playback timing itself.
    if (req.url === '/api/record/play/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getPlaybackStatus()));
        return;
    }
    // ── /api/record/play/pause ──────────────────────────────────
    // Stops the sox child and remembers the current position so
    // /resume can pick it up via the same `trim` machinery.
    if (req.url === '/api/record/play/pause' && req.method === 'POST') {
        var pauseResult = pausePlayback();
        res.writeHead(pauseResult.success ? 200 : 400,
                      { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pauseResult));
        return;
    }
    // ── /api/record/play/resume ─────────────────────────────────
    // Re-spawns sox at the previously-paused position. No body.
    if (req.url === '/api/record/play/resume' && req.method === 'POST') {
        var resumeResult = resumePlayback();
        res.writeHead(resumeResult.success ? 200 : 400,
                      { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resumeResult));
        return;
    }
    // ── /api/record/play/seek ───────────────────────────────────
    // POST { deltaMs } — relative seek (negative goes back).
    // If playing, sox is re-spawned at the new position; if
    // paused, the saved position shifts but playback stays
    // off until /resume.
    if (req.url === '/api/record/play/seek' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var delta = data && typeof data.deltaMs === 'number'
                ? data.deltaMs : 0;
            var seekResult = seekPlayback(delta);
            res.writeHead(seekResult.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(seekResult));
        });
        return;
    }
    if (req.url === '/api/record/level' && req.method === 'GET') {
        // Server-Sent Events stream of the current peak level
        // (0..1). Clients (the RecordingScene VU meter) subscribe
        // while a recording is active; we push every 100 ms in
        // lockstep with the level poller's update cadence.
        // When no recording is active `recordLevel` is 0, so the
        // stream still works (just shows silence) without
        // additional gating.
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive'
        });
        var sendLevel = function() {
            try { res.write('data: ' + recordLevel.toFixed(4) + '\n\n'); }
            catch (e) { /* socket gone — interval gets cleared on close */ }
        };
        var levelInt = setInterval(sendLevel, 100);
        sendLevel();   // emit one immediately so the meter doesn't sit at 0
        req.on('close', function() { clearInterval(levelInt); });
        return;
    }
    if (req.url === '/api/sound/devices') {
        var audioDevs = getAudioDevices();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioDevs));
        return;
    }
    if (req.url === '/api/sound/device' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.device) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var setResult = setDefaultDevice(data.device);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(setResult));
        });
        return;
    }
    if (req.url === '/api/sound/volume' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || data.volume === undefined || !data.control) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var volResult = setVolume(data.control, data.volume);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(volResult));
        });
        return;
    }
    if (req.url === '/api/sound/volume' && req.method === 'GET') {
        var vol = getVolume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vol));
        return;
    }
    // ── /api/sound/outputs ──────────────────────────────────────
    // High-level outputs for the radio app's picker — see
    // getSoundOutputs() for the rationale (Speaker / Headphone
    // are split out of the NAU8822 card; HDMI / DP appear when
    // present; Loopback is hidden).
    if (req.url === '/api/sound/outputs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getSoundOutputs()));
        return;
    }
    if (req.url === '/api/sound/output' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var outResult = setSoundOutput(data.id);
            res.writeHead(outResult.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(outResult));
        });
        return;
    }
    if (req.url === '/api/sound/restart-driver' && req.method === 'POST') {
        var driverResult = restartAudioDriver();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(driverResult));
        return;
    }
    // ── /api/radio/status ───────────────────────────────────────
    // Reports whether the mpg123 binary needed for internet-radio
    // streaming is installed. The Internet radio scene polls this
    // on `enter()` and gates the rest of the app behind an
    // install modal when the binary is missing.
    if (req.url === '/api/radio/status' && req.method === 'GET') {
        var mpg123Installed = false;
        try {
            execSync('which mpg123', { timeout: 2000 });
            mpg123Installed = true;
        } catch (e) { /* not installed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mpg123Installed: mpg123Installed, playing: radioPlaying }));
        return;
    }
    // ── /api/radio/play ─────────────────────────────────────────
    // Starts streaming the given URL via mpg123. Shares the same
    // audioChild slot as /api/sound/play, so kicking off a radio
    // stream stops any file playback that's already in flight
    // (and vice-versa) — exactly the existing one-thing-at-a-
    // time invariant the rest of the audio stack assumes.
    if (req.url === '/api/radio/play' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            if (err || !data || !data.url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
                return;
            }
            var radioResult = playRadioStream(data.url);
            res.writeHead(radioResult.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(radioResult));
        });
        return;
    }
    // ── /api/radio/stop ─────────────────────────────────────────
    // Same code path as /api/sound/stop — the radio stream is
    // just another `audioChild`, and `stopSound()` doesn't care
    // which producer started it.
    if (req.url === '/api/radio/stop' && req.method === 'POST') {
        stopSound();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }
    // ── /api/walkie/play ────────────────────────────────────────
    // Start the Walkie Talkie audio loop. The scene's enter()
    // hits this once on open; the server then keeps respawning
    // sox on each child exit until /api/walkie/stop (or any
    // other stopSound() caller) breaks the loop.
    if (req.url === '/api/walkie/play' && req.method === 'POST') {
        var wResult = startWalkieLoop();
        res.writeHead(wResult.success ? 200 : 400,
                      { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wResult));
        return;
    }
    // ── /api/walkie/stop ────────────────────────────────────────
    // Stop the loop. Idempotent — safe to call from exit() even
    // if the scene never managed to start the loop.
    if (req.url === '/api/walkie/stop' && req.method === 'POST') {
        var wsResult = stopWalkieLoop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wsResult));
        return;
    }
    // ── /api/mic/level/start ─────────────────────────────────────
    // Spawns arecord on hw:1,0 so subsequent /api/mic/level GETs
    // return live peak values for both channels. Idempotent.
    if (req.url === '/api/mic/level/start' && req.method === 'POST') {
        var mlsResult = startMicLevelMonitor();
        res.writeHead(mlsResult.success ? 200 : 400,
                      { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mlsResult));
        return;
    }
    // ── /api/mic/level/stop ──────────────────────────────────────
    // Kill the arecord child. Idempotent — safe to call on scene
    // exit even if the monitor was never started.
    if (req.url === '/api/mic/level/stop' && req.method === 'POST') {
        var mlxResult = stopMicLevelMonitor();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mlxResult));
        return;
    }
    // ── /api/mic/level ───────────────────────────────────────────
    // Latest peak amplitudes (0..100 integer percent) for both
    // stereo channels. Returns 0/0 when the monitor isn't running.
    if (req.url === '/api/mic/level' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ left: micLeft, right: micRight }));
        return;
    }
    // ── /api/mic/level/stream ────────────────────────────────────
    // Server-Sent Events stream — one persistent connection, the
    // server pushes `data: {"left":N,"right":N}\n\n` lines every
    // time arecord delivers a chunk (rate-limited to ~20 Hz inside
    // notifyMicSubscribers). Replaces the 50-ms polling loop the
    // scene used to run: one HTTP transaction instead of N per
    // second, so the Node event loop stays free for other things
    // (e.g. the touchpad event stream).
    if (req.url === '/api/mic/level/stream' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-store, no-transform',
            'Connection':    'keep-alive',
            // Disable proxy buffering for environments that
            // honour this hint (nginx, etc.). Harmless otherwise.
            'X-Accel-Buffering': 'no'
        });
        // Seed the client with the current state so the meters
        // don't sit at 0 until the next arecord chunk arrives.
        res.write('data: ' + JSON.stringify({ left: micLeft, right: micRight }) + '\n\n');
        micSubscribers.push(res);
        // Cleanup on either side closing the socket. Both events
        // can fire; the indexOf-guard makes the splice idempotent.
        var drop = function() {
            var idx = micSubscribers.indexOf(res);
            if (idx >= 0) micSubscribers.splice(idx, 1);
        };
        req.on('close', drop);
        req.on('error', drop);
        res.on('close', drop);
        res.on('error', drop);
        return;
    }
    // ── /api/boot/default ───────────────────────────────────────
    // GET  → the extlinux DEFAULT entry + its systemd target.
    // POST { target } → rewrite the DEFAULT line to the label that
    //        boots that target ('Select as default' from the
    //        Boot Menu).
    if (req.url === '/api/boot/default' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readExtlinuxDefault()));
        return;
    }
    if (req.url === '/api/boot/default' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var r = setExtlinuxDefault(data && data.target);
            res.writeHead(r.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        });
        return;
    }
    // ── /api/boot/isolate ───────────────────────────────────────
    // POST { target } → `systemctl isolate <target>` (switch the
    // running system to that target now). Used when a Boot Menu
    // profile is selected with OK.
    if (req.url === '/api/boot/isolate' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var r = isolateTarget(data && data.target);
            res.writeHead(r.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
        });
        return;
    }
    // ── /api/boot/target-active ─────────────────────────────────
    // GET ?target=<x>.target → `systemctl is-active <target>`.
    // Returns { target, state, active }. The Boot Menu polls this
    // while its "Starting…" spinner is up, closing it once the
    // target reaches 'active'.
    if (req.method === 'GET' && req.url.indexOf('/api/boot/target-active') === 0) {
        var qm = req.url.split('?')[1] || '';
        var tmatch = qm.match(/(?:^|&)target=([^&]+)/);
        var qTarget = tmatch ? decodeURIComponent(tmatch[1]) : '';
        if (!/^[a-z0-9][a-z0-9.\-]*\.target$/i.test(qTarget)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ active: false, error: 'Invalid target' }));
            return;
        }
        // is-active exits non-zero when not active, but still
        // prints the state on stdout — read it regardless of err.
        exec('systemctl is-active ' + qTarget, function(err, stdout) {
            var state = String(stdout || '').trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ target: qTarget, state: state, active: state === 'active' }));
        });
        return;
    }
    // ── /api/boot/targets ───────────────────────────────────────
    // GET → { targets: [...] }: every systemd target known to the
    // system (installed unit files + loaded units). The Boot Menu
    // checks this to gate profiles on their target's presence rather
    // than hardcoding which targets exist.
    if (req.url === '/api/boot/targets' && req.method === 'GET') {
        listTargets(function(targets) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ targets: targets }));
        });
        return;
    }
    // ── /api/boot/profiles ──────────────────────────────────────
    // GET → { profiles: [...] }: bootable btrfs profiles via list-profiles
    // (name, booted, created, lastUsed, origin) for the Boot Menu. Columns
    // are parsed positionally (NAME [<- booted] KIND ID CREATED LAST USED RO
    // PARENT ORIGIN); the "<- booted" marker shifts them by one. `origin` is
    // origin_stock_name — the client derives base/icon and factory-vs-user
    // from it. Skips _old leftovers.
    if (req.url === '/api/boot/profiles' && req.method === 'GET') {
      // the auto-boot marker is a subvol id in the metadata partition (flipmeta
      // get boot); the matching profile gets autoBoot:true. Absent -> exit 2.
      exec('sudo flipmeta get boot', { encoding: 'utf8', timeout: 10000 }, function(be, bootOut) {
        var bootId = String(bootOut || '').trim();
        if (!/^\d+$/.test(bootId)) bootId = '';
        exec('sudo list-profiles', { encoding: 'utf8', timeout: 20000 }, function(err, stdout) {
            var profiles = [], started = false;
            (stdout || '').split('\n').forEach(function(raw) {
                var t = raw.trim();
                if (!started) { if (/^NAME\b/.test(t)) started = true; return; }
                if (!t) return;
                var cols = t.split(/\s{2,}/);
                var booted = false, base = 1;
                if (/^<-\s*booted$/.test(cols[1] || '')) { booted = true; base = 2; }
                var kind = cols[base] || 'profile';
                if (kind !== 'profile') return;   // profiles only; _old backups are auto-reaped, never listed
                var origin = cols[base + 6] || '';
                var parent = cols[base + 5] || '';
                // ORIGIN may carry the stock's id as "name (id)" (like PARENT).
                var originId = '';
                var om = origin.match(/^(.*?)\s+\((\d+)\)$/);
                if (om) { origin = om[1]; originId = om[2]; }
                var pid = cols[base + 1] || '';
                profiles.push({
                    name:     cols[0],
                    booted:   booted,
                    id:       pid,
                    created:  cols[base + 2] || '',
                    lastUsed: cols[base + 3] || '',
                    parent:   (parent === '-' ? '' : parent),
                    origin:   (origin === '-' ? '' : origin),
                    originId: originId,
                    old:      kind === 'old',
                    autoBoot: (bootId !== '' && pid === bootId)
                });
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ profiles: profiles, error: err ? 'list-profiles failed' : null }));
        });
      });
        return;
    }
    // ── /api/boot/profile/clone ─────────────────────────────────
    // POST { source, dest } → create-profile -y <source> <dest>: a writable
    // copy of an existing profile under a new @<Base>__<label>__ name. Both
    // names are validated to the safe subvol charset (letters/digits/_/-),
    // which also makes them shell-safe for the exec.
    if (req.url === '/api/boot/profile/clone' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var source = (data && data.source) || '';
            var dest   = (data && data.dest) || '';
            var ok = /^@[A-Za-z0-9_-]+$/;
            if (!ok.test(source) || !ok.test(dest)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid name' }));
                return;
            }
            exec('sudo create-profile -y ' + source + ' ' + dest,
                 { encoding: 'utf8', timeout: 60000 }, function(err, stdout, stderr) {
                if (err) {
                    var msg = String(stderr || stdout || 'clone failed').trim().split('\n').pop();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: msg }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, name: dest }));
            });
        });
        return;
    }
    // ── /api/boot/profile/rename ────────────────────────────────
    // POST { name, dest } → rename-profile <name> <dest>: rename a profile
    // (or an _old backup) and reissue its BLS entry. Both names validated to
    // the safe subvol charset.
    if (req.url === '/api/boot/profile/rename' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var name = (data && data.name) || '';
            var dest = (data && data.dest) || '';
            var ok = /^@[A-Za-z0-9_-]+$/;
            if (!ok.test(name) || !ok.test(dest)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid name' }));
                return;
            }
            exec('sudo rename-profile ' + name + ' ' + dest, { encoding: 'utf8', timeout: 60000 }, function(err, stdout, stderr) {
                if (err) {
                    var msg = String(stderr || stdout || 'rename failed').trim().split('\n').pop();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: msg }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, name: dest }));
            });
        });
        return;
    }
    // ── /api/boot/profile/boot ──────────────────────────────────
    // POST { name } → boot-profile <name>: kexec straight into the profile
    // (assembles its DTB from the BLS entry, no firmware/U-Boot cycle). Replies
    // first, then fires the kexec so the response flushes before we hand over.
    if (req.url === '/api/boot/profile/boot' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var name = (data && data.name) || '';
            if (!/^@[A-Za-z0-9_-]+$/.test(name)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid name' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, booting: true }));
            setTimeout(function() { exec('sudo boot-profile ' + name, function() {}); }, 800);
        });
        return;
    }
    // ── /api/boot/profile/autostart ─────────────────────────────
    // POST { id } → flipmeta set boot <id>: persist the auto-boot marker (the
    // profile's subvolume id) in the metadata partition. Exactly one at a time.
    if (req.url === '/api/boot/profile/autostart' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var id = String((data && data.id) || '');
            if (!/^\d+$/.test(id)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid id' }));
                return;
            }
            exec('sudo flipmeta set boot ' + id, { encoding: 'utf8', timeout: 20000 }, function(err, stdout, stderr) {
                if (err) {
                    var msg = String(stderr || stdout || 'flipmeta failed').trim().split('\n').pop();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: msg }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
        });
        return;
    }
    // ── /api/boot/profile/delete ────────────────────────────────
    // POST { name } → delete-profile -y <name>. delete-profile refuses the
    // booted profile and reserved subvolumes; that error is surfaced verbatim.
    if (req.url === '/api/boot/profile/delete' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var name = (data && data.name) || '';
            if (!/^@[A-Za-z0-9_-]+$/.test(name)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid name' }));
                return;
            }
            // If we are deleting the auto-boot target, its subvol id disappears;
            // clear the marker afterwards so nothing autoboots a gone profile.
            exec('sudo flipmeta get boot', { encoding: 'utf8', timeout: 10000 }, function(be, bootOut) {
                var bootId = String(bootOut || '').trim();
                if (!/^\d+$/.test(bootId)) bootId = '';
                profileSubvolId(name, function(ie, delId) {
                    var wasAuto = (bootId !== '' && bootId === delId);
                    exec('sudo delete-profile -y ' + name, { encoding: 'utf8', timeout: 60000 }, function(err, stdout, stderr) {
                        if (err) {
                            var msg = String(stderr || stdout || 'delete failed').trim().split('\n').pop();
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: msg }));
                            return;
                        }
                        if (wasAuto) {
                            exec('sudo flipmeta del boot', { timeout: 20000 }, function() {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ ok: true }));
                            });
                        } else {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true }));
                        }
                    });
                });
            });
        });
        return;
    }
    // ── /api/boot/profile/factory-reset ─────────────────────────
    // POST { name, origin } → create-profile -y --no-keep <origin> <name>:
    // rebuild the profile from its origin stock. --no-keep drops the replaced
    // copy so no <name>_old_<ts> lingers; when <name> is the booted profile it
    // cannot be dropped live, so create-profile keeps it and we soft-reboot into
    // the fresh one (the leftover _old is reaped on next startup, see
    // reapOldBackups). Fails (surfaced) if the exact origin stock is not on disk.
    if (req.url === '/api/boot/profile/factory-reset' && req.method === 'POST') {
        readJsonBody(req, function(e, data) {
            var name   = (data && data.name) || '';
            var origin = (data && data.origin) || '';
            var ok = /^@[A-Za-z0-9_-]+$/;
            if (!ok.test(name) || !ok.test(origin)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Invalid name' }));
                return;
            }
            // Was this profile the auto-boot target? Capture the marker and the
            // profile's current subvol id before the reset. create-profile moves
            // the old copy aside (keeping its id) and gives the fresh profile a
            // new id, so afterwards we must re-point the marker or autoboot would
            // land on the stale _old copy.
            exec('sudo flipmeta get boot', { encoding: 'utf8', timeout: 10000 }, function(be, bootOut) {
                var bootId = String(bootOut || '').trim();
                if (!/^\d+$/.test(bootId)) bootId = '';
                profileSubvolId(name, function(ie, oldId) {
                    var wasAuto = (bootId !== '' && bootId === oldId);
                    exec('sudo create-profile -y --no-keep ' + origin + ' ' + name, { encoding: 'utf8', timeout: 120000 }, function(err, stdout, stderr) {
                        if (err) {
                            var msg = String(stderr || stdout || 'reset failed').trim().split('\n').pop();
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: msg }));
                            return;
                        }
                        if (!wasAuto) { finish(); return; }
                        // move the auto-boot marker onto the fresh profile's new id
                        profileSubvolId(name, function(e3, newId) {
                            if (newId && newId !== bootId) {
                                exec('sudo flipmeta set boot ' + newId, { timeout: 20000 }, function() { finish(); });
                            } else { finish(); }
                        });
                    });
                });
            });
            function finish() {
                exec('findmnt -no FSROOT /', { encoding: 'utf8' }, function(e2, fsroot) {
                    var bootedSubvol = String(fsroot || '').trim().replace(/^\//, '');
                    var rebooting = (bootedSubvol === name);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, rebooting: rebooting }));
                    // reset of the booted profile: reboot into the fresh copy once the
                    // response is on its way (the running root is the moved-aside _old copy)
                    if (rebooting) setTimeout(function() { exec('sudo systemctl reboot', function() {}); }, 1500);
                });
            }
        });
        return;
    }
    // ── /api/boot/profile-size ──────────────────────────────────
    // ── /api/boot/profile-dtbo ──────────────────────────────────
    // GET ?name=<@profile> → { name, dtbo:{system,user} }. Cheap (reads the
    // profile's BLS entry), so the Info popup fetches it separately and paints
    // DTBO immediately instead of waiting on the slow size tree walk.
    if (req.method === 'GET' && req.url.indexOf('/api/boot/profile-dtbo') === 0) {
        var dq = req.url.split('?')[1] || '';
        var dmatch = dq.match(/(?:^|&)name=([^&]+)/);
        var dName = dmatch ? decodeURIComponent(dmatch[1]) : '';
        if (!/^@[A-Za-z0-9._-]+$/.test(dName)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid name' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: dName, dtbo: readProfileDtbo(dName) }));
        return;
    }
    // GET ?name=<@profile>[&full=1] → { name, total, exclusive } and, when
    // full=1, also { referenced, compression } from compsize. Sizes are human
    // strings (e.g. "3.5GiB") shown verbatim. Slow (a tree walk; full adds a
    // compsize walk), so popups show a spinner; memoised per subvol+mode.
    if (req.method === 'GET' && req.url.indexOf('/api/boot/profile-size') === 0) {
        var pq = req.url.split('?')[1] || '';
        var pmatch = pq.match(/(?:^|&)name=([^&]+)/);
        var pName = pmatch ? decodeURIComponent(pmatch[1]) : '';
        var pFull = /(?:^|&)full=1(?:&|$)/.test(pq);
        if (!/^@[A-Za-z0-9._-]+$/.test(pName)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid name' }));
            return;
        }
        var ckey = pName + (pFull ? '|full' : '');
        var cached = profileSizeCache[ckey];
        if (cached && (Date.now() - cached.at) < PROFILE_SIZE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name: pName, total: cached.total, exclusive: cached.exclusive,
                referenced: cached.referenced, compression: cached.compression }));
            return;
        }
        var cmd = 'sudo btrfs-show-space ' + (pFull ? '' : '-q ') + pName;
        exec(cmd, { encoding: 'utf8', timeout: 45000 }, function(err, stdout) {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ name: pName, total: null, exclusive: null, error: 'btrfs-show-space failed' }));
                return;
            }
            var tm = String(stdout).match(/TOTAL=(\S+)/);
            var em = String(stdout).match(/UNIQUE=(\S+)/);
            var rm = String(stdout).match(/REFERENCED=(\S+)/);
            var cm = String(stdout).match(/COMPRESSION=(\S+)/);
            var total      = tm ? tm[1] : null;
            var exclusive  = em ? em[1] : null;
            var referenced = rm ? rm[1] : null;
            var compression = cm ? cm[1] : null;
            profileSizeCache[ckey] = { total: total, exclusive: exclusive, referenced: referenced,
                compression: compression, at: Date.now() };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ name: pName, total: total, exclusive: exclusive,
                referenced: referenced, compression: compression }));
        });
        return;
    }
    // ── /api/target/current ─────────────────────────────────────
    // Which boot profile is active right now (TV Media Box /
    // Desktop Computer / Minimal system). The Desktop dashboard
    // shows this above the hostname. Returns { target, profile }
    // (both null if none of the known profile targets are active).
    if (req.url === '/api/target/current' && req.method === 'GET') {
        currentTargetProfile(function(c) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                target:  c ? c.target  : null,
                profile: c ? c.profile : null
            }));
        });
        return;
    }
    // ── /api/forward/status ─────────────────────────────────────
    // Which forwarders are actually running (pgrep-based).
    if (req.url === '/api/forward/status' && req.method === 'GET') {
        var st = {};
        var pending = 2;
        var finish = function(kind, running) {
            st[kind] = running;
            if (--pending === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(st));
            }
        };
        isForwardRunning('keys',     function(r) { finish('keys', r); });
        isForwardRunning('touchpad', function(r) { finish('touchpad', r); });
        return;
    }
    // ── /api/forward/start ──────────────────────────────────────
    // Body: { kind: 'keys'|'touchpad' }. Launches the matching
    // forwarder script detached (nohup &).
    if (req.url === '/api/forward/start' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var kind = data && data.kind;
            var fr = startForward(kind);
            res.writeHead(fr.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(fr));
        });
        return;
    }
    // ── /api/forward/stop ───────────────────────────────────────
    // Body: { kind: 'keys'|'touchpad' }. Kills that forwarder.
    if (req.url === '/api/forward/stop' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var kind = data && data.kind;
            var sr = stopForward(kind);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sr));
        });
        return;
    }
    // ── /api/type/start ─────────────────────────────────────────
    // Launch the persistent uinput-type.py keyboard (managed child,
    // fed via stdin). Idempotent.
    if (req.url === '/api/type/start' && req.method === 'POST') {
        var tStart = startType();
        res.writeHead(tStart.success ? 200 : 500,
                      { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tStart));
        return;
    }
    // ── /api/type/stop ──────────────────────────────────────────
    if (req.url === '/api/type/stop' && req.method === 'POST') {
        var tStop = stopType();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tStop));
        return;
    }
    // ── /api/type/key ───────────────────────────────────────────
    // Body: { key: 'KEY_A', shift: bool }. Taps it on the typer.
    if (req.url === '/api/type/key' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var kr = sendTypeKey(data && data.key, !!(data && data.shift));
            res.writeHead(kr.success ? 200 : 400,
                          { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(kr));
        });
        return;
    }
    // ── /api/haptic/status ──────────────────────────────────────
    // Whether an FF-capable (haptic) device is present + daemon up.
    if (req.url === '/api/haptic/status' && req.method === 'GET') {
        var hev = findHapticEvent();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: !!hev, event: hev, daemon: !!hapticProc }));
        return;
    }
    // ── /api/haptic/play ────────────────────────────────────────
    // Body: { effectId: 0..255 }. Plays it on the haptic daemon (the
    // daemon holds the fd open, so it runs the full library waveform).
    if (req.url === '/api/haptic/play' && req.method === 'POST') {
        readJsonBody(req, function(err, data) {
            var hr = playHapticEffect(data && data.effectId, data && data.durationMs);
            res.writeHead(hr.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(hr));
        });
        return;
    }
    // ── /api/radio/install ──────────────────────────────────────
    // Installs mpg123 via apt-get. The node server runs as root
    // (it already invokes audio-driver-restart.sh which requires
    // root), so plain apt-get works — no sudo wrapper needed.
    // DEBIAN_FRONTEND=noninteractive avoids any debconf prompt
    // that would otherwise hang the request; --no-install-recommends
    // keeps the install lean. Synchronous: the package is small
    // and the transaction fits inside the 60 s timeout.
    if (req.url === '/api/radio/install' && req.method === 'POST') {
        var instOk = false;
        var instOut = '';
        try {
            instOut = execSync(
                'DEBIAN_FRONTEND=noninteractive apt-get install -y ' +
                '--no-install-recommends mpg123 2>&1',
                { encoding: 'utf8', timeout: 60000 });
            instOk = true;
        } catch (e) {
            instOut = (e.stdout || '') + (e.stderr || '') + (e.message || '');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: instOk,
            output:  instOut.slice(-1000)
        }));
        return;
    }
    if (req.url === '/api/hostname' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ hostname: os.hostname() }));
        return;
    }
    if (req.url === '/api/version' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ id: SERVER_ID }));
        return;
    }
    if (req.url === '/api/system/reboot' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        // Detach the reboot into a transient unit so the OS can
        // tear our process down without killing the command
        // mid-flight (the same trick /api/switch/flipctl uses for
        // its restart). systemd-run --collect --no-block runs
        // outside our cgroup; unref keeps node from waiting on it.
        var sysSpawn = require('child_process').spawn;
        sysSpawn('systemd-run', ['--collect', '--no-block', 'sh', '-c', 'sudo reboot'], {
            detached: true,
            stdio: 'ignore'
        }).unref();
        return;
    }
    if (req.url === '/api/switch/flipctl' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

        // Swap the variant symlink and restart ourselves. Client-side JS is
        // polling /api/version and will reload the page when SERVER_ID changes
        // — so no cog restart is needed. systemd-run keeps the pipeline in
        // a transient unit outside our own cgroup, so it survives the restart.
        // daemon-reload picks up any .service file change that landed via a
        // prior OTA pull — otherwise systemd warns "changed on disk" and may
        // keep running the old unit.
        var cmd = 'ln -sfn /flipperone-testing/fake-flipctl /flipperone-testing/active-flipctl' +
                  ' && systemctl daemon-reload' +
                  ' && systemctl restart fake-flipctl-node-server.service';
        var spawn = require('child_process').spawn;
        spawn('systemd-run', ['--collect', '--no-block', 'sh', '-c', cmd], {
            detached: true,
            stdio: 'ignore'
        }).unref();
        return;
    }
    serveStatic(req, res);
});

server.listen(PORT, BIND, function() {
    console.log('flipctl server listening on http://' + BIND + ':' + PORT);
    if (process.platform === 'linux') {
        try { startTouchpadStream(); }
        catch (e) { console.warn('[touchpad] startup failed: ' + e.message); }

        // Haptic daemon: open the FF device once and keep it ready to
        // play library effects (fed via /api/haptic/play). Started here
        // so it runs for the whole server lifetime.
        try { ensureHapticDaemon(); }
        catch (e) { console.warn('[haptic] startup failed: ' + e.message); }

        // Reap any _old_ backup left by a factory reset of the (now booted) profile.
        try { reapOldBackups(); }
        catch (e) { console.warn('[reap] startup failed: ' + e.message); }

        // Background refreshers keep per-endpoint snapshots fresh without
        // ever blocking the main loop. Periods match the previous client
        // poll rates so perceived freshness is unchanged. HTTP handlers
        // just read the cached objects.
        startRefreshLoop('modem',    refreshModem,    1000);
        startRefreshLoop('wifi',         refreshWifi,        2000);
        startRefreshLoop('wifi-rescan',  triggerWifiRescan, 20000);
        startRefreshLoop('wifi-scan',    refreshWifiScan,    5000);
        startRefreshLoop('wifi-power',   refreshWifiPower,   3000);
        startRefreshLoop('ethernet', refreshEthernet, 2000);
        startRefreshLoop('routing',  refreshRouting,  5000);
        startRefreshLoop('airplane', refreshAirplane, 3000);
        startRefreshLoop('disk',     refreshDisk,    30000);
        // Network LEDs refresher — diff-applies the current
        // target state every second. Cheap (no shell call when
        // nothing changed) and keeps the LEDs in sync with the
        // wifi / ethernet caches even if a refresh cycle skips
        // a beat.
        startRefreshLoop('network-leds', applyLedsFromState, 1000);
    }
});
