var FlipCanvas = (function() {
    function FlipCanvas(canvasEl) {
        this.el = canvasEl;
        this.w = 256;
        this.h = 144;
        this.ctx = canvasEl.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;
    }

    FlipCanvas.prototype.clear = function(color) {
        this.ctx.fillStyle = color || '#000';
        this.ctx.fillRect(0, 0, this.w, this.h);
    };

    FlipCanvas.prototype.drawRect = function(x, y, w, h, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x, y, w, h);
    };

    FlipCanvas.prototype.drawFrame = function(x, y, w, h, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x, y, w, 1);
        this.ctx.fillRect(x, y + h - 1, w, 1);
        this.ctx.fillRect(x, y, 1, h);
        this.ctx.fillRect(x + w - 1, y, 1, h);
    };

    FlipCanvas.prototype.drawHLine = function(x, y, w, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x, y, w, 1);
    };

    FlipCanvas.prototype.drawVLine = function(x, y, h, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x, y, 1, h);
    };

    FlipCanvas.prototype.drawPixel = function(x, y, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x, y, 1, 1);
    };

    // Shared button constants
    var BTN_H = 14;
    var BTN_R = 4;

    function _btnColors(pressed) {
        return { bg: pressed ? '#000' : '#ffffff', fg: pressed ? '#fff' : '#000' };
    }
    function _btnText(ctx, text, x, w, y, fg) {
        var tw = HaxrCorp4090FlipCTL.textWidth(text);
        var tx = x + Math.floor((w - tw) / 2);
        var ty = y + 2;  // 2px top padding
        HaxrCorp4090FlipCTL.draw(ctx, text, tx, ty, fg);
    }
    // Combined icon + label inside a button. Icon and text are
    // measured as one block and centred horizontally inside the
    // button. Icon is vertically centred against BTN_H; text uses
    // the same 2px top padding as `_btnText`. Falls back to
    // `_btnText` when `icon` is null/undefined.
    function _btnIconText(canvas, text, icon, x, w, y, fg) {
        if (!icon) {
            _btnText(canvas.ctx, text, x, w, y, fg);
            return;
        }
        var GAP = 3;
        var tw = HaxrCorp4090FlipCTL.textWidth(text);
        var totalW = icon.w + GAP + tw;
        var startX = x + Math.floor((w - totalW) / 2);
        // +1 nudge: pure vertical centring puts the icon top at y+1
        // (for an 11 px icon in a 14 px button), but the text top sits
        // at y+2 (the standard 2 px top padding). Matching the icon
        // top to the text top reads as a single optical baseline.
        var iconY  = y + Math.floor((BTN_H - icon.h) / 2) + 1;
        // grayscale sprites go through drawSprite; binary icons
        // through drawIcon — same convention MenuLine uses.
        if (icon.grayscale) {
            canvas.drawSprite(icon, startX, iconY, fg);
        } else {
            canvas.drawIcon(icon, startX, iconY, fg);
        }
        HaxrCorp4090FlipCTL.draw(canvas.ctx, text, startX + icon.w + GAP, y + 2, fg);
    }

    // Middle button — both top corners rounded
    // `iconRight` (optional): a sprite drawn to the RIGHT of the
    // label; the text+gap+icon block is centred as one unit.
    FlipCanvas.prototype.drawMiddleButton = function(text, x, w, pressed, disabled, iconRight) {
        var y = this.h - BTN_H;
        // Disabled: keep the normal (white) fill; only the outline and text go
        // grey, so the button reads as inactive without a solid grey block.
        var base = _btnColors(pressed);
        var c = disabled ? { bg: '#ffffff', fg: '#999', border: '#999' }
                         : { bg: base.bg, fg: base.fg, border: '#000' };
        this.ctx.fillStyle = c.bg;
        // Fill main areas (4px radius)
        this.ctx.fillRect(x + 3, y,      w - 6, 1);         // Row 0: 4px from edges
        this.ctx.fillRect(x + 2, y + 1,  w - 4, 1);         // Row 1: 3px from edges
        this.ctx.fillRect(x + 1, y + 2,  w - 2, 1);         // Row 2: 2px from edges
        this.ctx.fillRect(x,     y + 3,  w,     1);         // Row 3: 1px from edges
        this.ctx.fillRect(x,     y + 4,  w,     BTN_H - 4); // Rows 4+: full width

        // Draw 1px border pixels on top of fill (black, or grey when disabled)
        this.ctx.fillStyle = c.border;
        // Top border (full width)
        this.ctx.fillRect(x + 3, y, w - 6, 1);
        // Left border corner pixels
        this.ctx.fillRect(x + 2, y + 1, 1, 1);
        this.ctx.fillRect(x + 1, y + 2, 1, 1);
        // Left border straight
        this.ctx.fillRect(x, y + 3, 1, BTN_H - 3);
        // Right border corner pixels
        this.ctx.fillRect(x + w - 3, y + 1, 1, 1);
        this.ctx.fillRect(x + w - 2, y + 2, 1, 1);
        // Right border straight
        this.ctx.fillRect(x + w - 1, y + 3, 1, BTN_H - 3);

        if (iconRight) {
            // Text + gap + icon centred as one block, icon on the
            // RIGHT of the label (cf. _btnIconText, which is left).
            var GAPR = 3;
            var twR = HaxrCorp4090FlipCTL.textWidth(text);
            var sxR = x + Math.floor((w - (twR + GAPR + iconRight.w)) / 2);
            HaxrCorp4090FlipCTL.draw(this.ctx, text, sxR, y + 2, c.fg);
            var iyR = y + Math.floor((BTN_H - iconRight.h) / 2) + 1;
            if (iconRight.grayscale) {
                this.drawSprite(iconRight, sxR + twR + GAPR, iyR, c.fg);
            } else {
                this.drawIcon(iconRight, sxR + twR + GAPR, iyR, c.fg);
            }
        } else {
            _btnText(this.ctx, text, x, w, y, c.fg);
        }
    };

    // Icon-only middle button — same body as drawMiddleButton but with
    // a centred icon instead of a text label. The icon is tinted with
    // the button's foreground colour (black at rest, white while
    // pressed, gray when disabled). Reuses drawMiddleButton (empty
    // label) for the body so the chrome stays pixel-identical.
    FlipCanvas.prototype.drawMiddleIconButton = function(icon, x, w, pressed, disabled, dy) {
        this.drawMiddleButton('', x, w, pressed, disabled);
        if (!icon) return;
        var y = this.h - BTN_H;
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);
        var ix = x + Math.floor((w - icon.w) / 2);
        // Centred, plus an optional per-button vertical nudge (dy).
        var iy = y + Math.floor((BTN_H - icon.h) / 2) + (dy || 0);
        if (icon.grayscale) this.drawSprite(icon, ix, iy, c.fg);
        else                this.drawIcon(icon, ix, iy, c.fg);
    };

    // Toggle variant of the middle button — identical body, plus a
    // 2 px accent bar sitting directly on top of the button. The
    // bar is the toggle affordance: black (#000) when `toggled` is
    // on, light gray (#CCCCCC) when off, so the button reads as a
    // toggle in both states. The bar spans the button's flat top
    // (x+3 .. x+w-3) so it lines up with the rounded top edge.
    FlipCanvas.prototype.drawMiddleToggleButton = function(text, x, w, pressed, disabled, toggled) {
        // Standard button body first.
        this.drawMiddleButton(text, x, w, pressed, disabled);
        // 2 px black bar — only shown while toggled ON; hidden in
        // the regular (untoggled) state so the button reads as a
        // plain button until it's pushed. Sits 1 px into the top
        // edge, 2 px wider than the flat top (x+2 / w-4).
        if (toggled && !disabled) {
            var y = this.h - BTN_H;
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(x + 2, y + 1, w - 4, 2);
        }
    };

    // Icon toggle button — drawMiddleIconButton plus the same 2 px
    // accent bar as drawMiddleToggleButton (shown only while toggled).
    FlipCanvas.prototype.drawMiddleIconToggleButton = function(icon, x, w, pressed, disabled, toggled, dy) {
        this.drawMiddleIconButton(icon, x, w, pressed, disabled, dy);
        if (toggled && !disabled) {
            var y = this.h - BTN_H;
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(x + 2, y + 1, w - 4, 2);
        }
    };

    // Numeric-layout tab button. Looks like a middle app-defined
    // button rotated 180° — top corners are square (radius 0)
    // and the bottom corners are rounded with r=4. No top stroke;
    // the side + bottom strokes are the same light gray
    // (#CCCCCC) that the keyboard-key frames use, so the tab
    // reads as part of the same chrome family. Caller passes an
    // absolute (x, y) because this button isn't slot-positioned
    // like MiddleButton.
    FlipCanvas.prototype.drawNumericTabButton = function(text, x, y, w, pressed, disabled) {
        var h = BTN_H;
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);
        var stroke = '#CCCCCC';
        this.ctx.fillStyle = c.bg;
        // Fill: full-width interior from the top edge down to
        // where the bottom curve starts, then step in for each
        // row of the rounded corner. No top-stroke means row 0
        // is bg — the interior runs all the way up.
        this.ctx.fillRect(x,     y,         w,     h - 3);
        this.ctx.fillRect(x + 1, y + h - 3, w - 2, 1);
        this.ctx.fillRect(x + 2, y + h - 2, w - 4, 1);
        this.ctx.fillRect(x + 3, y + h - 1, w - 6, 1);

        // Stroke on top of the fill, in the light-gray frame
        // colour used by the keyboard keys.
        this.ctx.fillStyle = stroke;
        // Vertical side strokes — span the full height from the
        // top edge down to the last full-width row.
        this.ctx.fillRect(x,         y, 1, h - 3);
        this.ctx.fillRect(x + w - 1, y, 1, h - 3);
        // Bottom-corner step pixels (radius-4 curve, mirroring
        // the top of MiddleButton).
        this.ctx.fillRect(x + 1,     y + h - 3, 1, 1);
        this.ctx.fillRect(x + 2,     y + h - 2, 1, 1);
        this.ctx.fillRect(x + w - 2, y + h - 3, 1, 1);
        this.ctx.fillRect(x + w - 3, y + h - 2, 1, 1);
        // Bottom stroke, narrowed to clear the rounded corners.
        this.ctx.fillRect(x + 3,     y + h - 1, w - 6, 1);

        // Label sits 1 px higher than the standard `_btnText`
        // position (y+1 instead of y+2) — the missing top stroke
        // gives the text an extra pixel to breathe upward.
        var tw = HaxrCorp4090FlipCTL.textWidth(text);
        var tx = x + Math.floor((w - tw) / 2);
        HaxrCorp4090FlipCTL.draw(this.ctx, text, tx, y + 1, c.fg);
    };

    // Icon-content tab button. Same shape as drawNumericTabButton
    // (square top, rounded bottom, light-gray side + curve
    // strokes) but renders a centred icon instead of a text
    // label. Used by the backspace tab that mirrors the 123 tab
    // on the right side of the screen.
    FlipCanvas.prototype.drawIconTabButton = function(icon, x, y, w, pressed, disabled) {
        var h = BTN_H;
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);
        var stroke = '#CCCCCC';
        this.ctx.fillStyle = c.bg;
        this.ctx.fillRect(x,     y,         w,     h - 3);
        this.ctx.fillRect(x + 1, y + h - 3, w - 2, 1);
        this.ctx.fillRect(x + 2, y + h - 2, w - 4, 1);
        this.ctx.fillRect(x + 3, y + h - 1, w - 6, 1);

        this.ctx.fillStyle = stroke;
        this.ctx.fillRect(x,         y, 1, h - 3);
        this.ctx.fillRect(x + w - 1, y, 1, h - 3);
        this.ctx.fillRect(x + 1,     y + h - 3, 1, 1);
        this.ctx.fillRect(x + 2,     y + h - 2, 1, 1);
        this.ctx.fillRect(x + w - 2, y + h - 3, 1, 1);
        this.ctx.fillRect(x + w - 3, y + h - 2, 1, 1);
        this.ctx.fillRect(x + 3,     y + h - 1, w - 6, 1);

        if (icon) {
            var ix = x + Math.floor((w - icon.w) / 2);
            var iy = y + Math.floor((h - icon.h) / 2);
            if (icon.grayscale) this.drawSprite(icon, ix, iy, c.fg);
            else                this.drawIcon(icon, ix, iy, c.fg);
        }
    };

    // 1-px black selector for the numeric tab button. Overdraws
    // the button's existing gray stroke on the sides and the
    // rounded-bottom curve, in black, and adds an underline
    // strip 1 px below the button. Top edge stays open so the
    // selector reads as a tab attached to the chrome above it
    // rather than a freestanding rectangle.
    FlipCanvas.prototype.drawNumericTabButtonSelector = function(x, y, w) {
        var h = BTN_H;
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(x,         y,         1,     h - 3);      // left
        this.ctx.fillRect(x + w - 1, y,         1,     h - 3);      // right
        this.ctx.fillRect(x + 1,     y + h - 3, 1,     1);          // BL step 1
        this.ctx.fillRect(x + 2,     y + h - 2, 1,     1);          // BL step 2
        this.ctx.fillRect(x + w - 2, y + h - 3, 1,     1);          // BR step 1
        this.ctx.fillRect(x + w - 3, y + h - 2, 1,     1);          // BR step 2
        this.ctx.fillRect(x + 3,     y + h - 1, w - 6, 1);          // bottom
        // 1-px nubs directly below each side stroke — extends
        // the left and right verticals down by one pixel so they
        // meet the row of the upper corner step.
        this.ctx.fillRect(x,         y + h - 3, 1, 1);
        this.ctx.fillRect(x + w - 1, y + h - 3, 1, 1);
        // 1-px corner accents filling the inside of each rounded
        // bottom corner. Two pixels per side:
        //   • Upper pair at (x+1, y+h-2) / (x+w-2, y+h-2) —
        //     directly below step-1, adjacent to step-2.
        //   • Lower pair at (x+2, y+h-1) / (x+w-3, y+h-1) —
        //     one row down and one column inward; bridges the
        //     corner to the bottom stroke on the same row.
        this.ctx.fillRect(x + 1,     y + h - 2, 1, 1);
        this.ctx.fillRect(x + w - 2, y + h - 2, 1, 1);
        this.ctx.fillRect(x + 2,     y + h - 1, 1, 1);
        this.ctx.fillRect(x + w - 3, y + h - 1, 1, 1);
        // 1×11 flank strips, 1 column outside each side of the
        // button, top-aligned with the button's top edge.
        var FLANK_H = 11;
        this.ctx.fillRect(x - 1,     y, 1, FLANK_H);
        this.ctx.fillRect(x + w,     y, 1, FLANK_H);
        // 42×1 underline strip 1 row below the button, centred
        // inside the button's width.
        var UNDERLINE_W = 42;
        this.ctx.fillRect(x + Math.floor((w - UNDERLINE_W) / 2),
            y + h, UNDERLINE_W, 1);
    };

    // Left button — flush with left screen edge, only top-right corner rounded.
    // Optional `icon` renders to the left of the label; the icon+text
    // pair is centred together inside the button.
    FlipCanvas.prototype.drawLeftButton = function(text, x, w, pressed, disabled, icon) {
        var y = this.h - BTN_H;
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);
        this.ctx.fillStyle = c.bg;
        // Fill main areas (4px right radius)
        this.ctx.fillRect(x,     y,      w - 3, 1);         // Row 0: 4px from right
        this.ctx.fillRect(x,     y + 1,  w - 2, 1);         // Row 1: 3px from right
        this.ctx.fillRect(x,     y + 2,  w - 1, 1);         // Row 2: 2px from right
        this.ctx.fillRect(x,     y + 3,  w,     1);         // Row 3: 1px from right
        this.ctx.fillRect(x,     y + 4,  w,     BTN_H - 4); // Rows 4+: full width

        // Draw 1px border (no left border, always black)
        this.ctx.fillStyle = '#000';
        // Top border (no left corner)
        this.ctx.fillRect(x, y, w - 3, 1);
        // Right border corner pixels
        this.ctx.fillRect(x + w - 3, y + 1, 1, 1);
        this.ctx.fillRect(x + w - 2, y + 2, 1, 1);
        // Right border straight
        this.ctx.fillRect(x + w - 1, y + 3, 1, BTN_H - 3);

        _btnIconText(this, text, icon, x, w, y, c.fg);
    };

    // Right button — flush with right screen edge, only top-left corner rounded
    FlipCanvas.prototype.drawRightButton = function(text, x, w, pressed, disabled) {
        var y = this.h - BTN_H;
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);
        this.ctx.fillStyle = c.bg;
        // Fill main areas (4px left radius)
        this.ctx.fillRect(x + 3, y,      w - 3, 1);         // Row 0: 4px from left
        this.ctx.fillRect(x + 2, y + 1,  w - 2, 1);         // Row 1: 3px from left
        this.ctx.fillRect(x + 1, y + 2,  w - 1, 1);         // Row 2: 2px from left
        this.ctx.fillRect(x,     y + 3,  w,     1);         // Row 3: 1px from left
        this.ctx.fillRect(x,     y + 4,  w,     BTN_H - 4); // Rows 4+: full width

        // Draw 1px border (no right border, always black)
        this.ctx.fillStyle = '#000';
        // Top border (no right corner)
        this.ctx.fillRect(x + 3, y, w - 3, 1);
        // Left border corner pixels
        this.ctx.fillRect(x + 2, y + 1, 1, 1);
        this.ctx.fillRect(x + 1, y + 2, 1, 1);
        // Left border straight
        this.ctx.fillRect(x, y + 3, 1, BTN_H - 3);

        _btnText(this.ctx, text, x, w, y, c.fg);
    };

    // Variant of drawRightButton whose frame is the
    // target_app_defined_button icon — a 48 x 21 grayscale outline
    // with a top-right tab and a rounded bottom-left corner. The
    // icon's lower 14 rows (BTN_H) are the button body; the top 7 px
    // protrude above as the tab. Drawn over the body fill, with the
    // text on top. The stock drawRightButton (and every other
    // RightButton in the app) is left untouched.
    FlipCanvas.prototype.drawRightButtonTopCut = function(text, x, w, pressed, disabled, icon) {
        var y = this.h - BTN_H;
        // Standard button colours: white fill at rest, inverted to
        // black bg / white text while pressed, gray when disabled.
        var c = disabled ? { bg: '#CCC', fg: '#999' } : _btnColors(pressed);

        // Body fill — rounded top-left rectangle (the lower BTN_H px).
        // The step matches the icon's rounded corner so the fill sits
        // flush inside the outline.
        this.ctx.fillStyle = c.bg;
        this.ctx.fillRect(x + 3, y,      w - 3, 1);         // Row 0: 4px from left
        this.ctx.fillRect(x + 2, y + 1,  w - 2, 1);         // Row 1: 3px from left
        this.ctx.fillRect(x + 1, y + 2,  w - 1, 1);         // Row 2: 2px from left
        this.ctx.fillRect(x,     y + 3,  w,     1);         // Row 3: 1px from left
        this.ctx.fillRect(x,     y + 4,  w,     BTN_H - 4); // Rows 4+: full width

        // Frame icon + matching tab fill. The icon is anchored so its
        // bottom aligns with the screen bottom; its body top edge then
        // lands on the button's top edge (y) and the top 7 px tab
        // protrudes above.
        var frameIcon = (typeof Icons !== 'undefined') ? Icons.target_app_defined_button : null;
        if (frameIcon) {
            var topY = this.h - frameIcon.h;  // icon top row
            // Fill the protruding tab interior with the body colour
            // too. The tab occupies the icon's top rows above the
            // body; its left edge follows the diagonal (icon cols
            // 29 / 28 / 27 over rows 1 / 2-5 / 6) and it runs flush to
            // the right edge. Filled before the outline so the black
            // icon redraws the diagonal on top. Columns mirror the
            // icon geometry.
            this.ctx.fillStyle = c.bg;
            this.ctx.fillRect(x + 29, topY + 1, w - 29, 1);  // row 1
            this.ctx.fillRect(x + 28, topY + 2, w - 28, 4);  // rows 2-5
            this.ctx.fillRect(x + 27, topY + 6, w - 27, 1);  // row 6
            // Outline (black) over the fill.
            this.drawSprite(frameIcon, x, topY, '#000');
        }

        // Icon above the label. Defaults to the purpose-drawn
        // media_small sprite (10x8 grayscale) but callers can pass a
        // different one (e.g. desktop_small_icon). Horizontally centred
        // then shifted right (into the tab), bottom edge on the body
        // top (y). ix/iy kept for easy nudging.
        var btnIcon = icon || ((typeof Icons !== 'undefined') ? Icons.media_small : null);
        if (btnIcon) {
            var mi = btnIcon;
            var ix = x + Math.floor((w - mi.w) / 2) + 14;
            var iy = y - mi.h + 3;
            this.drawSprite(mi, ix, iy, '#000');
        }

        _btnText(this.ctx, text, x, w, y, c.fg);
    };

    // drawRoundRect(x, y, w, h, r, color) — filled rounded rect, r: 2 or 3
    FlipCanvas.prototype.drawRoundRect = function(x, y, w, h, r, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x + r, y,     w - r * 2, h);      // center column
        this.ctx.fillRect(x,     y + r, r, h - r * 2);      // left strip
        this.ctx.fillRect(x + w - r, y + r, r, h - r * 2);  // right strip
        if (r === 2) {
            this.ctx.fillRect(x + 1,     y + 1,     1, 1);
            this.ctx.fillRect(x + w - 2, y + 1,     1, 1);
            this.ctx.fillRect(x + 1,     y + h - 2, 1, 1);
            this.ctx.fillRect(x + w - 2, y + h - 2, 1, 1);
        } else if (r === 3) {
            this.ctx.fillRect(x + 2,     y + 1,     1, 1);
            this.ctx.fillRect(x + 1,     y + 2,     1, 1);
            this.ctx.fillRect(x + w - 3, y + 1,     1, 1);
            this.ctx.fillRect(x + w - 2, y + 2,     1, 1);
            this.ctx.fillRect(x + 2,     y + h - 2, 1, 1);
            this.ctx.fillRect(x + 1,     y + h - 3, 1, 1);
            this.ctx.fillRect(x + w - 3, y + h - 2, 1, 1);
            this.ctx.fillRect(x + w - 2, y + h - 3, 1, 1);
        }
    };

    // drawRoundFrame(x, y, w, h, r) — r: 2 or 3
    FlipCanvas.prototype.drawRoundFrame = function(x, y, w, h, r, color) {
        this.ctx.fillStyle = color || '#fff';
        this.ctx.fillRect(x + r, y,         w - r * 2, 1);  // top
        this.ctx.fillRect(x + r, y + h - 1, w - r * 2, 1);  // bottom
        this.ctx.fillRect(x,         y + r, 1, h - r * 2);  // left
        this.ctx.fillRect(x + w - 1, y + r, 1, h - r * 2);  // right
        if (r === 2) {
            this.ctx.fillRect(x + 1,     y + 1,     1, 1);
            this.ctx.fillRect(x + w - 2, y + 1,     1, 1);
            this.ctx.fillRect(x + 1,     y + h - 2, 1, 1);
            this.ctx.fillRect(x + w - 2, y + h - 2, 1, 1);
        } else if (r === 3) {
            this.ctx.fillRect(x + 2,     y + 1,     1, 1);
            this.ctx.fillRect(x + 1,     y + 2,     1, 1);
            this.ctx.fillRect(x + w - 3, y + 1,     1, 1);
            this.ctx.fillRect(x + w - 2, y + 2,     1, 1);
            this.ctx.fillRect(x + 2,     y + h - 2, 1, 1);
            this.ctx.fillRect(x + 1,     y + h - 3, 1, 1);
            this.ctx.fillRect(x + w - 3, y + h - 2, 1, 1);
            this.ctx.fillRect(x + w - 2, y + h - 3, 1, 1);
        }
    };

    // Bresenham line — used by scenes that paint per-pixel paths
    // (e.g. the touchpad test's stroke trail). Endpoints inclusive,
    // integer coordinates only; the input is `| 0`-coerced first
    // since pointer events arrive as floats post-CSS-unscale.
    FlipCanvas.prototype.drawLine = function(x0, y0, x1, y1, color) {
        this.ctx.fillStyle = color || '#fff';
        x0 = x0 | 0; y0 = y0 | 0; x1 = x1 | 0; y1 = y1 | 0;
        var dx = Math.abs(x1 - x0);
        var dy = Math.abs(y1 - y0);
        var sx = x0 < x1 ? 1 : -1;
        var sy = y0 < y1 ? 1 : -1;
        var err = dx - dy;
        while (true) {
            this.ctx.fillRect(x0, y0, 1, 1);
            if (x0 === x1 && y0 === y1) break;
            var e2 = err << 1;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 <  dx) { err += dx; y0 += sy; }
        }
    };

    FlipCanvas.prototype.drawText = function(text, x, y, color, scale) {
        BitmapFont.draw(this.ctx, text, x, y, color || '#fff', scale);
    };

    FlipCanvas.prototype.textWidth = function(text, scale) {
        return BitmapFont.textWidth(text, scale);
    };

    // drawPopupLeft(x, y, bodyW, bodyH, tabW, bg, tabBg, fg)
    // Popup with two rectangles: body (top, TL/TR/BR rounded r=4, BL square)
    // and tab (bottom, BL/BR rounded r=4, TL/TR square).
    // Body: white (#fff), Tab: darker (#D0D0D0)
    FlipCanvas.prototype.drawPopupLeft = function(x, y, bodyW, bodyH, tabW, bg, tabBg, fg) {
        var TAB_H = 17;
        var R = 4;
        var ctx = this.ctx;

        // ── Body Fill ────────────────────────────────────────────────────────
        ctx.fillStyle = bg;

        // Body main rectangles
        ctx.fillRect(x + R, y, bodyW - R * 2, bodyH);           // top/center (without rounded corners)
        ctx.fillRect(x, y + R, R, bodyH - R);                   // left edge (straight)
        ctx.fillRect(x + bodyW - R, y + R, R, bodyH - R * 2);   // right edge (TR and BR space)

        // Body corner fill pixels (r=4)
        // TL corner
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 3, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x + 2, y + 2, 1, 1);
        ctx.fillRect(x + 3, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);
        ctx.fillRect(x + 1, y + 3, 1, 1);
        ctx.fillRect(x + 2, y + 3, 1, 1);
        ctx.fillRect(x + 3, y + 3, 1, 1);
        // TR corner (mirror TL)
        ctx.fillRect(x + bodyW - 4, y, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + 1, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + 1, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + 2, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + 2, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + 2, 1, 1);
        ctx.fillRect(x + bodyW - 1, y + 3, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + 3, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + 3, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + 3, 1, 1);
        // BR corner (180 rotation of TL)
        ctx.fillRect(x + bodyW - 4, y + bodyH - 4, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + bodyH - 4, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + bodyH - 4, 1, 1);
        ctx.fillRect(x + bodyW - 1, y + bodyH - 4, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + bodyH - 3, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + bodyH - 3, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + bodyH - 3, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + bodyH - 2, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + bodyH - 2, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + bodyH - 1, 1, 1);

        // ── Tab Fill ────────────────────────────────────────────────────────
        ctx.fillStyle = tabBg;

        // Tab main rectangles
        ctx.fillRect(x + R, y + bodyH, tabW - R * 2, TAB_H);    // center/bottom
        ctx.fillRect(x, y + bodyH, R, TAB_H - R);               // left edge (TL square)
        ctx.fillRect(x + tabW - R, y + bodyH, R, TAB_H - R);    // right edge (TR square)

        // Tab corner fill pixels (r=4)
        // BL corner (inverted vertically from TL)
        ctx.fillRect(x, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + 1, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + 2, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + 3, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + 1, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + 2, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + 3, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + 2, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + 3, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + 3, y + bodyH + TAB_H - 1, 1, 1);
        // BR corner (inverted vertically from TR)
        ctx.fillRect(x + tabW - 4, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + tabW - 3, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + tabW - 2, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + tabW - 1, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + tabW - 4, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + tabW - 3, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + tabW - 2, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + tabW - 4, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + tabW - 3, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + tabW - 4, y + bodyH + TAB_H - 1, 1, 1);

        // ── Body Border ──────────────────────────────────────────────────────
        ctx.fillStyle = fg;

        // TL corner outline (r=4)
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);

        // Top edge
        ctx.fillRect(x + 4, y, bodyW - 8, 1);

        // TR corner outline (r=4)
        ctx.fillRect(x + bodyW - 4, y, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + 1, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + 2, 1, 1);
        ctx.fillRect(x + bodyW - 1, y + 3, 1, 1);

        // Right edge of body
        ctx.fillRect(x + bodyW - 1, y + 4, 1, bodyH - 8);

        // BR corner outline (r=4)
        ctx.fillRect(x + bodyW - 1, y + bodyH - 4, 1, 1);
        ctx.fillRect(x + bodyW - 2, y + bodyH - 3, 1, 1);
        ctx.fillRect(x + bodyW - 3, y + bodyH - 2, 1, 1);
        ctx.fillRect(x + bodyW - 4, y + bodyH - 1, 1, 1);

        // Bottom edge of body (right part, after tab)
        if (bodyW > tabW) {
            ctx.fillRect(x + tabW + 1, y + bodyH - 1, bodyW - tabW - 5, 1);
        }

        // Inner corner
        ctx.fillRect(x + tabW, y + bodyH, 1, 1);

        // Left edge of body
        ctx.fillRect(x, y + 4, 1, bodyH - 4);

        // ── Tab Border ───────────────────────────────────────────────────────

        // BL corner outline (r=4)
        ctx.fillRect(x, y + bodyH + TAB_H - 4, 1, 1);
        ctx.fillRect(x + 1, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + 2, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + 3, y + bodyH + TAB_H - 1, 1, 1);

        // Bottom edge of tab
        ctx.fillRect(x + 4, y + bodyH + TAB_H - 1, tabW - 8, 1);

        // BR corner outline (r=4)
        ctx.fillRect(x + tabW - 4, y + bodyH + TAB_H - 1, 1, 1);
        ctx.fillRect(x + tabW - 3, y + bodyH + TAB_H - 2, 1, 1);
        ctx.fillRect(x + tabW - 2, y + bodyH + TAB_H - 3, 1, 1);
        ctx.fillRect(x + tabW - 1, y + bodyH + TAB_H - 4, 1, 1);

        // Right edge of tab
        ctx.fillRect(x + tabW - 1, y + bodyH + 1, 1, TAB_H - 5);

        // Left edge of tab
        ctx.fillRect(x, y + bodyH, 1, TAB_H - 4);
    };

    // drawInputField(x, y, w, h, r, bgColor, borderColor)
    // Input field with rounded corners (r=3)
    // Simple bordered rectangle for text input
    FlipCanvas.prototype.drawInputField = function(x, y, w, h, r, bgColor, borderColor) {
        var ctx = this.ctx;

        // ── Fill ──────────────────────────────────────────────────────────────
        ctx.fillStyle = bgColor;

        // Main rectangles
        ctx.fillRect(x + r, y, w - r * 2, h);           // center
        ctx.fillRect(x, y + r, r, h - r * 2);           // left edge
        ctx.fillRect(x + w - r, y + r, r, h - r * 2);   // right edge

        // Corner pixels (r=3)
        // Top-left
        ctx.fillRect(x + 2, y, 1, 1);
        ctx.fillRect(x + 1, y + 1, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x, y + 2, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x + 2, y + 2, 1, 1);

        // Top-right (mirror)
        ctx.fillRect(x + w - 3, y, 1, 1);
        ctx.fillRect(x + w - 2, y + 1, 1, 1);
        ctx.fillRect(x + w - 3, y + 1, 1, 1);
        ctx.fillRect(x + w - 1, y + 2, 1, 1);
        ctx.fillRect(x + w - 2, y + 2, 1, 1);
        ctx.fillRect(x + w - 3, y + 2, 1, 1);

        // Bottom-left (inverted)
        ctx.fillRect(x, y + h - 3, 1, 1);
        ctx.fillRect(x + 1, y + h - 3, 1, 1);
        ctx.fillRect(x + 2, y + h - 3, 1, 1);
        ctx.fillRect(x + 1, y + h - 2, 1, 1);
        ctx.fillRect(x + 2, y + h - 2, 1, 1);
        ctx.fillRect(x + 2, y + h - 1, 1, 1);

        // Bottom-right (mirror)
        ctx.fillRect(x + w - 1, y + h - 3, 1, 1);
        ctx.fillRect(x + w - 2, y + h - 3, 1, 1);
        ctx.fillRect(x + w - 3, y + h - 3, 1, 1);
        ctx.fillRect(x + w - 2, y + h - 2, 1, 1);
        ctx.fillRect(x + w - 3, y + h - 2, 1, 1);
        ctx.fillRect(x + w - 3, y + h - 1, 1, 1);

        // ── Border ────────────────────────────────────────────────────────────
        ctx.fillStyle = borderColor;

        // Top-left corner outline (r=3)
        ctx.fillRect(x + 2, y, 1, 1);
        ctx.fillRect(x + 1, y + 1, 1, 1);
        ctx.fillRect(x, y + 2, 1, 1);

        // Top edge
        ctx.fillRect(x + 3, y, w - 6, 1);

        // Top-right corner outline
        ctx.fillRect(x + w - 3, y, 1, 1);
        ctx.fillRect(x + w - 2, y + 1, 1, 1);
        ctx.fillRect(x + w - 1, y + 2, 1, 1);

        // Right edge
        ctx.fillRect(x + w - 1, y + 3, 1, h - 6);

        // Bottom-right corner outline
        ctx.fillRect(x + w - 1, y + h - 3, 1, 1);
        ctx.fillRect(x + w - 2, y + h - 2, 1, 1);
        ctx.fillRect(x + w - 3, y + h - 1, 1, 1);

        // Bottom edge
        ctx.fillRect(x + 3, y + h - 1, w - 6, 1);

        // Bottom-left corner outline
        ctx.fillRect(x, y + h - 3, 1, 1);
        ctx.fillRect(x + 1, y + h - 2, 1, 1);
        ctx.fillRect(x + 2, y + h - 1, 1, 1);

        // Left edge
        ctx.fillRect(x, y + 3, 1, h - 6);
    };

    // drawTabHeader(x, y, w, h)
    // Tab header with rounded top corners (r=4)
    // Solid black fill with white text
    FlipCanvas.prototype.drawTabHeader = function(x, y, w, h) {
        var R = 4;
        var ctx = this.ctx;

        ctx.fillStyle = '#000';

        // Main rectangles
        ctx.fillRect(x + R, y, w - R * 2, h);           // center
        ctx.fillRect(x, y + R, R, h - R);               // left edge
        ctx.fillRect(x + w - R, y + R, R, h - R);       // right edge

        // Top-left corner pixels (r=4)
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 3, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x + 2, y + 2, 1, 1);
        ctx.fillRect(x + 3, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);
        ctx.fillRect(x + 1, y + 3, 1, 1);
        ctx.fillRect(x + 2, y + 3, 1, 1);
        ctx.fillRect(x + 3, y + 3, 1, 1);

        // Top-right corner pixels (mirror of top-left)
        ctx.fillRect(x + w - 4, y, 1, 1);
        ctx.fillRect(x + w - 3, y + 1, 1, 1);
        ctx.fillRect(x + w - 4, y + 1, 1, 1);
        ctx.fillRect(x + w - 2, y + 2, 1, 1);
        ctx.fillRect(x + w - 3, y + 2, 1, 1);
        ctx.fillRect(x + w - 4, y + 2, 1, 1);
        ctx.fillRect(x + w - 1, y + 3, 1, 1);
        ctx.fillRect(x + w - 2, y + 3, 1, 1);
        ctx.fillRect(x + w - 3, y + 3, 1, 1);
        ctx.fillRect(x + w - 4, y + 3, 1, 1);
    };

    // drawTextInputBox(x, y, w, h, bg, fg)
    // Text input box with rounded top corners (r=4)
    // Three-sided border: top, left, right (no bottom, connects to keyboard)
    FlipCanvas.prototype.drawTextInputBox = function(x, y, w, h, bg, fg) {
        var R = 4;
        var ctx = this.ctx;

        // ── Fill ──────────────────────────────────────────────────────────────
        ctx.fillStyle = bg;

        // Main rectangles for rounded top corners
        ctx.fillRect(x + R, y, w - R * 2, h);           // center column (full height)
        ctx.fillRect(x, y + R, R, h - R);               // left edge
        ctx.fillRect(x + w - R, y + R, R, h - R);       // right edge

        // Top-left corner pixels (r=4)
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 3, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x + 2, y + 2, 1, 1);
        ctx.fillRect(x + 3, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);
        ctx.fillRect(x + 1, y + 3, 1, 1);
        ctx.fillRect(x + 2, y + 3, 1, 1);
        ctx.fillRect(x + 3, y + 3, 1, 1);

        // Top-right corner pixels (mirror of top-left)
        ctx.fillRect(x + w - 4, y, 1, 1);
        ctx.fillRect(x + w - 3, y + 1, 1, 1);
        ctx.fillRect(x + w - 4, y + 1, 1, 1);
        ctx.fillRect(x + w - 2, y + 2, 1, 1);
        ctx.fillRect(x + w - 3, y + 2, 1, 1);
        ctx.fillRect(x + w - 4, y + 2, 1, 1);
        ctx.fillRect(x + w - 1, y + 3, 1, 1);
        ctx.fillRect(x + w - 2, y + 3, 1, 1);
        ctx.fillRect(x + w - 3, y + 3, 1, 1);
        ctx.fillRect(x + w - 4, y + 3, 1, 1);

        // ── Border ────────────────────────────────────────────────────────────
        ctx.fillStyle = fg;

        // Top-left corner outline (r=4)
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);

        // Top edge
        ctx.fillRect(x + 4, y, w - 8, 1);

        // Top-right corner outline (r=4)
        ctx.fillRect(x + w - 4, y, 1, 1);
        ctx.fillRect(x + w - 3, y + 1, 1, 1);
        ctx.fillRect(x + w - 2, y + 2, 1, 1);
        ctx.fillRect(x + w - 1, y + 3, 1, 1);

        // Right edge
        ctx.fillRect(x + w - 1, y + 4, 1, h - 4);

        // Left edge
        ctx.fillRect(x, y + 4, 1, h - 4);
    };

    // drawKeyboard(x, y, rows, selectedRow, selectedCol, pressedRow, pressedCol, bg, fg)
    // Renders a virtual keyboard popup with rounded corners (r=4)
    // rows: array of arrays of characters (e.g., [['q','w','e',...], [...], ...])
    // selectedRow, selectedCol: current selection position
    // pressedRow, pressedCol: button currently pressed (-1 if none)
    // bg: background color, fg: border/text color
    // peekWave: optional dock-style wave state for the peek row:
    //   { center: <float col>, amp: <0..1> }
    // When set, every peek cell at column c renders with a
    // distance-based lift: cells near `center` rise toward the
    // selected POPPED position, neighbours sit progressively
    // lower, and faraway cells stay at the folded resting tab.
    // `amp` scales the whole lift (0 = all cells folded, 1 =
    // fully extended wave). The owning Keyboard component eases
    // `center` and `amp` over time so transitions read as smooth
    // ripples instead of snaps.
    FlipCanvas.prototype.drawKeyboard = function(x, y, rows, selectedRow, selectedCol, pressedRow, pressedCol, bg, fg, shiftState, langLabel, peekWave, focused, betweenCellsAndSelector) {
        var BTN_W = 15;
        var BTN_H = 16;
        var BTN_GAP = 0;  // No gap between buttons
        var SPACE_W = 35;  // Width of space button
        var SHIFT_W = 35;  // Width of shift button (matches space)
        var LANG_W  = 35;  // Width of language-switcher button (matches shift)
        // Sentinel for the shift key in `rows`. ⇧ is the unicode
        // upward-pointing white arrow — distinct from any character
        // a normal alphabetic layout might want to insert.
        var SHIFT_CHAR = '⇧';
        // Sentinel for the language-switcher key. Lives in the
        // private-use area so it can't collide with any character
        // a layout might legitimately want to type. drawKeyboard
        // recognises it at col 0 of the SECOND-TO-LAST row (the
        // slot directly above the shift cell) and paints
        // `Icons.keyboard_lang` instead of a glyph.
        var LANG_CHAR  = '⌘';
        var R = 4;
        var CONTAINER_W = 250;
        var CONTAINER_H = 77;
        var ctx = this.ctx;
        var self = this;

        // Normalise a cell from `rows`. Each entry can be either:
        //   - A string  (single char): legacy form. Width / icon
        //                              flags are inferred from
        //                              the sentinel char + position
        //                              (shift / lang / space).
        //   - An object {text, wide?, isShift?, isLang?, isSpace?}:
        //                              callers can mark any cell
        //                              wide and supply arbitrary
        //                              display text, used by the
        //                              symbol layout for keys like
        //                              wide '_' / '<>|' / '.' that
        //                              don't carry shift / lang /
        //                              space behaviour.
        function cellOf(rowIdx, colIdx) {
            var raw = rows[rowIdx][colIdx];
            if (raw && typeof raw === 'object') {
                return {
                    text:           raw.text != null ? raw.text : '',
                    wide:           !!raw.wide,
                    isShift:        !!raw.isShift,
                    isLang:         !!raw.isLang,
                    isSpace:        !!raw.isSpace,
                    isBackspace:    !!raw.isBackspace,
                    isReturn:       !!raw.isReturn,
                    isKeyboardUp:   !!raw.isKeyboardUp,
                    isKeyboardDown: !!raw.isKeyboardDown,
                    peek:           !!raw.peek
                };
            }
            var lastRow      = (rowIdx === rows.length - 1);
            var aboveLastRow = (rowIdx === rows.length - 2);
            var lastCol      = (colIdx === rows[rowIdx].length - 1);
            var isShift = lastRow      && colIdx === 0 && raw === SHIFT_CHAR;
            var isLang  = aboveLastRow && colIdx === 0 && raw === LANG_CHAR;
            var isSpace = lastRow      && lastCol      && raw === ' ';
            return {
                text:           raw,
                wide:           isShift || isLang || isSpace,
                isShift:        isShift,
                isLang:         isLang,
                isSpace:        isSpace,
                isBackspace:    false,
                isReturn:       false,
                isKeyboardUp:   false,
                isKeyboardDown: false,
                peek:           false
            };
        }

        // Peek row detection. Row 0 becomes a "peek row" when its
        // first cell is flagged `peek: true`. The whole row then
        // renders ABOVE the keyboard chrome — only the top few
        // pixels of each cell are visible (a tab poking up),
        // and the row's contents don't take up vertical space
        // in the chrome. Selecting a peek cell pops it open
        // fully so the digit (or whatever the cell carries)
        // becomes readable.
        var hasPeekRow = rows.length > 0
            && rows[0].length > 0
            && cellOf(0, 0).peek;
        var peekOffset    = hasPeekRow ? 1 : 0;
        // Height of the tab that peeks above the QWERTY row
        // when a peek-row cell is at rest. The cell itself
        // stays 16 px tall — it just sits low so the bottom
        // 14 px tuck behind the chrome's first row. 2 px gives
        // a thin, deliberate hint without competing with the
        // glyphs underneath.
        var PEEK_VISIBLE_H = 2;

        function btnWidthAt(rowIdx, colIdx) {
            return cellOf(rowIdx, colIdx).wide ? SHIFT_W : BTN_W;
        }
        // Width of a row's leading wide key. Used to align the
        // alphabetic columns across all rows: rows without a
        // leading wide key are padded left by `maxLeadingWide`, so
        // e.g. Q sits over A which sits over Z even though Z is
        // preceded by shift and A is preceded by the language key.
        function rowLeadingWideWidth(rowIdx) {
            var rk = rows[rowIdx];
            if (!rk || rk.length === 0) return 0;
            return cellOf(rowIdx, 0).wide ? SHIFT_W : 0;
        }
        var maxLeadingWide = 0;
        for (var lwRow = 0; lwRow < rows.length; lwRow++) {
            var lw = rowLeadingWideWidth(lwRow);
            if (lw > maxLeadingWide) maxLeadingWide = lw;
        }
        function rowLeftOffset(rowIdx) {
            return maxLeadingWide - rowLeadingWideWidth(rowIdx);
        }
        function rowPixelWidth(rowIdx) {
            var rk = rows[rowIdx];
            var total = rowLeftOffset(rowIdx);
            for (var c = 0; c < rk.length; c++) total += btnWidthAt(rowIdx, c);
            return total;
        }

        // Three shift states with distinct icons:
        //   'off'    → unpressed arrow (default chrome)
        //   'shift'  → pressed arrow (one-shot, next letter capped)
        //   'caps'   → caps-lock variant (latched, all letters capped)
        // While shiftState !== 'off' alphabetic glyphs render uppercase
        // so the keyboard's visual state matches what onChar emits.
        var shiftActive = (shiftState && shiftState !== 'off');
        function shiftIconFor(state) {
            if (state === 'caps')  return Icons.keyboard_caps_lock_pressed;
            if (state === 'shift') return Icons.keyboard_shift_pressed;
            return Icons.keyboard_shift_unpressed || Icons.keyboard_shift;
        }

        // Centre either the shift icon, the language-switcher icon,
        // or a (possibly multi-char) text label inside a button.
        function paintContent(cell, bx, by, bw, color) {
            if (cell.isShift) {
                var sIcon = shiftIconFor(shiftState);
                var sIx = bx + Math.floor((bw - sIcon.w) / 2);
                var sIy = by + Math.floor((BTN_H - sIcon.h) / 2);
                if (sIcon.grayscale) self.drawSprite(sIcon, sIx, sIy, color);
                else                  self.drawIcon(sIcon, sIx, sIy, color);
                return;
            }
            if (cell.isLang) {
                var lIcon = Icons.keyboard_lang;
                var lIx = bx + Math.floor((bw - lIcon.w) / 2);
                var lIy = by + Math.floor((BTN_H - lIcon.h) / 2);
                if (lIcon.grayscale) self.drawSprite(lIcon, lIx, lIy, color);
                else                  self.drawIcon(lIcon, lIx, lIy, color);
                return;
            }
            if (cell.isBackspace) {
                // Wide key — same dimensions as space/shift —
                // carrying the backspace glyph. Icons.backspace
                // is 15 × 7 grayscale; centred inside the cell,
                // then nudged 1 px left to balance against the
                // cell's right-edge padding (the icon's own
                // pixel mass leans right of geometric centre).
                var bIcon = Icons.backspace;
                if (bIcon) {
                    var bIx = bx + Math.floor((bw - bIcon.w) / 2) - 1;
                    var bIy = by + Math.floor((BTN_H - bIcon.h) / 2);
                    if (bIcon.grayscale) self.drawSprite(bIcon, bIx, bIy, color);
                    else                  self.drawIcon(bIcon, bIx, bIy, color);
                }
                return;
            }
            if (cell.isReturn) {
                // Wide key carrying the literal label "return".
                // No dedicated icon yet — text in the standard
                // keyboard font reads cleanly enough at SHIFT_W
                // (35 px). Centred inside the cell.
                var rTxt = 'return';
                var rW = HaxrCorp4090FlipCTL.textWidth(rTxt);
                var rX = bx + Math.floor((bw - rW) / 2);
                var rY = by + 2;
                HaxrCorp4090FlipCTL.draw(ctx, rTxt, rX, rY, color);
                return;
            }
            if (cell.isKeyboardUp || cell.isKeyboardDown) {
                // Form-navigation arrow cells. Icon is centred
                // inside the wide cell; behaviour (caret to
                // previous/next field) will be wired later.
                var navIcon = cell.isKeyboardUp ? Icons.keyboard_up : Icons.keyboard_down;
                if (navIcon) {
                    var nIx = bx + Math.floor((bw - navIcon.w) / 2);
                    var nIy = by + Math.floor((BTN_H - navIcon.h) / 2);
                    if (navIcon.grayscale) self.drawSprite(navIcon, nIx, nIy, color);
                    else                    self.drawIcon(navIcon, nIx, nIy, color);
                }
                return;
            }
            if (cell.isSpace) {
                // Wide bar gets a `]` glyph rotated 90° CW —
                // the resulting horizontal bracket reads as a
                // "this is a wide key" affordance without
                // needing a dedicated icon. 90° is an exact
                // axis swap, so the per-pixel fillRects from
                // HaxrCorp4090FlipCTL.draw will land cleanly on
                // integer pixel boundaries — provided the
                // rotation centre itself is an integer.
                // `bw / 2` is 17.5 (SHIFT_W = 35), which
                // produced sub-pixel antialiasing blur on every
                // glyph pixel; Math.floor on both axes pins the
                // translation to a whole-pixel origin and the
                // rotated rects stay crisp.
                var rcx = bx + Math.floor(bw / 2);
                var rcy = by + Math.floor(BTN_H / 2);
                var spSym = ']';
                var spSymW = HaxrCorp4090FlipCTL.textWidth(spSym);
                var spSymH = 11;                      // font cap height
                ctx.save();
                ctx.translate(rcx, rcy);
                ctx.rotate(Math.PI / 2);
                HaxrCorp4090FlipCTL.draw(ctx, spSym,
                    -Math.floor(spSymW / 2),
                    -Math.floor(spSymH / 2),
                    color);
                ctx.restore();
                return;
            }
            var t = cell.text;
            if (t === '' || t === ' ' || t == null) return;
            // Single-letter cells get the shift-aware uppercasing.
            // Multi-char labels (e.g. the SYM layout's "<>|") are
            // never letters, so the comparison naturally skips them.
            var displayCh = (shiftActive && t.length === 1 && t >= 'a' && t <= 'z')
                ? t.toUpperCase() : t;
            var cw = HaxrCorp4090FlipCTL.textWidth(displayCh);
            var cx = bx + Math.floor((bw - cw) / 2);
            var cy = by + 2;
            HaxrCorp4090FlipCTL.draw(ctx, displayCh, cx, cy, color);
        }

        // Calculate keyboard dimensions — pick the widest row.
        var cols = rows[0].length;
        var maxRowWidth = 0;
        for (var rr = 0; rr < rows.length; rr++) {
            var rw = rowPixelWidth(rr);
            if (rw > maxRowWidth) maxRowWidth = rw;
        }
        var keyboardW = maxRowWidth;
        // Chrome height excludes the peek row — peek cells live
        // above the chrome, not inside it. Without this the
        // background rectangle would be one row taller than the
        // visible normal rows.
        var keyboardH = (rows.length - peekOffset) * BTN_H;

        // Position keyboard: 5px from top, 4px from right edge of container
        // Centre the keyboard horizontally inside the container.
        // (Was right-anchored 4 px from the right edge before; the
        // new layout has wide shift + space keys flanking the
        // bottom row, so a centred placement reads cleaner and the
        // empty area to the right of the top rows naturally hosts
        // the Delete affordance.)
        var keyboardX = x + Math.floor((CONTAINER_W - keyboardW) / 2);
        var keyboardY = y + 5;

        // Draw container background with r=4 corners
        ctx.fillStyle = bg;
        this.drawRoundRect(x, y, CONTAINER_W, CONTAINER_H, 4, bg);

        // Draw container border (top, left, right only - no bottom border)
        ctx.fillStyle = fg;
        // Top edge with corners
        ctx.fillRect(x + 4, y, CONTAINER_W - 8, 1);
        // Left edge (straight)
        ctx.fillRect(x, y + 4, 1, CONTAINER_H - 4);
        // Right edge (straight)
        ctx.fillRect(x + CONTAINER_W - 1, y + 4, 1, CONTAINER_H - 4);
        // TL corner outline
        ctx.fillRect(x + 3, y, 1, 1);
        ctx.fillRect(x + 2, y + 1, 1, 1);
        ctx.fillRect(x + 1, y + 2, 1, 1);
        ctx.fillRect(x, y + 3, 1, 1);
        // TR corner outline
        ctx.fillRect(x + CONTAINER_W - 4, y, 1, 1);
        ctx.fillRect(x + CONTAINER_W - 3, y + 1, 1, 1);
        ctx.fillRect(x + CONTAINER_W - 2, y + 2, 1, 1);
        ctx.fillRect(x + CONTAINER_W - 1, y + 3, 1, 1);

        // Draw keyboard background with r=4 corners (TL/TR/BR rounded, BL square)
        ctx.fillStyle = bg;

        // Background rectangles (keyboard inside container)
        ctx.fillRect(keyboardX + R, keyboardY, keyboardW - R * 2, keyboardH);
        ctx.fillRect(keyboardX, keyboardY + R, R, keyboardH - R);
        ctx.fillRect(keyboardX + keyboardW - R, keyboardY + R, R, keyboardH - R * 2);

        // Corner fill pixels (r=4)
        // TL corner
        ctx.fillRect(keyboardX + 3, keyboardY, 1, 1);
        ctx.fillRect(keyboardX + 2, keyboardY + 1, 1, 1);
        ctx.fillRect(keyboardX + 3, keyboardY + 1, 1, 1);
        ctx.fillRect(keyboardX + 1, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX + 2, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX + 3, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + 1, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + 2, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + 3, keyboardY + 3, 1, 1);

        // TR corner
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + 1, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + 1, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 2, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + 2, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 1, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 2, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + 3, 1, 1);

        // BR corner
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + keyboardH - 4, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + keyboardH - 4, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 2, keyboardY + keyboardH - 4, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 1, keyboardY + keyboardH - 4, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + keyboardH - 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + keyboardH - 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 2, keyboardY + keyboardH - 3, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + keyboardH - 2, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 3, keyboardY + keyboardH - 2, 1, 1);
        ctx.fillRect(keyboardX + keyboardW - 4, keyboardY + keyboardH - 1, 1, 1);

        // Draw border and buttons
        ctx.fillStyle = fg;

        // Selected button is deferred to a second pass after the
        // main loop. Its 2-px frame extends 1 px OUTSIDE the
        // button's bounds, and any neighbour drawn after it (next
        // column on the right, next row below) would otherwise
        // overdraw those outer-ring pixels. We record its geometry
        // here and re-render it on top once every other key has
        // been painted.
        var selBtn = null;

        // Draw each button.
        for (var row = 0; row < rows.length; row++) {
            var rowKeys = rows[row];
            // Rows without a leading wide key are padded left so
            // their first key aligns column-wise with the bottom
            // row's first letter (i.e., Q sits over A sits over Z).
            var btnX = keyboardX + rowLeftOffset(row);
            // Peek row (row 0 when hasPeekRow) sits ABOVE the
            // chrome. Two positions, picked by selection state
            // (per-cell, computed inside the inner col loop
            // below):
            //   • RESTING peek — `btnY = keyboardY - PEEK_VISIBLE_H`.
            //     Cell extends down INTO the QWERTY row, which
            //     draws over it later in the loop. Net visible
            //     surface: a thin tab (top PEEK_VISIBLE_H px)
            //     poking out above the chrome.
            //   • SELECTED peek — `btnY = keyboardY - BTN_H`.
            //     Cell sits fully above the chrome so it's
            //     entirely visible.
            // The non-peek rows still anchor at the same Y as
            // before (peekOffset shifts them up by one slot so
            // QWERTY stays where it would be without the peek).
            var isPeekRow = hasPeekRow && row === 0;
            var btnY;
            if (!isPeekRow) {
                btnY = keyboardY + (row - peekOffset) * BTN_H;
            }
            // (`btnY` for peek-row cells is set inside the col
            // loop because it depends on per-cell `isSelected`.)
            for (var col = 0; col < rowKeys.length; col++) {
                var rawCell = rowKeys[col];
                // Empty slot in a peek row (null / undefined) —
                // no cell to render, no pixel cost. Lets the
                // layout carry sparse peek rows (e.g. '1' above
                // 'q' only) without painting tabs over every
                // column.
                if (rawCell == null) continue;
                var cell = cellOf(row, col);
                var btnW = cell.wide ? SHIFT_W : BTN_W;

                var isSelected = (row === selectedRow && col === selectedCol);
                var isPressed  = (row === pressedRow && col === pressedCol);
                // Filled-black look fires only on the brief press
                // flash. State indicators (shift mode, caps lock)
                // are conveyed by which icon paints — chrome stays
                // the standard light-gray frame at rest.
                var isFilled   = isPressed;

                // Peek-row cells render in one of two modes:
                //
                //   RESTING — only the top PEEK_VISIBLE_H px
                //   of the cell is visible (a tab poking up
                //   above the chrome). We clip to that sliver
                //   and paint bg + rounded-corner border into
                //   it. Nothing else from the cell (sides,
                //   bottom, glyph) renders, so there's no
                //   leakage through the unfilled QWERTY keys
                //   below.
                //
                //   SELECTED — the cell rises so its entire
                //   16 px height sits ABOVE the chrome. Fill
                //   bg here too so the cell is opaque against
                //   whatever's above the keyboard, then fall
                //   through to the normal selected-cell path
                //   below for the border + glyph + deferred
                //   2-px black selector frame.
                if (isPeekRow) {
                    // Anchor positions the wave interpolates
                    // between:
                    //   POPPED  — fully-extended (selected) cell.
                    //             Sits 1 px below Q's top so it
                    //             overlaps the chrome by a pixel.
                    //   FOLDED  — resting tab. Lifted 1 px above
                    //             Q's top for visual breathing
                    //             space; Q's white-filled cell in
                    //             row 1 overdraws everything from
                    //             its top edge down so only the
                    //             top tab shows.
                    var PEEK_LIFT_FOLDED = 1;
                    // POPPED sits with its bottom edge flush at
                    // Q's top (raised 1 px from its previous
                    // "overlaps Q by 1 px" position so the
                    // fully-extended number row reads as floating
                    // just above the chrome). FOLDED still sits 1
                    // px above Q for breathing space. LIFT_RANGE
                    // grows to 13 px, but the per-neighbour
                    // PEEK_FALLOFF_PX of 2 px is unchanged — the
                    // dock-shape spacing stays the same, only the
                    // peak of the wave moves up.
                    var POPPED_BTN_Y = keyboardY - BTN_H;
                    var FOLDED_BTN_Y = keyboardY - PEEK_VISIBLE_H - PEEK_LIFT_FOLDED;
                    var LIFT_RANGE   = FOLDED_BTN_Y - POPPED_BTN_Y; // px; > 0
                    // Dock-style wave: every cell's lift falls off
                    // PEEK_FALLOFF_PX per column of distance from
                    // the centre. At d=0 the cell is fully
                    // extended; once d * falloff exceeds the lift
                    // range the cell rests at FOLDED. Amplitude
                    // scales the whole lift uniformly so the wave
                    // can fade in / out without any cell ever
                    // overshooting its anchor points.
                    var PEEK_FALLOFF_PX = 2;
                    var waveCenter = (peekWave && peekWave.center != null) ? peekWave.center : 0;
                    var waveAmp    = (peekWave && peekWave.amp    != null) ? peekWave.amp    : 0;
                    var dist = Math.abs(col - waveCenter);
                    var rawLift = LIFT_RANGE - dist * PEEK_FALLOFF_PX;
                    if (rawLift < 0) rawLift = 0;
                    var lift = Math.round(waveAmp * rawLift);
                    btnY = FOLDED_BTN_Y - lift;
                    // Peek cells are self-contained: render bg
                    // fill (or filled-black if pressed), gray
                    // frame, then the digit clipped to the
                    // visible region above Q. The clip strips off
                    // any pixels at y >= keyboardY - 1 — those
                    // would otherwise poke a sliver of the digit
                    // above Q's top edge for cells sitting low in
                    // the wave. Effect: each cell's number fades
                    // out cleanly as its card sinks behind Q.
                    var peekFilled    = isFilled;
                    var peekBg        = peekFilled ? '#000' : bg;
                    var peekTextColor = peekFilled ? '#fff' : '#000';
                    this.drawRoundRect(btnX, btnY, btnW, BTN_H, 2, peekBg);
                    if (!peekFilled) {
                        this.drawRoundFrame(btnX, btnY, btnW, BTN_H, 2, '#CCCCCC');
                    }
                    var contentClipH = (keyboardY - 1) - btnY;
                    if (contentClipH > 0) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(btnX, btnY, btnW, contentClipH);
                        ctx.clip();
                        paintContent(cell, btnX, btnY, btnW, peekTextColor);
                        ctx.restore();
                    }
                    if (isSelected) {
                        // Mark for the deferred second-pass black
                        // selector frame at the wave-computed y.
                        selBtn = {
                            x: btnX, y: btnY, w: btnW,
                            cell: cell, isFilled: peekFilled
                        };
                    }
                    btnX += btnW;
                    continue;
                }

                if (isSelected) {
                    // Defer the 2-px black frame to a second pass,
                    // but paint the underlying button look now so
                    // the slot isn't blank if rendering aborts.
                    if (isFilled) {
                        this.drawRoundRect(btnX, btnY, btnW, BTN_H, 2, '#000');
                        paintContent(cell, btnX, btnY, btnW, '#fff');
                    } else {
                        // Fill bg first so any earlier render (e.g.
                        // a peek card extending down into this
                        // row's footprint) is hidden — the cell
                        // reads as a self-contained tile rather
                        // than letting siblings bleed through its
                        // empty interior.
                        this.drawRoundRect(btnX, btnY, btnW, BTN_H, 2, bg);
                        this.drawRoundFrame(btnX, btnY, btnW, BTN_H, 2, '#CCCCCC');
                        paintContent(cell, btnX, btnY, btnW, '#000');
                    }
                    selBtn = { x: btnX, y: btnY, w: btnW, cell: cell, isFilled: isFilled };
                } else if (isFilled) {
                    // Pressed (transient): filled black background
                    // with white glyph/icon.
                    this.drawRoundRect(btnX, btnY, btnW, BTN_H, 2, '#000');
                    paintContent(cell, btnX, btnY, btnW, '#fff');
                } else {
                    // Default light-gray frame. Fill bg first so
                    // anything drawn earlier in the pass (notably
                    // the peek-row card extending down behind this
                    // cell) is hidden inside the rounded border —
                    // the visible 3-px tab above stays, the body
                    // disappears cleanly.
                    this.drawRoundRect(btnX, btnY, btnW, BTN_H, 2, bg);
                    this.drawRoundFrame(btnX, btnY, btnW, BTN_H, 2, '#CCCCCC');
                    paintContent(cell, btnX, btnY, btnW, '#000');
                }

                btnX += btnW;
            }
        }

        // ── Interlayer hook ──────────────────────────────────────
        // The owning scene may want to paint additional UI on top
        // of the keyboard cells but UNDER the selector frame — for
        // example, a tab button (123) that sits below the bottom
        // QWERTY row. Running it here keeps the selector visually
        // in front of those overlays without forcing the scene to
        // re-render the keyboard twice.
        if (typeof betweenCellsAndSelector === 'function') {
            betweenCellsAndSelector();
        }

        // ── Selected-button second pass ──────────────────────────
        // Now that every other key is painted, layer the 2-px
        // black frame over the selected one. The outer ring (r=3,
        // expanded by 1 px) overdraws any neighbour pixels that
        // touched the outer-ring columns/rows; the inner ring
        // (r=2, at button bounds) overdraws the first-pass gray
        // (or filled black) with black. Then re-paint the
        // content — colour follows the underlying state so a
        // selected shift-on key keeps its white icon, a selected
        // letter shows its black glyph.
        // Skip the selector pass entirely when the keyboard is
        // defocused — the owning scene has handed focus elsewhere
        // (e.g., to the 123 tab button) and the selected cell
        // should read as inactive until focus returns.
        if (selBtn && focused !== false) {
            this.drawRoundFrame(selBtn.x - 1, selBtn.y - 1, selBtn.w + 2, BTN_H + 2, 3, '#000');
            this.drawRoundFrame(selBtn.x,     selBtn.y,     selBtn.w,     BTN_H,     2, '#000');
            paintContent(selBtn.cell,
                         selBtn.x, selBtn.y, selBtn.w,
                         selBtn.isFilled ? '#fff' : '#000');
        }

        // ── Layout indicator ─────────────────────────────────────
        // Gray label in the top-row left-pad area, directly above
        // the wide cell at row [last-1][0]. The text is supplied
        // by the caller via `langLabel` ('EN' for the alphabet
        // layout, '123' for the symbol layout, etc.) — drawKeyboard
        // doesn't try to infer it. Drawn only when row[last-1] has
        // a wide cell (i.e., there's somewhere to anchor).
        if (langLabel && rows.length >= 2 && cellOf(rows.length - 2, 0).wide) {
            var llW = HaxrCorp4090FlipCTL.textWidth(langLabel);
            var llX = keyboardX + Math.floor((LANG_W - llW) / 2);
            // Same y offset glyphs use inside button cells (btnY +
            // 2) so the label optically sits at the row's natural
            // text baseline.
            var llY = keyboardY + 2;
            HaxrCorp4090FlipCTL.draw(ctx, langLabel, llX, llY, '#888888');
        }

        // (Removed: "Delete" label + back-icon affordance that
        // used to sit just past the top row's right edge. The
        // backspace keystroke still works — `Keyboard.handleInput`
        // routes the `back` action to `onChar('\b')` — we just
        // don't paint the icon hint any more.)
    };

    // drawCursor(x, y, width, height, color)
    // Draws a blinking text cursor (vertical line)
    FlipCanvas.prototype.drawCursor = function(x, y, w, h, color) {
        this.ctx.fillStyle = color || '#000';
        this.ctx.fillRect(x, y, w, h);
    };

    // drawIcon(icon, x, y, color)
    // Draws a bitmap icon (from icons.js)
    // icon: {w: width, h: height, d: [hex values]}
    FlipCanvas.prototype.drawIcon = function(icon, x, y, color) {
        if (!icon || !icon.d) return;

        var ctx = this.ctx;
        ctx.fillStyle = color || '#000';

        for (var row = 0; row < icon.h; row++) {
            var hexValue = icon.d[row];
            if (hexValue === undefined) continue;

            // Convert hex to binary and draw pixels
            var bits = hexValue.toString(2).padStart(icon.w, '0');
            for (var col = 0; col < icon.w && col < bits.length; col++) {
                if (bits[col] === '1') {
                    ctx.fillRect(x + col, y + row, 1, 1);
                }
            }
        }
    };

    // drawSprite(sprite, x, y, color)
    // Draws a large sprite with support for grayscale (from sprites.js)
    // Binary sprite: {w: width, h: height, d: [hex values]}
    // Grayscale sprite: {w: width, h: height, bitsPerPixel: 6, grayscale: true, d: [...]}
    // `alphaScale` (optional, default 1) uniformly fades the whole
    // sprite — used for effects like the status-bar recording pulse.
    // Only honoured by the grayscale path (the only place that needs it).
    FlipCanvas.prototype.drawSprite = function(sprite, x, y, color, alphaScale) {
        if (!sprite || !sprite.d) return;

        var ctx = this.ctx;

        if (sprite.grayscale && sprite.bitsPerPixel === 6) {
            // 6-bit grayscale sprite (64 levels)
            this._drawGrayscaleSprite(sprite, x, y, color, 0, alphaScale);
        } else {
            // Binary (1-bit) sprite
            this._drawBinarySprite(sprite, x, y, color);
        }
    };

    // drawSpriteRotated(sprite, x, y, color, turns)
    // Like drawSprite (6-bit grayscale path) but rotated by `turns`
    // clockwise quarter-turns (0..3). 90° multiples are a pure index
    // remap — each source pixel maps exactly to one dest pixel, so
    // there are no sub-pixel/anti-aliasing artifacts (unlike a
    // ctx.rotate). (x, y) is the top-left of the rotated bounding box;
    // for a square sprite that's the same box as the unrotated draw.
    FlipCanvas.prototype.drawSpriteRotated = function(sprite, x, y, color, turns) {
        if (!sprite || !sprite.d) return;
        turns = (((turns || 0) % 4) + 4) % 4;
        if (turns === 0 || !sprite.grayscale || sprite.bitsPerPixel !== 6) {
            // No rotation (or unsupported format) → defer to drawSprite.
            this.drawSprite(sprite, x, y, color);
            return;
        }
        var ctx = this.ctx;
        color = color || '#000';
        var w = sprite.w, h = sprite.h;
        var dataIndex = 0;
        for (var row = 0; row < h; row++) {
            for (var col = 0; col < w; col += 4) {
                var b0 = sprite.d[dataIndex]     || 0;
                var b1 = sprite.d[dataIndex + 1] || 0;
                var b2 = sprite.d[dataIndex + 2] || 0;
                dataIndex += 3;
                var pix = [
                    (b0 >> 2) & 0x3F,
                    (((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)) & 0x3F,
                    (((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)) & 0x3F,
                    b2 & 0x3F
                ];
                for (var i = 0; i < 4 && col + i < w; i++) {
                    var opacity = (63 - pix[i]) / 63;
                    if (opacity <= 0.01) continue;  // transparent
                    var c = col + i, r = row, dx, dy;
                    if (turns === 1)      { dx = h - 1 - r; dy = c; }            // 90° CW
                    else if (turns === 2) { dx = w - 1 - c; dy = h - 1 - r; }    // 180°
                    else                  { dx = r;         dy = w - 1 - c; }    // 270° CW
                    ctx.globalAlpha = opacity;
                    ctx.fillStyle = color;
                    ctx.fillRect(x + dx, y + dy, 1, 1);
                    ctx.globalAlpha = 1.0;
                }
            }
        }
    };

    // Paint a 6-bit grayscale sprite using the pixel's own grayscale
    // value as the output color (0 = black, 62 = near-white, etc.).
    // Value 63 is the transparency sentinel and is skipped, so this is
    // suitable for overlays where the canvas underneath must remain
    // visible around the icon.
    FlipCanvas.prototype.drawSpriteLiteral = function(sprite, x, y) {
        if (!sprite || !sprite.d) return;
        if (!sprite.grayscale || sprite.bitsPerPixel !== 6) return;

        var ctx = this.ctx;
        var dataIndex = 0;

        for (var row = 0; row < sprite.h; row++) {
            for (var col = 0; col < sprite.w; col += 4) {
                var b0 = sprite.d[dataIndex]     || 0;
                var b1 = sprite.d[dataIndex + 1] || 0;
                var b2 = sprite.d[dataIndex + 2] || 0;
                dataIndex += 3;

                var pixels = [
                    (b0 >> 2) & 0x3F,
                    (((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)) & 0x3F,
                    (((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)) & 0x3F,
                    b2 & 0x3F
                ];

                for (var i = 0; i < 4 && col + i < sprite.w; i++) {
                    var g = pixels[i];
                    if (g >= 63) continue;  // transparent sentinel
                    var v = Math.round((g / 63) * 255);
                    ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
                    ctx.fillRect(x + col + i, y + row, 1, 1);
                }
            }
        }
    };

    // Draw a single frame of a vertically-stacked sprite strip. The strip
    // describes frame count via `frames`; each frame occupies h/frames rows.
    FlipCanvas.prototype.drawSpriteFrame = function(sprite, x, y, frameIndex, color) {
        if (!sprite || !sprite.d) return;
        var frames = sprite.frames || 1;
        var frameH = Math.floor(sprite.h / frames);
        if (frameIndex < 0) frameIndex = 0;
        if (frameIndex >= frames) frameIndex = frames - 1;

        // Grayscale rows are consumed 3 bytes per 4-pixel group by the
        // renderer below, so each row occupies ceil(w/4)*3 bytes — not
        // the packed-bits figure ceil(w*6/8), which is smaller when w
        // isn't a multiple of 4 (e.g. w=14 gives 12 vs 11).
        var bytesPerRow = (sprite.grayscale && sprite.bitsPerPixel === 6)
            ? Math.ceil(sprite.w / 4) * 3
            : Math.ceil(sprite.w / 8);

        var offset = frameIndex * frameH * bytesPerRow;
        var view = {
            w: sprite.w,
            h: frameH,
            bitsPerPixel: sprite.bitsPerPixel,
            grayscale: sprite.grayscale,
            d: sprite.d
        };

        if (view.grayscale && view.bitsPerPixel === 6) {
            this._drawGrayscaleSprite(view, x, y, color, offset);
        } else {
            this._drawBinarySprite(view, x, y, color, offset);
        }
    };

    FlipCanvas.prototype._drawBinarySprite = function(sprite, x, y, color, dataOffset) {
        var ctx = this.ctx;
        ctx.fillStyle = color || '#000';

        var bytesPerRow = Math.ceil(sprite.w / 8);
        var baseIndex = dataOffset || 0;

        for (var row = 0; row < sprite.h; row++) {
            var dataIndex = baseIndex + row * bytesPerRow;
            var bitPos = 0;

            for (var byteIdx = 0; byteIdx < bytesPerRow && bitPos < sprite.w; byteIdx++) {
                var hexValue = sprite.d[dataIndex + byteIdx];
                if (hexValue === undefined) break;

                for (var bit = 7; bit >= 0 && bitPos < sprite.w; bit--) {
                    var isBitSet = (hexValue >> bit) & 1;
                    if (isBitSet === 1) {
                        ctx.fillRect(x + bitPos, y + row, 1, 1);
                    }
                    bitPos++;
                }
            }
        }
    };

    FlipCanvas.prototype._drawGrayscaleSprite = function(sprite, x, y, color, dataOffset, alphaScale) {
        var ctx = this.ctx;
        color = color || '#000';
        if (typeof alphaScale !== 'number') alphaScale = 1;

        // Unpack 6-bit grayscale values (4 pixels per 3 bytes)
        var bytesPerRow = Math.ceil((sprite.w * 6) / 8);
        var dataIndex = dataOffset || 0;

        for (var row = 0; row < sprite.h; row++) {
            for (var col = 0; col < sprite.w; col += 4) {
                // Get 3 bytes for 4 pixels
                var byte0 = sprite.d[dataIndex] || 0;
                var byte1 = sprite.d[dataIndex + 1] || 0;
                var byte2 = sprite.d[dataIndex + 2] || 0;
                dataIndex += 3;

                // Unpack 4 pixels (6 bits each)
                // byte0: pixel0[5:0] | pixel1[5:4]
                // byte1: pixel1[3:0] | pixel2[5:2]
                // byte2: pixel2[1:0] | pixel3[5:0]

                var pixel0 = (byte0 >> 2) & 0x3F;
                var pixel1 = (((byte0 & 0x03) << 4) | ((byte1 >> 4) & 0x0F)) & 0x3F;
                var pixel2 = (((byte1 & 0x0F) << 2) | ((byte2 >> 6) & 0x03)) & 0x3F;
                var pixel3 = byte2 & 0x3F;

                var pixels = [pixel0, pixel1, pixel2, pixel3];

                // Draw pixels
                for (var i = 0; i < 4 && col + i < sprite.w; i++) {
                    var grayValue = pixels[i];
                    // grayValue: 0=black, 63=white
                    // opacity: 0=white (transparent), 1=black (opaque)
                    var opacity = ((63 - grayValue) / 63) * alphaScale;

                    if (opacity > 0.01) {  // Skip nearly transparent pixels
                        ctx.globalAlpha = opacity;
                        ctx.fillStyle = color;
                        ctx.fillRect(x + col + i, y + row, 1, 1);
                        ctx.globalAlpha = 1.0;
                    }
                }
            }
        }
    };


    return FlipCanvas;
})();
