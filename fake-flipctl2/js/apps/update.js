/**
 * UpdateScene
 *
 * Settings → Update, MeshCore-style chrome: status bar + gray title
 * strip ("Update" in Sporty), with a small right-aligned status in
 * the strip — "N commits back" for the selected branch (or "Up to
 * date"). Below: a Branch picker row (MenuDropdownLine) and the list
 * of incoming commits for that branch.
 *
 * Branch picker:
 *   • the option list is whatever origin has — GET /api/update/branches
 *     (server runs `git ls-remote --heads origin`), refreshed on every
 *     enter();
 *   • OK opens the dropdown overlay (same wash / body / inner selector
 *     as Internet radio + Recorder); up/down move the highlight, the
 *     list scrolls when it has more rows than fit; OK commits, Back
 *     cancels;
 *   • left/right cycle the value inline without opening the overlay;
 *   • every change re-checks the commit delta for the chosen branch.
 *
 * Run (B) presses the bottom-right button, which is always on screen:
 * "Update" when the picker sits on the checked-out branch (pull),
 * "Switch" otherwise (checkout onto the fresh remote tip). Either way
 * the server restarts itself and the page reloads via the /api/version
 * watcher. The button is drawn disabled while a check is in flight.
 *
 * Progress texts ("Checking", "Updating", "Restarting") animate a
 * trailing 1 → 2 → 3 dot suffix; the fonts have no ellipsis glyph, so
 * truncated lines end in '..' like the boot menu does.
 */
var UpdateScene = (function() {
    var TITLE_H  = 16;
    var ROW_Y    = 33;               // Branch picker row top
    var LINE_H   = 11;               // commit list row pitch (Haxrcorp)
    var BTN_W    = 48;
    var DOTS_MS  = 400;              // progress-dots step

    // Page-level selector outline around the Branch row — same
    // geometry Internet radio uses for its settings rows.
    var SELECTOR_X = 2;
    var SELECTOR_W = 252;
    var SELECTOR_H = 15;

    // Dropdown overlay metrics — copied from the Recorder's port of
    // Internet radio's `_renderDropdown` so the three read identical.
    var DD_ITEM_H       = 13;
    var DD_DIV_H        = 1;
    var DD_BOTTOM_PAD   = 2;         // px kept free under the body

    function UpdateScene(sceneManager) {
        this.sceneManager    = sceneManager || null;
        this.displayName     = 'Update';
        this.breadcrumbTitle = 'Update';

        // 'checking' | 'ready' | 'updating' | 'done' | 'fail'
        this._state     = 'checking';
        this._branches  = [];        // names from /api/update/branches
        this._branchIdx = 0;         // selection in _branches
        this._branchesLoading = false;
        this._branchesErr     = null;
        this._current   = '';        // branch checked out on device
        this._commits   = [];
        this._commit    = '';        // current commit line
        this._error     = null;
        this._scroll    = 0;

        // Progress-dots ticker. Runs while the scene is on screen;
        // only asks for a repaint when something is in flight.
        this._dotsTick  = 0;
        this._dotsTimer = null;

        // Dropdown overlay state. `_ddScroll` is the index of the
        // first visible option when the list is taller than the
        // room under the chip.
        this._dropdownOpen  = false;
        this._dropdownIndex = 0;
        this._ddScroll      = 0;
        this._dropdownInnerSelector = new MenuSelectorFrame({
            x: 0, y: 0, width: 1, height: DD_ITEM_H + 2,
            anchorH: 'left', anchorV: 'top',
            strokeColor: '#000', showStroke: true, showFill: false
        });

        // Selector outline wrapping the Branch row — 1-px black
        // stroke, no fill, like Internet radio's row selector.
        this._selectorFrame = new MenuSelectorFrame({
            x: SELECTOR_X, y: ROW_Y,
            width: SELECTOR_W, height: SELECTOR_H,
            anchorH: 'left', anchorV: 'top',
            strokeColor: '#000', showStroke: true, showFill: false
        });

        this._updateBtn = new UI.RightButton('Update', BTN_W, 'run',
            function() { /* fired from handleInput */ });
    }

    UpdateScene.prototype.enter = function() {
        var self = this;
        this._dropdownOpen = false;
        this._loadBranches(false);
        this._check(null);
        if (this._dotsTimer) clearInterval(this._dotsTimer);
        this._dotsTimer = setInterval(function() {
            if (!self._isBusy() && !self._branchesLoading) return;
            self._dotsTick = (self._dotsTick + 1) % 3;
            rerender();
        }, DOTS_MS);
    };

    UpdateScene.prototype.exit = function() {
        if (this._dotsTimer) {
            clearInterval(this._dotsTimer);
            this._dotsTimer = null;
        }
    };

    function rerender() {
        if (window.requestRender) window.requestRender();
    }

    UpdateScene.prototype._isBusy = function() {
        return this._state === 'checking' || this._state === 'updating'
            || this._state === 'done';
    };

    // '.', '..', '...' — cycles with the ticker.
    UpdateScene.prototype._dots = function() {
        return ['.', '..', '...'][this._dotsTick];
    };

    // Name under the picker, or the checked-out branch while the
    // list is still loading / failed to load.
    UpdateScene.prototype._selectedBranch = function() {
        if (this._branches.length) return this._branches[this._branchIdx] || '';
        return this._current;
    };

    // Land the picker on `name` if the list has it.
    UpdateScene.prototype._seedSelection = function(name) {
        var i = this._branches.indexOf(name);
        if (i !== -1) this._branchIdx = i;
    };

    // GET /api/update/branches[?refresh=1] — every branch origin
    // has (falls back to on-disk refs when offline).
    UpdateScene.prototype._loadBranches = function(force) {
        var self = this;
        this._branchesLoading = true;
        this._branchesErr     = null;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/update/branches' + (force ? '?refresh=1' : ''), true);
        xhr.timeout = 20000;
        xhr.onload = function() {
            self._branchesLoading = false;
            if (xhr.status !== 200) {
                self._branchesErr = 'HTTP ' + xhr.status;
            } else {
                try {
                    var d = JSON.parse(xhr.responseText);
                    var prev = self._selectedBranch();
                    self._branches = (d.branches || []).slice();
                    if (d.current && !self._current) self._current = d.current;
                    // Keep whatever the user had picked; otherwise
                    // land on the branch the device actually runs.
                    self._branchIdx = 0;
                    self._seedSelection(prev || self._current || d.current);
                    if (!self._branches.length) {
                        self._branchesErr = d.error || 'No branches';
                    }
                } catch (e) { self._branchesErr = 'Bad response'; }
            }
            rerender();
        };
        xhr.onerror   = function() { self._branchesLoading = false; self._branchesErr = 'Network error'; rerender(); };
        xhr.ontimeout = function() { self._branchesLoading = false; self._branchesErr = 'Timeout';       rerender(); };
        xhr.send();
    };

    // GET /api/update/check[?branch=X] — commits the device is
    // behind origin/<X> (default: the checked-out branch).
    UpdateScene.prototype._check = function(branchName) {
        var self = this;
        this._state   = 'checking';
        this._commits = [];
        this._error   = null;
        this._scroll  = 0;
        var url = '/api/update/check'
            + (branchName ? '?branch=' + encodeURIComponent(branchName) : '');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 20000;
        xhr.onload = function() {
            if (xhr.status !== 200) {
                self._error = 'HTTP ' + xhr.status;
            } else {
                try {
                    var d = JSON.parse(xhr.responseText);
                    self._current = d.branch || '';
                    self._commit  = d.currentCommit || '';
                    self._error   = d.error || null;
                    self._commits = d.commits || [];
                    // First check: land the picker on the branch the
                    // device actually runs (if the list is here yet;
                    // _loadBranches does the same when it lands later).
                    if (!branchName) self._seedSelection(self._current);
                } catch (e) { self._error = 'Bad response'; }
            }
            self._state = 'ready';
            rerender();
        };
        xhr.onerror   = function() { self._error = 'Network error'; self._state = 'ready'; rerender(); };
        xhr.ontimeout = function() { self._error = 'Timeout';       self._state = 'ready'; rerender(); };
        xhr.send();
        rerender();
    };

    // POST /api/update/apply { branch } — pull (same branch) or
    // checkout -B onto the fresh remote tip (other branch); the
    // server restarts itself on success.
    UpdateScene.prototype._apply = function() {
        var self = this;
        var branch = this._selectedBranch();
        if (!branch) return;
        this._state = 'updating';
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/update/apply', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 60000;
        xhr.onload = function() {
            if (xhr.status === 200) {
                try {
                    var d = JSON.parse(xhr.responseText);
                    if (d.success) { self._state = 'done'; }
                    else { self._error = d.error || 'Unknown error'; self._state = 'fail'; }
                } catch (e) { self._error = 'Bad response'; self._state = 'fail'; }
            } else {
                self._error = 'HTTP ' + xhr.status;
                self._state = 'fail';
            }
            rerender();
        };
        xhr.onerror   = function() { self._error = 'Network error'; self._state = 'fail'; rerender(); };
        xhr.ontimeout = function() { self._error = 'Timeout';       self._state = 'fail'; rerender(); };
        xhr.send(JSON.stringify({ branch: branch }));
        rerender();
    };

    UpdateScene.prototype._pressUpdate = function() {
        var self = this;
        this._updateBtn.press();
        rerender();
        setTimeout(function() {
            self._updateBtn.release();
            self._apply();
        }, 30);
    };

    // Picker moved (inline cycle or dropdown commit) → re-check the
    // delta against the newly selected branch.
    UpdateScene.prototype._selectBranch = function(idx) {
        if (!this._branches.length) return;
        this._branchIdx = (idx + this._branches.length) % this._branches.length;
        this._check(this._branches[this._branchIdx]);
    };

    // How many option rows fit under the chip before the body would
    // run past the bottom margin.
    UpdateScene.prototype._ddVisibleCount = function(canvasH) {
        var chipY = ROW_Y + MenuDropdownLine.TOP_PAD;
        var room  = canvasH - DD_BOTTOM_PAD - chipY - 2;        // minus borders
        var n     = Math.floor((room + DD_DIV_H) / (DD_ITEM_H + DD_DIV_H));
        return Math.max(1, Math.min(n, this._branches.length));
    };

    UpdateScene.prototype._ddClampScroll = function() {
        var vis = this._ddVisibleCount(144);
        if (this._dropdownIndex < this._ddScroll) this._ddScroll = this._dropdownIndex;
        if (this._dropdownIndex >= this._ddScroll + vis) this._ddScroll = this._dropdownIndex - vis + 1;
        var maxScroll = Math.max(0, this._branches.length - vis);
        this._ddScroll = Math.max(0, Math.min(maxScroll, this._ddScroll));
    };

    UpdateScene.prototype._openDropdown = function() {
        if (!this._branches.length) {
            // Nothing to pick from — retry the list instead.
            if (!this._branchesLoading) this._loadBranches(true);
            return;
        }
        this._dropdownIndex = this._branchIdx;
        this._ddScroll      = 0;
        this._ddClampScroll();
        this._dropdownOpen  = true;
        rerender();
    };

    UpdateScene.prototype.handleInput = function(action) {
        if (this._state === 'updating' || this._state === 'done') return;

        // ── Open dropdown owns input until it closes ──────────
        if (this._dropdownOpen) {
            var n = this._branches.length;
            if (!n) { this._dropdownOpen = false; rerender(); return; }
            if (action === 'back' || action === 'esc') {
                this._dropdownOpen = false;
                rerender();
                return;
            }
            if (action === 'down' || action === 'up') {
                var d = (action === 'down') ? 1 : -1;
                this._dropdownIndex = (this._dropdownIndex + d + n) % n;
                this._ddClampScroll();
                rerender();
                return;
            }
            if (action === 'ok' || action === 'run') {
                this._dropdownOpen = false;
                if (this._dropdownIndex !== this._branchIdx) {
                    this._selectBranch(this._dropdownIndex);
                } else {
                    rerender();
                }
                return;
            }
            return;
        }

        if (action === 'back' || action === 'esc') return 'pop';
        if (this._state === 'checking') return;

        if (action === 'left' || action === 'right') {
            // Inline cycle — no overlay, same re-check as a commit.
            this._selectBranch(this._branchIdx + (action === 'right' ? 1 : -1));
            return;
        }
        if (action === 'ok') {
            this._openDropdown();
            return;
        }
        if (action === 'up' || action === 'down') {
            var step = (action === 'down') ? 1 : -1;
            var max  = Math.max(0, this._commits.length - this._visibleRows());
            this._scroll = Math.max(0, Math.min(max, this._scroll + step));
            rerender();
            return;
        }
        if (action === 'run') {
            // 'ready' and 'fail' both allow a (re)try; a plain pull
            // on an up-to-date branch is harmless.
            if (this._selectedBranch()) this._pressUpdate();
        }
    };

    UpdateScene.prototype._visibleRows = function() {
        // From under the picker row down to the bottom-button bar.
        var listTop = ROW_Y + MenuDropdownLine.HEIGHT + 4;
        return Math.floor((144 - 16 - listTop) / LINE_H);
    };

    // Truncate a line to fit `maxW` px of Haxrcorp, ending in '..'
    // (the fonts carry no ellipsis glyph).
    function fitLine(s, maxW) {
        if (HaxrCorp4090FlipCTL.textWidth(s) <= maxW) return s;
        while (s.length > 1
               && HaxrCorp4090FlipCTL.textWidth(s + '..') > maxW) {
            s = s.slice(0, -1);
        }
        return s + '..';
    }

    UpdateScene.prototype.render = function(canvas) {
        canvas.clear('#fff');
        var ctx = canvas.ctx;

        // Chrome — status bar + gray title strip (MeshCore-style).
        if (typeof UI !== 'undefined' && UI.drawStatusBar) {
            UI.drawStatusBar(canvas, '');
        }
        var TITLE_Y = UI.STATUS_BAR_H;
        ctx.fillStyle = '#D9D9D9';
        ctx.fillRect(0, TITLE_Y, canvas.w, TITLE_H);
        Born2bSportyV2FlipCTL.draw(ctx, this.displayName, 4, TITLE_Y, '#000');

        // Right-aligned strip status: how far behind the selected
        // branch we are.
        var strip = '';
        if (this._state === 'checking')      strip = 'Checking' + this._dots();
        else if (this._state === 'updating') strip = 'Updating' + this._dots();
        else if (this._state === 'done')     strip = 'Done';
        else if (this._error)                strip = 'Error';
        else if (this._commits.length > 0) {
            strip = this._commits.length + ' commit'
                + (this._commits.length !== 1 ? 's' : '') + ' back';
        } else if (this._state === 'ready')  strip = 'Up to date';
        if (strip) {
            var stripW = HaxrCorp4090FlipCTL.textWidth(strip);
            HaxrCorp4090FlipCTL.draw(ctx, strip,
                canvas.w - 2 - stripW, TITLE_Y + 3, '#000');
        }

        // Busy / terminal states occupy the body.
        if (this._state === 'updating' || this._state === 'done') {
            var l1 = (this._state === 'done') ? 'Done!' : 'Updating' + this._dots();
            var l2 = (this._state === 'done') ? 'Restarting' + this._dots() : 'Do not power off';
            HaxrCorp4090FlipCTL.draw(ctx, l1, 6, 40, '#000');
            HaxrCorp4090FlipCTL.draw(ctx, l2, 6, 52, '#666');
            return;
        }

        // Branch picker row — MenuDropdownLine with the < value >
        // chip, always the focused row (left/right cycles, OK opens).
        var selected  = this._selectedBranch();
        var chipValue = selected;
        if (!chipValue) {
            chipValue = this._branchesLoading ? 'Loading' + this._dots()
                      : (this._branchesErr || '-');
        }
        new MenuDropdownLine({
            y:        ROW_Y,
            title:    'Branch',
            value:    chipValue,
            selected: !this._dropdownOpen
        }).render(canvas);

        // Selector outline flush with the row's top. Suppressed
        // while the dropdown is open — the overlay's inner
        // selector is the only focus then (same rule as radio).
        if (!this._dropdownOpen) {
            this._selectorFrame.setPosition(SELECTOR_X, ROW_Y);
            this._selectorFrame.setSize(SELECTOR_W, SELECTOR_H);
            this._selectorFrame.render(canvas);
        }

        var listTop = ROW_Y + MenuDropdownLine.HEIGHT + 4;

        if (this._state === 'checking') {
            HaxrCorp4090FlipCTL.draw(ctx, 'Checking' + this._dots(), 6, listTop, '#666');
        } else if (this._state === 'fail') {
            HaxrCorp4090FlipCTL.draw(ctx, 'Update failed', 6, listTop, '#000');
            HaxrCorp4090FlipCTL.draw(ctx,
                fitLine(String(this._error || ''), 244), 6, listTop + LINE_H, '#666');
        } else if (this._error) {
            HaxrCorp4090FlipCTL.draw(ctx,
                fitLine('Error: ' + this._error, 244), 6, listTop, '#000');
        } else if (this._commits.length === 0) {
            // Incoming commits for the selected branch — none.
            HaxrCorp4090FlipCTL.draw(ctx, 'No new commits', 6, listTop, '#666');
            if (this._commit) {
                HaxrCorp4090FlipCTL.draw(ctx,
                    fitLine(this._commit, 244), 6, listTop + LINE_H, '#666');
            }
        } else {
            var rows = this._visibleRows();
            var end  = Math.min(this._commits.length, this._scroll + rows);
            for (var i = this._scroll; i < end; i++) {
                HaxrCorp4090FlipCTL.draw(ctx,
                    fitLine(this._commits[i], 244),
                    6, listTop + (i - this._scroll) * LINE_H, '#666');
            }
        }

        // Bottom-right button — always present. "Update" pulls the
        // checked-out branch, "Switch" checks out the picked one.
        // Grayed while a check is in flight (Run is ignored then)
        // or while there is no branch to act on.
        this._updateBtn.text = (selected && this._current && selected !== this._current)
            ? 'Switch' : 'Update';
        this._updateBtn.disabled = (this._state === 'checking') || !selected;
        this._updateBtn.render(canvas);

        // Dropdown overlay — drawn last so it sits above everything.
        if (this._dropdownOpen && this._branches.length) {
            var chipX = canvas.w - MenuDropdownLine.CHIP_WIDTH - 5;   // CHIP_RIGHT_PAD
            var chipY = ROW_Y + MenuDropdownLine.TOP_PAD;
            this._renderDropdown(canvas, chipX, chipY);
        }
    };

    // Port of the Recorder's `_renderDropdown` (itself a port of
    // Internet radio's): white wash → crisp row title → gray body →
    // centred items with 1-px dividers → inner selector. Adds a
    // scroll window + a 1-px thumb on the right edge for lists
    // taller than the room under the chip.
    UpdateScene.prototype._renderDropdown = function(canvas, chipX, chipY) {
        var ctx     = canvas.ctx;
        var options = this._branches;
        var total   = options.length;
        if (!total) return;

        var W   = MenuDropdownLine.CHIP_WIDTH;                    // 180
        var vis = this._ddVisibleCount(canvas.h);
        this._ddClampScroll();
        var first = this._ddScroll;
        var H   = DD_ITEM_H * vis + DD_DIV_H * (vis - 1) + 2;
        var bodyY = chipY;

        // (1) Wash everything else out.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.fillRect(0, 0, canvas.w, canvas.h);

        // (2) Row title re-drawn crisp on top of the wash.
        HaxrCorp4090FlipCTL.draw(ctx, 'Branch', 6, chipY, '#000');

        // (3) Body — same fill as the closed chip.
        new ResponsiveFrame({
            x: chipX, y: bodyY,
            width: W, height: H,
            anchorH: 'left', anchorV: 'top',
            showStroke: false,
            showFill:   true, fillColor: MenuDropdownLine.CHIP_FILL,
            cornerRadius: 3,
            corners: { tl: true, tr: true, bl: true, br: true }
        }).render(canvas);

        // (4) Visible items + dividers. Labels are trimmed to leave
        // room for the scroll thumb when the list scrolls.
        var scrolls = total > vis;
        var maxLabelW = W - 8 - (scrolls ? 4 : 0);
        var selectedItemY = bodyY + 1;
        for (var vi = 0; vi < vis; vi++) {
            var i     = first + vi;
            var itemY = bodyY + 1 + vi * (DD_ITEM_H + DD_DIV_H);
            var label = fitLine(String(options[i]), maxLabelW);
            var labelW = HaxrCorp4090FlipCTL.textWidth(label);
            HaxrCorp4090FlipCTL.draw(ctx, label,
                chipX + Math.floor((W - labelW) / 2),
                itemY + 1, '#000');
            if (i === this._dropdownIndex) selectedItemY = itemY;
            if (vi < vis - 1) {
                canvas.drawHLine(chipX + 1, itemY + DD_ITEM_H, W - 2, '#999999');
            }
        }

        // (4b) Scroll thumb — 1 px wide track inside the right edge,
        // thumb length ∝ visible/total, position ∝ first/total.
        if (scrolls) {
            var trackX = chipX + W - 3;
            var trackY = bodyY + 2;
            var trackH = H - 4;
            var thumbH = Math.max(3, Math.round(trackH * vis / total));
            var thumbY = trackY + Math.round((trackH - thumbH) * first / (total - vis));
            ctx.fillStyle = '#999999';
            ctx.fillRect(trackX, trackY, 1, trackH);
            ctx.fillStyle = '#000000';
            ctx.fillRect(trackX, thumbY, 1, thumbH);
        }

        // (5) Inner selector outline around the highlighted item;
        // 1 px narrower so the BR shadow pixel stays inside the body.
        this._dropdownInnerSelector.setPosition(chipX, selectedItemY);
        this._dropdownInnerSelector.setSize(W - 1, DD_ITEM_H + 2);
        this._dropdownInnerSelector.render(canvas);
    };

    return UpdateScene;
})();
