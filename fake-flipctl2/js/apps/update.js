/**
 * UpdateScene
 *
 * Settings → Update, MeshCore-style chrome: status bar + gray title
 * strip ("Update" in Sporty), with a small right-aligned status in
 * the strip — "N commits back" for the selected branch (or "Up to
 * date"). Below: a Branch picker row (MenuDropdownLine, left/right
 * cycles like Internet radio's pickers) and the list of incoming
 * commits. Run (B) — or OK — presses the bottom-right "Update"
 * button: the server checks out / pulls the selected branch and
 * restarts itself; the page reloads via the /api/version watcher.
 */
var UpdateScene = (function() {
    var TITLE_H  = 16;
    var BRANCHES = ['dev', 'meshcore_demo'];
    var ROW_Y    = 33;               // Branch picker row top
    var LINE_H   = 11;               // commit list row pitch (Haxrcorp)
    var BTN_W    = 48;

    function UpdateScene(sceneManager) {
        this.sceneManager    = sceneManager || null;
        this.displayName     = 'Update';
        this.breadcrumbTitle = 'Update';

        // 'checking' | 'ready' | 'updating' | 'done' | 'fail'
        this._state     = 'checking';
        this._branchIdx = 0;         // selection in BRANCHES
        this._current   = '';        // branch checked out on device
        this._commits   = [];
        this._commit    = '';        // current commit line
        this._error     = null;
        this._scroll    = 0;

        this._updateBtn = new UI.RightButton('Update', BTN_W, 'run',
            function() { /* fired from handleInput */ });
    }

    UpdateScene.prototype.enter = function() {
        this._check(null);
    };

    UpdateScene.prototype.exit = function() {};

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
                    // device actually runs.
                    if (!branchName) {
                        var i = BRANCHES.indexOf(self._current);
                        if (i !== -1) self._branchIdx = i;
                    }
                } catch (e) { self._error = 'Bad response'; }
            }
            self._state = 'ready';
            if (window.requestRender) window.requestRender();
        };
        xhr.onerror   = function() { self._error = 'Network error'; self._state = 'ready'; if (window.requestRender) window.requestRender(); };
        xhr.ontimeout = function() { self._error = 'Timeout';       self._state = 'ready'; if (window.requestRender) window.requestRender(); };
        xhr.send();
        if (window.requestRender) window.requestRender();
    };

    // POST /api/update/apply { branch } — pull (same branch) or
    // checkout -B onto the fresh remote tip (other branch); the
    // server restarts itself on success.
    UpdateScene.prototype._apply = function() {
        var self = this;
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
            if (window.requestRender) window.requestRender();
        };
        xhr.onerror   = function() { self._error = 'Network error'; self._state = 'fail'; if (window.requestRender) window.requestRender(); };
        xhr.ontimeout = function() { self._error = 'Timeout';       self._state = 'fail'; if (window.requestRender) window.requestRender(); };
        xhr.send(JSON.stringify({ branch: BRANCHES[this._branchIdx] }));
        if (window.requestRender) window.requestRender();
    };

    UpdateScene.prototype._pressUpdate = function() {
        var self = this;
        this._updateBtn.press();
        if (window.requestRender) window.requestRender();
        setTimeout(function() {
            self._updateBtn.release();
            self._apply();
        }, 30);
    };

    UpdateScene.prototype.handleInput = function(action) {
        if (this._state === 'updating' || this._state === 'done'
                || this._state === 'checking') {
            return;
        }
        if (action === 'back' || action === 'esc') return 'pop';

        if (action === 'left' || action === 'right') {
            // Branch picker — cycles like the radio's city picker;
            // every change re-checks the commit delta.
            var d = (action === 'right') ? 1 : -1;
            this._branchIdx = (this._branchIdx + d + BRANCHES.length) % BRANCHES.length;
            this._check(BRANCHES[this._branchIdx]);
            return;
        }
        if (this._state !== 'ready') return;
        if (action === 'up' || action === 'down') {
            var step = (action === 'down') ? 1 : -1;
            var max  = Math.max(0, this._commits.length - this._visibleRows());
            this._scroll = Math.max(0, Math.min(max, this._scroll + step));
            if (window.requestRender) window.requestRender();
            return;
        }
        if (action === 'ok' || action === 'run') {
            this._pressUpdate();
        }
    };

    UpdateScene.prototype._visibleRows = function() {
        // From under the picker row down to the bottom-button bar.
        var listTop = ROW_Y + MenuDropdownLine.HEIGHT + 4;
        return Math.floor((144 - 16 - listTop) / LINE_H);
    };

    // Truncate a commit line to fit `maxW` px of Haxrcorp.
    function fitLine(s, maxW) {
        if (HaxrCorp4090FlipCTL.textWidth(s) <= maxW) return s;
        while (s.length > 1
               && HaxrCorp4090FlipCTL.textWidth(s + '…') > maxW) {
            s = s.slice(0, -1);
        }
        return s + '…';
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
        if (this._state === 'checking')      strip = 'Checking…';
        else if (this._state === 'updating') strip = 'Updating…';
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
            var l1 = (this._state === 'done') ? 'Done!' : 'Updating…';
            var l2 = (this._state === 'done') ? 'Restarting…' : 'Do not power off';
            HaxrCorp4090FlipCTL.draw(ctx, l1, 6, 40, '#000');
            HaxrCorp4090FlipCTL.draw(ctx, l2, 6, 52, '#666');
            return;
        }

        // Branch picker row — MenuDropdownLine with the < value >
        // chip, always the focused row (left/right cycles).
        new MenuDropdownLine({
            y:        ROW_Y,
            title:    'Branch',
            value:    BRANCHES[this._branchIdx],
            selected: true
        }).render(canvas);

        var listTop = ROW_Y + MenuDropdownLine.HEIGHT + 4;

        if (this._state === 'checking') {
            HaxrCorp4090FlipCTL.draw(ctx, 'Checking…', 6, listTop, '#666');
            return;
        }
        if (this._state === 'fail') {
            HaxrCorp4090FlipCTL.draw(ctx, 'Update failed', 6, listTop, '#000');
            HaxrCorp4090FlipCTL.draw(ctx,
                fitLine(String(this._error || ''), 244), 6, listTop + LINE_H, '#666');
            return;
        }
        if (this._error) {
            HaxrCorp4090FlipCTL.draw(ctx,
                fitLine('Error: ' + this._error, 244), 6, listTop, '#000');
            return;
        }

        // Incoming commits for the selected branch.
        if (this._commits.length === 0) {
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

        // Bottom-right Update button (Run / OK).
        this._updateBtn.render(canvas);
    };

    return UpdateScene;
})();
