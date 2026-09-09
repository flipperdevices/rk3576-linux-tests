/**
 * MeshcoreDemoScene
 *
 * Testing → UI Demos → MESHCORE. Fake demo UI: standard app chrome
 * only for now — status bar + gray title strip with the meshcore
 * icon and the app name. Body is empty; screens land here as the
 * demo grows. Back / Esc pops.
 */
var MeshcoreDemoScene = (function() {
    var TITLE_H = 16;

    // Message boxes (received message bubbles): light-gray rounded
    // frame pinned 5 px off the left edge; sender name + time in
    // dim gray, body in black. The chat is data-driven — edit
    // MESSAGES to change names / times / texts; more entries stack
    // vertically (scrolling comes later).
    var MSG_FILL  = '#EEEEEE';
    var MSG_DIM   = '#696969';
    var MSG_X     = 5;      // left-edge anchor
    var MSG_TOP   = 34;     // first bubble's top
    var MSG_H     = 32;     // fits Busy body incl. descenders
    var MSG_GAP   = 9;      // air between stacked bubbles
    var MSG_TAIL_H = 5;     // speech-tail height below a bubble
    // Default resting position: the newest bubble's tail sits this
    // far off the screen's bottom edge.
    var MSG_BOTTOM_GAP = 18;
    var SCROLL_STEP = 12;   // px per up/down press
    // Own messages: "Sent ✓" fades in left of the bubble once the
    // fake mesh delivery settles.
    var SENT_DELAY_MS = 1500;
    // Send choreography: the feed eases up to the new bottom while
    // the fresh bubble fades in, rising its last APPEAR_RISE px.
    var SEND_SCROLL_MS = 300;
    var APPEAR_MS      = 250;
    var APPEAR_RISE    = 5;
    // Fresh own bubble flashes in black and eases to the normal
    // fill over this long — a send highlight.
    var FLASH_MS       = 500;
    // Touchpad scroll (same SSE feed the keyboard uses): raw pad
    // units are divided by this, so a full ~400-unit swipe drags
    // the feed ~200 px. Direct manipulation — content follows the
    // finger.
    var TP_SLOW_DIVIDER = 2;
    var SCREEN_H  = 144;
    var MSG_PAD   = 4;
    // Bubbles never grow past this — longer texts word-wrap onto
    // extra body lines and the bubble grows DOWN instead.
    var MSG_MAX_W     = 246;
    var BODY_LINE_H   = 12;
    // Vertical gap between the sender name and the message text
    // (name glyphs are ~7 px tall, then the requested 6 px air).
    var MSG_NAME_TO_TEXT = 11;

    // The chat feed, oldest first — bubbles stack downward with
    // MSG_GAP between. The feed scrolls; by default it rests
    // bottom-anchored on the newest message.
    // Scripted STOCK history — a filming prop: every take must
    // start from exactly this feed. The live MESSAGES array resets
    // to a fresh copy whenever the app launches "cold" (first open,
    // or reopened after a kill in the App Switcher); plain
    // switcher round-trips keep whatever was sent.
    var STOCK_MESSAGES = [
        { name: 'Ezekiel', time: '17:14', text: "What's your name?",                        hops: '3 hops'  },
        { name: 'Tony',    time: '17:14', text: 'What?',                                    hops: '12 hops' },
        { name: 'Ezekiel', time: '17:15', text: 'What is your name?',                       hops: '3 hops'  },
        { name: 'Tony',    time: '17:15', text: 'Tony.',                                    hops: '12 hops' },
        { name: 'Ezekiel', time: '17:16', text: 'Fuck you Tony!',                           hops: '3 hops'  },
        { name: 'Tony',    time: '17:17', text: "What's your name?",                        hops: '12 hops' },
        { name: 'Ezekiel', time: '17:17', text: 'Ezekiel.',                                 hops: '3 hops'  },
        { name: 'Tony',    time: '17:18', text: 'Fuck you Ezekiel!',                        hops: '12 hops' },
        { name: 'Ezekiel', time: '17:18', text: 'Fuck you!',                                hops: '3 hops'  },
        { name: 'Tony',    time: '17:19', text: 'Fuck you!',                                hops: '12 hops' },
        { name: 'Ezekiel', time: '17:21', text: 'Hey do know what I did last night?',       hops: '3 hops'  },
        { name: 'Tony',    time: '17:22', text: 'You better not bring my mother into this!', hops: '12 hops' },
        { name: 'Ezekiel', time: '17:22', text: 'You know what I did?',                     hops: '3 hops'  },
        { name: 'Tony',    time: '17:23', text: 'You better not!!!',                        hops: '12 hops' },
        { name: 'Ezekiel', time: '17:25', text: 'I built that fire over there.',            hops: '3 hops'  },
        { name: 'Tony',    time: '17:25', text: 'Oh.',                                      hops: '12 hops' },
        { name: 'Ezekiel', time: '17:26', text: 'Then I fucked your mother next to it!',    hops: '3 hops'  },
        { name: 'Tony',    time: '17:27', text: 'Fuck you Ezekiel!',                        hops: '12 hops' },
        { name: 'Ezekiel', time: '17:27', text: 'Fuck you!',                                hops: '3 hops'  },
        { name: 'Tony',    time: '17:28', text: 'Fuck you!',                                hops: '12 hops' },
        { name: 'aribiderci', time: '17:36', text: 'Hi to all! Test!',  hops: '15 hops' },
        { name: 'Dr Zlo',     time: '17:38', text: 'Execute order 66', hops: '7 hops'  },
        { name: 'Scorp',      time: '17:40', text: 'Copy that.',       hops: '1 hop'   }
    ];
    function stockFeed() {
        return STOCK_MESSAGES.map(function(m) {
            return { name: m.name, time: m.time, text: m.text, hops: m.hops };
        });
    }
    var MESSAGES = stockFeed();

    // Full feed height in content pixels, incl. the last tail and
    // the default bottom air.
    // Greedy word-wrap of a body text into Busy-font lines no wider
    // than maxW. Overlong words hard-break mid-word.
    function wrapBody(text, maxW) {
        var B = Busy9pxFlipCTL;
        var lines = [];
        if (!text) return lines;
        var start = 0, i = 0, lastSpace = -1;
        while (i < text.length) {
            if (B.textWidth(text.slice(start, i + 1)) > maxW && i > start) {
                var brk = (lastSpace > start) ? lastSpace + 1 : i;
                lines.push(text.slice(start, brk));
                start = brk;
                lastSpace = -1;
                continue;
            }
            if (text[i] === ' ') lastSpace = i;
            i++;
        }
        lines.push(text.slice(start));
        return lines;
    }

    // Measure one message's bubble: wrapped body lines, width and
    // height (and whether the hops metric fits beside the last
    // line or needs its own row). Cached on the message object —
    // texts never change after creation.
    function measureMessage(msg) {
        if (msg._m) return msg._m;
        var F = HaxrCorp4090FlipCTL;
        var nameW = F.textWidth(msg.name);
        var timeW = F.textWidth(msg.time);
        var hopsW = msg.hops ? F.textWidth(msg.hops) : 0;
        var innerMax = MSG_MAX_W - MSG_PAD * 2;
        var lines = wrapBody(msg.text, innerMax);
        var maxLineW = 0;
        for (var i = 0; i < lines.length; i++) {
            var lw = Busy9pxFlipCTL.textWidth(lines[i]);
            if (lw > maxLineW) maxLineW = lw;
        }
        var lastW = lines.length
            ? Busy9pxFlipCTL.textWidth(lines[lines.length - 1]) : 0;
        var hopsInline = !msg.hops || (lastW + 5 + hopsW <= innerMax);
        var bodyReq = Math.max(maxLineW,
            msg.hops && hopsInline ? lastW + 5 + hopsW : 0);
        var w = MSG_PAD + Math.max(nameW + 4 + timeW, bodyReq) + MSG_PAD;
        if (w > MSG_MAX_W) w = MSG_MAX_W;
        var h = MSG_H + Math.max(0, lines.length - 1) * BODY_LINE_H
              + (hopsInline ? 0 : BODY_LINE_H);
        msg._m = { w: w, h: h, lines: lines,
                   timeW: timeW, hopsW: hopsW, hopsInline: hopsInline };
        return msg._m;
    }

    function contentH() {
        var total = 0;
        for (var i = 0; i < MESSAGES.length; i++) {
            total += measureMessage(MESSAGES[i]).h;
            if (i > 0) total += MSG_GAP;
        }
        return total + MSG_TAIL_H + MSG_BOTTOM_GAP;
    }
    // How far the feed can scroll (0 when everything fits).
    function maxScroll() {
        return Math.max(0, contentH() - (SCREEN_H - MSG_TOP));
    }

    function MeshcoreDemoScene(sceneManager) {
        var self = this;
        this.sceneManager    = sceneManager || null;
        this.displayName     = 'MESHCORE';
        this.breadcrumbTitle = 'MESHCORE';
        this.icon = (typeof Icons !== 'undefined' && Icons.meshcore) ? Icons.meshcore : null;
        // Feed scroll offset (px). null → not initialised yet; the
        // first render lands it at maxScroll() (newest at bottom).
        this._scroll = null;
        this._edgeDir = 0;      // boundary-haptic debounce
        this._scrollbar = new UI.Scrollbar(1, 1, 0);
        // Bottom-bar "New" button on the V key — same slot 3 the
        // other apps use for their V-bound button (x = 3 × 50).
        // No action wired yet, just the press feedback.
        this._newBtn = new UI.MiddleButton('New', 3, 48, 2, 'del',
            function() { self._openComposer(); });
        this._newBtn.icon = (typeof Icons !== 'undefined' && Icons.new_mesage_button)
            ? Icons.new_mesage_button : null;
    }

    MeshcoreDemoScene.prototype.enter = function() {
        var self = this;
        // Cold launch (not in the running-apps list — first open or
        // the switcher killed us) → reset the feed to the scripted
        // stock history so every take starts identical.
        var fresh = true;
        if (typeof RunningApps !== 'undefined') {
            var running = RunningApps.list();
            for (var ri = 0; ri < running.length; ri++) {
                if (running[ri].name === this.displayName) { fresh = false; break; }
            }
        }
        if (fresh) {
            MESSAGES = stockFeed();
            this._scroll     = null;
            this._scrollAnim = null;
            this._edgeDir    = 0;
        }
        if (typeof RunningApps !== 'undefined') {
            RunningApps.open(this.displayName, null, this.icon,
                function(sm) { return new MeshcoreDemoScene(sm); });
        }
        // Touchpad scroll — the same kernel-evdev SSE stream the
        // keyboard subscribes to.
        this._tpTouching  = false;
        this._tpBaseY     = 0;
        this._tpBaseScrl  = 0;
        try {
            this._tpES = new EventSource('/api/touchpad/xy');
            this._tpES.onmessage = function(e) { self._handleTouchpadMessage(e); };
            this._tpES.onerror   = function() { /* d-pad scroll still works */ };
        } catch (err) {
            this._tpES = null;
        }
        if (window.requestRender) window.requestRender();
    };

    MeshcoreDemoScene.prototype.exit = function() {
        if (this._tpES) {
            this._tpES.close();
            this._tpES = null;
        }
    };

    // Fire-and-forget haptic — the keyboard's helper verbatim.
    MeshcoreDemoScene.prototype._playHaptic = function(effectId, durationMs) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/api/haptic/play', true);
            x.setRequestHeader('Content-Type', 'application/json');
            x.timeout = 2000;
            x.send(JSON.stringify({ effectId: effectId, durationMs: durationMs }));
        } catch (e) { /* offline / mocked — ignore */ }
    };

    // Set the scroll with a keyboard-style haptic tick (effect 3,
    // 10 ms) every time it crosses a SCROLL_STEP bucket.
    MeshcoreDemoScene.prototype._setScroll = function(v) {
        this._scrollAnim = null;   // user input overrides the ease
        var ms  = maxScroll();
        var cur = (this._scroll === null) ? ms : this._scroll;
        // Boundary thump — app-switcher style (effect 3, full
        // waveform) when a scroll pushes past the top or bottom of
        // the history; re-arms once we move back off the edge.
        var edge = (v < 0) ? -1 : (v > ms) ? 1 : 0;
        if (edge !== 0 && edge !== this._edgeDir) this._playHaptic(3);
        this._edgeDir = edge;
        v = Math.max(0, Math.min(ms, v));
        if (v === cur) return;
        if (Math.floor(v / SCROLL_STEP) !== Math.floor(cur / SCROLL_STEP)) {
            this._playHaptic(3, 10);
        }
        this._scroll = v;
        if (window.requestRender) window.requestRender();
    };

    // One SSE message ("x,y,touch"): touch-down anchors the finger
    // Y against the current scroll; movement drags the feed with
    // the finger (up = toward newer / the bottom).
    MeshcoreDemoScene.prototype._handleTouchpadMessage = function(e) {
        var p = String(e.data || '').split(',');
        if (p.length < 3) return;
        var ny = +p[1], nt = +p[2];
        if (ny !== ny || (nt !== 0 && nt !== 1)) return;
        var touching = (nt === 1);
        if (touching && !this._tpTouching) {
            this._tpBaseY    = ny;
            this._tpBaseScrl = (this._scroll === null) ? maxScroll() : this._scroll;
        }
        if (touching) {
            this._setScroll(this._tpBaseScrl
                + (this._tpBaseY - ny) / TP_SLOW_DIVIDER);
        }
        this._tpTouching = touching;
    };

    // "New" → the standard TextInputScreen (same keyboard Wi-Fi
    // uses): empty field, 133-char budget with the live "N left"
    // counter, Send in the bottom-right. Fake demo — Send just
    // closes for now.
    MeshcoreDemoScene.prototype._openComposer = function() {
        if (!this.sceneManager) return;
        var self = this;
        this.sceneManager.push(new TextInputScreen({
            displayName: 'New message',
            title:       'Enter text message',
            initialText: '',
            maxLen:      133,
            doneLabel:   'Send',
            bigField:    true,
            onSave:      function(text) {
                // Own message lands in the feed as a mirrored
                // right-side bubble; the feed re-anchors to the
                // bottom so it's on screen.
                var t = String(text || '').trim();
                if (t) {
                    var now = Date.now();
                    var from = (self._scroll === null) ? maxScroll() : self._scroll;
                    MESSAGES.push({ name: 'Flipper One', time: '17:42',
                                    text: t, own: true,
                                    sentAt: now, bornAt: now });
                    // Ease the feed from wherever it rests up to the
                    // new bottom — the bubble fades in on the way.
                    self._scroll     = from;
                    self._scrollAnim = { from: from, to: maxScroll(), start: now };
                    // One extra repaint just after the delivery
                    // delay so "Sent ✓" pops in without input —
                    // punctuated by the app-switcher boundary buzz
                    // (effect 3), held longer (200 ms vs full run).
                    setTimeout(function() {
                        self._playHaptic(3, 200);
                        if (window.requestRender) window.requestRender();
                    }, SENT_DELAY_MS + 100);
                }
            }
        }));
    };

    MeshcoreDemoScene.prototype.handleInput = function(action) {
        if (action === 'back' || action === 'esc') return 'pop';
        if (action === 'up' || action === 'down') {
            var ms = maxScroll();
            var cur = (this._scroll === null) ? ms : this._scroll;
            this._setScroll(cur + ((action === 'down') ? SCROLL_STEP : -SCROLL_STEP));
            return;
        }
        if (action === 'del') {
            // V key — standard 30 ms press flash on the New button.
            var self = this;
            this._newBtn.press();
            if (window.requestRender) window.requestRender();
            setTimeout(function() {
                self._newBtn.release();
                if (self._newBtn.onPress) self._newBtn.onPress();
                if (window.requestRender) window.requestRender();
            }, 30);
        }
    };

    MeshcoreDemoScene.prototype.render = function(canvas) {
        canvas.clear('#fff');
        var ctx = canvas.ctx;

        // ── Message feed ─────────────────────────────────────────
        // Drawn FIRST so the chrome paints over it: bubbles scrolled
        // past the top vanish under the title strip. Default scroll
        // rests bottom-anchored (newest bubble MSG_BOTTOM_GAP off
        // the screen bottom).
        var ms = maxScroll();
        if (this._scroll === null || (!this._scrollAnim && this._scroll > ms)) {
            this._scroll = ms;
        }
        // Post-send ease toward the new bottom (easeOutCubic).
        var animating = false;
        if (this._scrollAnim) {
            var sa = this._scrollAnim;
            var st = (Date.now() - sa.start) / SEND_SCROLL_MS;
            if (st >= 1) {
                this._scroll = sa.to;
                this._scrollAnim = null;
            } else {
                var se = 1 - Math.pow(1 - st, 3);
                this._scroll = sa.from + (sa.to - sa.from) * se;
                animating = true;
            }
        }
        var yy = MSG_TOP - this._scroll;
        for (var mi = 0; mi < MESSAGES.length; mi++) {
            var mMsg = MESSAGES[mi];
            var mm   = measureMessage(mMsg);
            this._drawMessage(canvas, mMsg, Math.round(yy));
            yy += mm.h + MSG_GAP;
            if (mMsg.bornAt && Date.now() - mMsg.bornAt < APPEAR_MS) {
                animating = true;
            }
            if (mMsg.own && mMsg.sentAt
                    && Date.now() - mMsg.sentAt < FLASH_MS + 50) {
                animating = true;   // black→gray highlight still easing
            }
        }
        // Keep repainting while the send choreography runs.
        if (animating && window.requestRender) window.requestRender();

        // Status bar across the top.
        if (typeof UI !== 'undefined' && UI.drawStatusBar) {
            UI.drawStatusBar(canvas, '');
        }

        // Gray title strip flush under the status bar: meshcore icon
        // + app name in the chunky Sporty font.
        var TITLE_Y = UI.STATUS_BAR_H;
        ctx.fillStyle = '#D9D9D9';
        ctx.fillRect(0, TITLE_Y, canvas.w, TITLE_H);
        if (this.icon) {
            canvas.drawSprite(this.icon, 2, TITLE_Y + 1, '#000');
        }
        Born2bSportyV2FlipCTL.draw(ctx, this.displayName, 20, UI.STATUS_BAR_H, '#000');

        // Chat name, centred in the strip (Haxrcorp — secondary to
        // the Sporty app name).
        var chat  = 'Public';
        var chatW = HaxrCorp4090FlipCTL.textWidth(chat);
        HaxrCorp4090FlipCTL.draw(ctx, chat,
            Math.floor((canvas.w - chatW) / 2), TITLE_Y + 3, '#000');

        // Sync status flush right: check icon + "Up to date".
        var sync  = 'Up to date';
        var syncW = HaxrCorp4090FlipCTL.textWidth(sync);
        var syncX = canvas.w - 2 - syncW;
        if (typeof Icons !== 'undefined' && Icons.check_icon) {
            canvas.drawSprite(Icons.check_icon,
                syncX - Icons.check_icon.w - 3,
                TITLE_Y + Math.floor((TITLE_H - Icons.check_icon.h) / 2),
                '#000');
        }
        HaxrCorp4090FlipCTL.draw(ctx, sync, syncX, TITLE_Y + 3, '#000');

        // Bottom-bar New button (V key).
        this._newBtn.render(canvas);

        // Scrollbar along the right edge — same dotted-track +
        // thumb the menus use, just fed pixel units: total = feed
        // height, visible = viewport height, offset = scroll.
        if (ms > 0) {
            // Real proportions now that the history is long: total =
            // feed height, visible = viewport, offset = scroll.
            var viewH = SCREEN_H - MSG_TOP;
            this._scrollbar.update(contentH(), viewH, this._scroll);
            this._scrollbar.render(canvas, 253, MSG_TOP - 3,
                SCREEN_H - (MSG_TOP - 3) - 3, 1);
        }
    };

    // One message bubble at vertical offset `y`. Received messages
    // hug the left edge (square bottom-left corner + tail there);
    // own messages (`msg.own`) mirror it all to the right edge.
    // Width is content-driven: the wider of the header (name + 4 px
    // + time) and the body line (text, plus 5 px + hops when a hops
    // metric is present), plus MSG_PAD on both sides.
    MeshcoreDemoScene.prototype._drawMessage = function(canvas, msg, y) {
        var ctx = canvas.ctx;
        var F = HaxrCorp4090FlipCTL;
        // Fresh bubble entrance: starts transparent and 5 px low,
        // eases to full opacity in place (everything below draws
        // under one globalAlpha; the fonts/frames are fillRect-
        // based, so the alpha applies cleanly).
        var born = 1;
        if (msg.bornAt) {
            born = (Date.now() - msg.bornAt) / APPEAR_MS;
            if (born >= 1) { born = 1; delete msg.bornAt; }
        }
        var entranceActive = (born < 1);
        if (entranceActive) {
            y += Math.round(APPEAR_RISE * (1 - born));
            ctx.save();
            ctx.globalAlpha = born;
        }
        var m = measureMessage(msg);
        var w = m.w, bh = m.h;
        var own = !!msg.own;
        // Own bubbles sit 1 px further off the right edge.
        var bx  = own ? (canvas.w - MSG_X - w - 1) : MSG_X;

        // Send highlight: the bubble starts black and eases to the
        // stock fill over FLASH_MS; the body text rides white→black
        // in step so it stays readable throughout.
        var fill    = MSG_FILL;
        var bodyCol = '#000';
        if (own && msg.sentAt) {
            var ft = (Date.now() - msg.sentAt) / FLASH_MS;
            if (ft < 1) {
                if (ft < 0) ft = 0;
                var fc = Math.round(0xEE * ft);
                var tc = Math.round(255 * (1 - ft));
                fill    = 'rgb(' + fc + ',' + fc + ',' + fc + ')';
                bodyCol = 'rgb(' + tc + ',' + tc + ',' + tc + ')';
            }
        }

        // The sender-side bottom corner stays square (radius 0) —
        // the bubble "points" back toward its author.
        new ResponsiveFrame({
            x: bx, y: y, width: w, height: bh,
            anchorH: 'left', anchorV: 'top',
            showStroke: false,
            fillColor: fill, showFill: true,
            cornerRadius: 4,
            corners: own ? { tl: true, tr: true, bl: true,  br: false }
                         : { tl: true, tr: true, bl: false, br: true }
        }).render(canvas);

        // Speech tail off the square corner: five 1-px columns
        // hanging below the bubble's bottom edge — heights 5…1
        // leftward from the left corner, mirrored (1…5) into the
        // right corner for own messages.
        ctx.fillStyle = fill;
        for (var t = 0; t < 5; t++) {
            var colH = own ? (t + 1) : (5 - t);
            var colX = own ? (bx + w - 5 + t) : (bx + t);
            ctx.fillRect(colX, y + bh, 1, colH);
        }

        // Header line — same layout on both sides (per the mock):
        // name flush left, time pinned to the top-right corner.
        var headY = y + MSG_PAD - 1;   // all bubble text rides 1 px high
        F.draw(ctx, msg.name, bx + MSG_PAD, headY, MSG_DIM);
        F.draw(ctx, msg.time, bx + w - MSG_PAD - m.timeW, headY, MSG_DIM);

        // Message body under the header line — Busy font (9 px
        // caps, descenders run 2 px past the baseline), wrapped
        // onto BODY_LINE_H rows.
        var bodyY = headY + MSG_NAME_TO_TEXT;
        for (var bl = 0; bl < m.lines.length; bl++) {
            Busy9pxFlipCTL.draw(ctx, m.lines[bl],
                bx + MSG_PAD, bodyY + bl * BODY_LINE_H, bodyCol);
        }
        // Hops metric, right-flushed in the bubble's bottom corner:
        // beside the last body line when it fits, on its own row
        // otherwise. +3 px lines Haxrcorp's baseline up with Busy's.
        if (msg.hops) {
            var lastY = bodyY + (m.lines.length - 1) * BODY_LINE_H;
            var hopsY = m.hopsInline ? lastY + 3 : lastY + BODY_LINE_H + 1;
            F.draw(ctx, msg.hops,
                bx + w - MSG_PAD - m.hopsW, hopsY, MSG_DIM);
        }

        // Delivery state for own messages: "Sent" + the same check
        // glyph the Up-to-date badge uses, left of the bubble,
        // vertically centred — appears SENT_DELAY_MS after send.
        if (own && msg.sentAt
                && Date.now() - msg.sentAt >= SENT_DELAY_MS) {
            var sTxt  = 'Sent';
            var sTxtW = F.textWidth(sTxt);
            var ck = (typeof Icons !== 'undefined' && Icons.check_icon)
                ? Icons.check_icon : null;
            var sx = bx - 4 - sTxtW - (ck ? 3 + ck.w : 0);
            var sy = y + Math.floor((bh - 7) / 2);
            F.draw(ctx, sTxt, sx, sy, MSG_DIM);
            if (ck) canvas.drawSprite(ck, sx + sTxtW + 3, sy + 1, MSG_DIM);
        }

        if (entranceActive) ctx.restore();
    };

    return MeshcoreDemoScene;
})();
