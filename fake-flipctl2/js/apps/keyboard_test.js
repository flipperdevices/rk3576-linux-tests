/**
 * TextInputScreen
 *
 * Reusable text-input screen: centred title, auto-sizing input
 * field, the standard on-screen UI.Keyboard, the 123 / backspace
 * tabs below it, the bottom-bar Cancel / Done buttons, and a
 * discard-changes modal on Back when there's unsaved text.
 *
 * Originally split out of the keyboard-test sandbox so other
 * scenes (Wi-Fi password, future forms) can drop in the same
 * input experience without copying the chrome.
 *
 * Constructor options:
 *   - displayName  : string shown in the App Switcher (default
 *                    'Screen Keyboard').
 *   - title        : caption above the input field (default
 *                    'Text field title').
 *   - initialText  : starting value for the field (default '').
 *   - onSave(text) : called when the user commits — Save in the
 *                    discard modal or Done in the bottom bar.
 *                    Return value is passed through to the
 *                    scene-stack as the handleInput result, so
 *                    returning 'pop' (or omitting) closes the
 *                    scene.
 *   - onDiscard()  : called when the user picks Discard in the
 *                    confirmation modal. Same return-value
 *                    semantics as onSave.
 *
 * `KeyboardTestScene` is exposed as an alias at the bottom of
 * this file so existing entry points (main.js, menu.js) keep
 * working without changes.
 *
 * Input mapping:
 *   - up / down / left / right  → move keyboard / input cursor
 *   - ok                        → insert highlighted char
 *   - back / esc                → close modal or open discard
 *                                 prompt (or pop when field empty)
 *
 * Touchpad: subscribes to the kernel-evdev SSE stream (same
 * endpoint TouchpadAbsScene / AppSwitcherScene use). Y axis maps
 * to row selection, X axis to column selection. Linear: every
 * TP_*_UNITS_PER_STEP raw units of finger motion ticks the
 * highlight one cell. No velocity / momentum — when the finger
 * stops or lifts, the highlight stays exactly where the finger
 * left it.
 */
var TextInputScreen = (function() {
    // Pad units → keyboard step. The pad's raw Y axis spans
    // ~400 units; with 3 rows, 130/row puts a full-pad Y sweep
    // squarely on a row-to-row traversal. X is sized so a full
    // pad sweep covers ~12 cols (the widest row), at ~32 raw
    // units per column step.
    var TP_X_UNITS_PER_STEP = 32;
    var TP_Y_UNITS_PER_STEP = 130;
    // Sensitivity knob. Raw axis deltas are divided by this before
    // the step math runs, so 1 = baseline speed, 2 = drag twice
    // as far for the same step, etc. Bump it to make the highlight
    // feel slower / less twitchy under the finger.
    var TP_SLOW_DIVIDER = 2;

    // Long-press threshold (ms) on the OK key while the highlight
    // sits on the shift cell. A press shorter than this cycles the
    // standard 'off' ↔ 'shift' state via UI.Keyboard's tap toggle;
    // a press longer than this latches caps lock.
    var SHIFT_LONGPRESS_MS = 500;
    // Browser keys that fire the OK action (mirrors KEY_MAP in
    // input.js). Only these warrant the long-press timer.
    var OK_KEYS = { 'Enter': 1, 'k': 1 };

    // App-defined bottom-bar buttons. Same 48 × 2 px slot
    // convention UIDemoScene uses, so Close / 123 / Done line up
    // visually with anything else that draws bottom buttons.
    var BTN_W   = 48;
    var BTN_GAP = 2;

    function TextInputScreen(options) {
        options = options || {};
        this._opts       = options;
        this.displayName = options.displayName || 'Screen Keyboard';
    }

    TextInputScreen.prototype.enter = function() {
        var self = this;

        // Seed text and cursor from constructor options so a
        // consumer can pre-fill the field (e.g. Wi-Fi password
        // editing an existing entry). Cursor lands at the end
        // of the seed so typing appends naturally.
        var opts = this._opts || {};
        this.inputText  = (typeof opts.initialText === 'string') ? opts.initialText : '';
        // Snapshot the original value so back / cancel can tell
        // whether anything actually changed. Skipping the
        // "Discard changes?" prompt on an unchanged field
        // avoids prompting the user about discarding nothing.
        this._initialText = this.inputText;
        this._inputCursor = this.inputText.length;
        // Title rendered centered above the input field. Driven
        // by the `title` option so consumers can swap the
        // caption per-form. Falls back to a generic placeholder
        // when none is supplied.
        this.fieldTitle = (typeof opts.title === 'string') ? opts.title : 'Text field title';
        // Optional char budget: input is blocked past it and a gray
        // "N left" counter rides the title line, flush right.
        this._maxLen = (typeof opts.maxLen === 'number' && opts.maxLen > 0)
            ? opts.maxLen : null;
        // Big multi-line field (message composer): a fixed
        // full-width box under the title with word-wrapped text,
        // instead of the auto-sizing single-line field.
        this._bigField = !!opts.bigField;
        // Commit / discard callbacks. Caller-supplied so the
        // same screen can plug into different downstream wiring
        // (Wi-Fi password store, future form submission, …).
        // Both are invoked with this scene's current inputText
        // value where relevant; their return value bubbles up to
        // handleInput so the scene stack can pop / push.
        this._onSave    = (typeof opts.onSave    === 'function') ? opts.onSave    : null;
        this._onDiscard = (typeof opts.onDiscard === 'function') ? opts.onDiscard : null;
        // Optional live validator. Called on every render with
        // the current input text; returning a non-empty string
        // displays it as a warning beneath the input field. Use
        // this to surface duplicate-name / format / length
        // issues before the user commits via Done.
        this._validate  = (typeof opts.validate  === 'function') ? opts.validate  : null;
        // Discard-confirmation modal. Opens on Back when the
        // input field has unsaved text. `buttonIndex` 0 = Keep
        // (default, dismiss the modal and stay in the keyboard
        // with the text preserved) and 1 = Discard (closes the
        // scene via onDiscard, text is lost). Back inside the
        // modal also dismisses it the same way Keep does.
        this._discardModal = { open: false, buttonIndex: 0 };
        // Flat layout: a centred title and a centred input field
        // sit directly on the white background. No tab header,
        // no body frame — the keyboard is the only persistent
        // chrome below.
        this.cursor = new BlinkingKeyboardCursor(500);

        // Three layouts.
        //
        // ABC uses sentinel chars ('⇧' shift, '⌘' lang, ' ' space)
        // that drawKeyboard / UI.Keyboard recognise as wide keys
        // with special rendering / behaviour.
        //
        // SYM and SYM2 are the symbol layouts. They share a top
        // row (digits 1-0 + dash) and a bottom row of punctuation
        // bracketed by wide '_' / '.' (no shift / no space — just
        // wide non-functional cells). Their middle rows differ —
        // each one's first wide cell ('<>|' on SYM, '[]◇' on
        // SYM2) acts as a switch-layout indicator: pressing it
        // toggles to the other symbol layout, mirroring how the
        // 123 / ABC bottom button toggles ABC ↔ SYM. Cell
        // onPress callbacks (handled by UI.Keyboard) carry the
        // toggle behaviour without any character emission.
        // Wide-cell descriptors used at the trailing edges of
        // rows 0 and 1. They previously carried backspace and
        // return; with backspace moved to the dedicated tab
        // below the keyboard, the wide slots are now form-
        // navigation buttons (Up / Down arrows) — no behaviour
        // wired yet, just the visual placeholders.
        var keyboardUpCell   = { wide: true, isKeyboardUp:   true };
        var keyboardDownCell = { wide: true, isKeyboardDown: true };
        var switchSym = function() { self._switchSymLayout(); };

        // Peek row: numbers sit above the QWERTY row. When the
        // peek row isn't the focused one, drawKeyboard renders
        // only the top few pixels of each cell — tabs poking up
        // above the keyboard chrome. Selecting a peek cell pops
        // it open fully so the user can see the digit. Column
        // alignment with row 1 (qwertyuiop[): 1 above q, 2 above
        // w, … 0 above p, '-' above '['. No peek cell above the
        // wide backspace at the row's right edge — the array
        // ends one short so col 11 reads as empty.
        // The first cell carries `peek: true` so drawKeyboard's
        // peek-row detection picks the row up; the rest stay as
        // plain strings since the detection key is the row's
        // first cell only.
        this._layoutABC = [
            [{ text: '1', peek: true },
             '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
            ['q','w','e','r','t','y','u','i','o','p','[',
             keyboardUpCell],
            ['⌘','a','s','d','f','g','h','j','k','l',':',']',
             keyboardDownCell],
            ['⇧','z','x','c','v','b','n','m',',','.','/','?',' ']
        ];
        this._layoutSYM = [
            ['1','2','3','4','5','6','7','8','9','0','-',
             keyboardUpCell],
            [{text:'<>|', wide:true, onPress: switchSym},
             '+', '(', ')', '=', '{', '}', '@', '#', '$', '?', ';',
             keyboardDownCell],
            [{text:'_',   wide:true}, '%', '^', '&', '*', '`', '~', '\\', ',', '.', ':', '/',
             {text:'.',   wide:true}]
        ];
        this._layoutSYM2 = [
            ['1','2','3','4','5','6','7','8','9','0','-',
             keyboardUpCell],
            [{text:'[]◇', wide:true, onPress: switchSym},
             '[', ']', '<', '>', '|', '"', "'", '±', '!', '?', ';',
             keyboardDownCell],
            [{text:'_',   wide:true}, '%', '^', '&', '*', '`', '~', '\\', ',', '.', ':', '/',
             {text:'.',   wide:true}]
        ];
        this._layout = 'abc';

        this.keyboard = new UI.Keyboard(
            this._layoutABC,
            function(char) {
                if (char === '\b') {
                    // Delete the character to the LEFT of the
                    // cursor (no-op when the cursor is at the
                    // start). Cursor shifts one position left.
                    if (self._inputCursor > 0) {
                        self.inputText = self.inputText.slice(0, self._inputCursor - 1)
                            + self.inputText.slice(self._inputCursor);
                        self._inputCursor--;
                    }
                } else {
                    // Insert at the cursor position, then
                    // advance the cursor past the inserted char.
                    // A full char budget swallows the keypress.
                    if (self._maxLen !== null
                            && self.inputText.length >= self._maxLen) {
                        return;
                    }
                    self.inputText = self.inputText.slice(0, self._inputCursor)
                        + char
                        + self.inputText.slice(self._inputCursor);
                    self._inputCursor++;
                }
                if (self.cursor) self.cursor.reset();
                if (window.requestRender) window.requestRender();
            },
            null   // no onClose — esc returns 'pop' from handleInput
        );

        // Cursor blink ticker — without it the field would freeze
        // on whichever cursor visibility was active when the last
        // key was pressed.
        this._blinkTimer = setInterval(function() {
            if (window.requestRender) window.requestRender();
        }, 250);

        // ── App-defined bottom-bar buttons ────────────────────────
        // Close (left, fires on esc)  — pops the scene.
        // Done  (right, fires on run) — also pops for now; future
        //                                wiring will commit the
        //                                input field elsewhere.
        // 123   (middle slot index 1, fires on edit) — swaps the
        //                                keyboard between the
        //                                alphabet and symbol
        //                                layouts. Label flips
        //                                between '123' and 'ABC'
        //                                so the user can see what
        //                                pressing it will do next.
        this._closeBtn = new UI.LeftButton(  'Cancel', BTN_W, 'esc', function() { /* esc → pop handled in handleInput */ });
        // Numeric-layout tab on the left and backspace tab on the
        // right. Both sit 2 px above the screen bottom and 52 px
        // in from their respective screen edges (so the right
        // edge of the backspace tab matches the gap geometry of
        // the 123 tab on the left). Same square-top / rounded-
        // bottom shape; the 123 carries the 'edit' (X) action
        // and toggles the layout, the backspace carries the
        // 'back' action and deletes the trailing character via
        // the keyboard's onChar callback.
        var TAB_BTN_W = 48;
        var TAB_BTN_H = 14;
        var TAB_BTN_X = 52;
        var SCREEN_W  = 256;
        var SCREEN_H  = 144;
        var tabBtnY   = SCREEN_H - 2 - TAB_BTN_H;
        var BACKSPACE_BTN_X = SCREEN_W - 52 - TAB_BTN_W;
        this._123Btn       = new UI.NumericTabButton('123', TAB_BTN_X, tabBtnY, TAB_BTN_W, 'edit', function() { self._toggleLayout(); });
        this._backspaceBtn = new UI.IconTabButton(Icons.backspace, BACKSPACE_BTN_X, tabBtnY, TAB_BTN_W, 'del', function() {
            if (self.keyboard && self.keyboard.onChar) self.keyboard.onChar('\b');
        });
        this._doneBtn      = new UI.RightButton(
            (typeof opts.doneLabel === 'string' && opts.doneLabel) || 'Done',
            BTN_W, 'run', function() { /* run → pop handled in handleInput */ });
        this._bottomBtns = [this._closeBtn, this._123Btn, this._backspaceBtn, this._doneBtn];
        // Focus state. 'keyboard' = the on-screen Keyboard owns
        // the cursor; 'tab123' = the 123 tab button is highlighted
        // instead. Initial focus is the keyboard so existing
        // behaviour is unchanged on first launch.
        this._focus = 'keyboard';
        // action → button lookup so handleInput can flash the
        // matching button.
        this._btnActionMap = {};
        for (var bi = 0; bi < this._bottomBtns.length; bi++) {
            var bb = this._bottomBtns[bi];
            if (bb && bb.action) this._btnActionMap[bb.action] = bb;
        }
        // Sync the keyboard's layout indicator to whatever layout
        // we're starting with (defaults to 'abc' / 'EN').
        this.keyboard.langLabel = (this._layout === 'sym') ? '123' : 'EN';

        // ── Touchpad ──────────────────────────────────────────────
        // Linear mapping only: target row/col = baseline + dx/dy
        // ÷ step. No velocity sampling, no momentum projection on
        // release — the highlight tracks the finger directly and
        // stops where the finger stops.
        this._tpTouching    = false;
        this._tpBaselineX   = 0;
        this._tpBaselineY   = 0;
        this._tpBaselineRow = 0;
        this._tpBaselineCol = 0;
        try {
            this._tpES = new EventSource('/api/touchpad/xy');
            this._tpES.onmessage = function(e) { self._handleTouchpadMessage(e); };
            this._tpES.onerror   = function() { /* keyboard input still works */ };
        } catch (err) {
            this._tpES = null;
        }

        // ── Long-press shift detection ───────────────────────────
        // Document-level keydown/keyup listeners track how long the
        // OK key is held while the highlight sits on the shift
        // cell. We work alongside Input.js (which queues 'ok'
        // actions) — the keydown handler here filters auto-repeats
        // and stamps a press start; the keyup handler measures
        // duration on release and, if past threshold, latches
        // shiftState to 'caps'. Auto-repeat suppression for the
        // tap-toggle path is handled in `handleInput` via the
        // `_shiftToggledThisPress` flag.
        this._shiftPressStart        = null;
        this._shiftToggledThisPress  = false;
        this._onSceneKeyDown = function(e) {
            if (e.repeat)                  return;   // auto-repeat: ignore
            if (!OK_KEYS[e.key])           return;
            if (!self._isHighlightOnShift()) return;
            self._shiftPressStart       = Date.now();
            self._shiftToggledThisPress = false;
        };
        this._onSceneKeyUp = function(e) {
            if (!OK_KEYS[e.key])     return;
            if (self._shiftPressStart === null) return;
            var dur = Date.now() - self._shiftPressStart;
            self._shiftPressStart       = null;
            self._shiftToggledThisPress = false;
            if (dur >= SHIFT_LONGPRESS_MS && self.keyboard) {
                // Long press latches caps lock. Overrides whatever
                // the tap-toggle put us in (could have been 'shift',
                // or 'off' if a previous tap left us in 'caps').
                self.keyboard.shiftState = 'caps';
                if (window.requestRender) window.requestRender();
            }
        };
        document.addEventListener('keydown', this._onSceneKeyDown);
        document.addEventListener('keyup',   this._onSceneKeyUp);
    };

    TextInputScreen.prototype.exit = function() {
        if (this._blinkTimer) {
            clearInterval(this._blinkTimer);
            this._blinkTimer = null;
        }
        if (this._tpES) {
            this._tpES.close();
            this._tpES = null;
        }
        if (this._onSceneKeyDown) {
            document.removeEventListener('keydown', this._onSceneKeyDown);
            this._onSceneKeyDown = null;
        }
        if (this._onSceneKeyUp) {
            document.removeEventListener('keyup', this._onSceneKeyUp);
            this._onSceneKeyUp = null;
        }
    };

    // True when the currently-selected key is the wide shift cell
    // at col 0 of the last row. Used by the long-press timer + the
    // auto-repeat suppression in handleInput. Only the alphabet
    // layout has a shift cell — the symbol layout's bottom-left is
    // a wide '_' that doesn't carry shift behaviour.
    TextInputScreen.prototype._isHighlightOnShift = function() {
        if (!this.keyboard) return false;
        if (this._layout !== 'abc') return false;
        var rows = this.keyboard.rows;
        var lastRow = rows.length - 1;
        if (this.keyboard.selectedRow !== lastRow) return false;
        if (this.keyboard.selectedCol !== 0)        return false;
        return rows[lastRow][0] === '⇧';
    };

    // Swap between the alphabet layout and the symbol layouts.
    // Pressing the 123 button while in ABC takes the user to SYM.
    // Pressing it while in either SYM or SYM2 returns to ABC. The
    // gray top-row indicator flips 'EN' ↔ '123' and the middle
    // button label flips '123' ↔ 'ABC' so the affordance always
    // shows where pressing will go next.
    TextInputScreen.prototype._toggleLayout = function() {
        if (!this.keyboard) return;
        var inSymbols = (this._layout === 'sym' || this._layout === 'sym2');
        // Capture outgoing selection BEFORE swapping `rows`.
        var prevRow = this.keyboard.selectedRow;
        var prevCol = this.keyboard.selectedCol;
        var newRow;
        if (!inSymbols) {
            // ABC → SYM. The numbers row in SYM occupies the
            // VISUAL slot of ABC's QWERTY top row (think "number
            // above each letter on a real keyboard"), so the row
            // index shifts UP by 1. `'t'` at ABC (1, 4) lands on
            // `'5'` at SYM (0, 4); `'d'` at (2, 3) lands on `)`
            // at (1, 3); and so on. Peek (ABC row 0) clamps to
            // SYM row 0 — same column, same digit, just no longer
            // floating above the QWERTY.
            this._layout = 'sym';
            this.keyboard.rows      = this._layoutSYM;
            this.keyboard.langLabel = '123';
            this._123Btn.text       = 'ABC';
            newRow = Math.max(0, prevRow - 1);
        } else {
            // SYM → ABC. Inverse of the above: row index shifts
            // DOWN by 1, so SYM `'5'` at (0, 4) round-trips back
            // to ABC `'t'` at (1, 4). The peek row is never the
            // target of a layout-toggle — it stays accessible via
            // Up arrow from the QWERTY top instead.
            this._layout = 'abc';
            this.keyboard.rows      = this._layoutABC;
            this.keyboard.langLabel = 'EN';
            this._123Btn.text       = '123';
            newRow = Math.min(prevRow + 1, this._layoutABC.length - 1);
        }
        this._setSelection(newRow, prevCol);
        // Snap the peek-row wave to match the new layout's
        // geometry. The previous layout may have left wave state
        // referencing peek-row cells that don't exist (or that
        // exist at different positions) in the new layout — without
        // this, the wave would either play back stale animation or
        // light up the wrong column on the way back.
        if (this.keyboard.syncWaveToSelection) {
            this.keyboard.syncWaveToSelection();
        }
        // Drop any one-shot shift state — the SYM layouts have no
        // letters to apply it to anyway, and re-entering ABC
        // should start fresh.
        this.keyboard.shiftState = 'off';
        if (window.requestRender) window.requestRender();
    };

    // Toggle between the two symbol layouts. Wired into the wide
    // '<>|' / '[]◇' cell at row 1 col 0 of each SYM layout — those
    // cells act as switch-layout indicators (not chars to insert).
    // No-op while in ABC so an accidental call from any other path
    // can't drop the user into a symbols layout.
    TextInputScreen.prototype._switchSymLayout = function() {
        if (!this.keyboard) return;
        if (this._layout === 'sym') {
            this._layout = 'sym2';
            this.keyboard.rows = this._layoutSYM2;
        } else if (this._layout === 'sym2') {
            this._layout = 'sym';
            this.keyboard.rows = this._layoutSYM;
        } else {
            return;
        }
        this._setSelection(this.keyboard.selectedRow, this.keyboard.selectedCol);
        if (window.requestRender) window.requestRender();
    };

    // Move the keyboard's (selectedRow, selectedCol) to the given
    // integer target, clamping so the column never overflows the
    // row's length (rows differ in width).
    TextInputScreen.prototype._setSelection = function(row, col) {
        var rows = this.keyboard.rows;
        if (row < 0)             row = 0;
        if (row > rows.length-1) row = rows.length - 1;
        var rowLen = rows[row].length;
        if (col < 0)            col = 0;
        if (col > rowLen - 1)   col = rowLen - 1;
        // Route through Keyboard.setSelection so the peek-row
        // deselect slide-back animation fires when the touchpad
        // (or any other external selector) moves the cursor off
        // a peek cell. Mutating the fields directly here would
        // bypass the trigger that's set up inside the Keyboard
        // component for its own keypad-driven handleInput path.
        this.keyboard.setSelection(row, col);
    };

    // Touchpad-driven selection move: set the selection and, when the
    // touchpad actually crosses to a DIFFERENT key, play haptic effect
    // 3 (a tick of feedback per key the finger slides over).
    TextInputScreen.prototype._tpSetSelection = function(row, col) {
        var prevRow = this.keyboard.selectedRow;
        var prevCol = this.keyboard.selectedCol;
        this._setSelection(row, col);
        if (this.keyboard.selectedRow !== prevRow
                || this.keyboard.selectedCol !== prevCol) {
            this._playHaptic(3, 10);   // effect 3, 10 ms per key crossed
        }
    };

    // Fire-and-forget POST /api/haptic/play { effectId, durationMs }.
    TextInputScreen.prototype._playHaptic = function(effectId, durationMs) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/api/haptic/play', true);
            x.setRequestHeader('Content-Type', 'application/json');
            x.timeout = 2000;
            x.send(JSON.stringify({ effectId: effectId, durationMs: durationMs }));
        } catch (e) { /* offline / mocked — ignore */ }
    };

    // Columns of the bottom row that visually sit above each tab.
    // Both tabs sit 2 px above the screen bottom; the 123 tab is
    // 52 px in from the LEFT edge and covers x=52..99, the
    // backspace tab is 52 px in from the RIGHT edge and covers
    // x=156..203. ABC and SYM both have a 35-px wide leading
    // cell in the bottom row so column indices line up across
    // layouts.
    TextInputScreen.prototype._isColOverTab123 = function(col) {
        return col >= 1 && col <= 4;
    };
    TextInputScreen.prototype._isColOverBackspaceTab = function(col) {
        return col >= 8 && col <= 11;
    };
    // Resolve a bottom-row column to its tab name ('tab123',
    // 'tabBackspace', or null when the column doesn't sit over
    // either tab). Used by the Down-arrow gate and the touchpad
    // row-overflow handler.
    TextInputScreen.prototype._tabForCol = function(col) {
        if (this._isColOverTab123(col))       return 'tab123';
        if (this._isColOverBackspaceTab(col)) return 'tabBackspace';
        return null;
    };
    // Map a tab name to its button instance.
    TextInputScreen.prototype._btnForTab = function(tabName) {
        if (tabName === 'tab123')       return this._123Btn;
        if (tabName === 'tabBackspace') return this._backspaceBtn;
        return null;
    };

    // Given a full text string, the current cursor index, and the
    // pixel width of the visible inner area, decide which slice of
    // the string to show and whether either side needs a `<.` /
    // `.>` truncation marker. Returns { left, right, leftMarker,
    // rightMarker } — the caller renders text.slice(left, right)
    // with the marker prefixes/suffixes the result asks for and
    // measures cursor x from `left` so it stays accurate inside
    // the visible substring.
    //
    // Strategy:
    //   1. If the whole text fits, show all of it.
    //   2. Try left-aligned ("text.>" — only right side truncated).
    //      Use it when the cursor sits inside the visible prefix.
    //   3. Try right-aligned ("<.text" — only left side truncated).
    //      Use it when the cursor sits inside the visible suffix.
    //   4. Otherwise truncate on BOTH sides ("<.text.>"), expanding
    //      the visible window outward from the cursor.
    TextInputScreen.prototype._fitInputText = function(text, cursor, innerW) {
        var fullW = HaxrCorp4090FlipCTL.textWidth(text);
        if (fullW <= innerW) {
            return { left: 0, right: text.length, leftMarker: false, rightMarker: false };
        }
        // HaxrCorp4090FlipCTL.textWidth subtracts one inter-char unit
        // from the tail, so per-char widths can't be summed —
        // they'd under-count the actual concat. Always measure
        // the rendered substring (with any markers attached) to
        // decide whether it fits. Markers are `<...` (left side
        // truncated) and `...>` (right side truncated) — an
        // arrow + three concatenated periods, since
        // HaxrCorp4090FlipCTL ships no triple-dot glyph.
        var LEFT_MARKER  = '<...';
        var RIGHT_MARKER = '...>';
        function fitsAt(left, right, leftMarker, rightMarker) {
            var s = (leftMarker ? LEFT_MARKER : '')
                + text.slice(left, right)
                + (rightMarker ? RIGHT_MARKER : '');
            return HaxrCorp4090FlipCTL.textWidth(s) <= innerW;
        }
        // 2. Largest left-aligned prefix that fits with `.>` suffix.
        var leftEnd = 0;
        for (var i = 1; i <= text.length; i++) {
            if (!fitsAt(0, i, false, true)) break;
            leftEnd = i;
        }
        if (cursor <= leftEnd) {
            return { left: 0, right: leftEnd, leftMarker: false, rightMarker: true };
        }
        // 3. Smallest right-aligned start that fits with `<.` prefix.
        var rightStart = text.length;
        for (var j = text.length - 1; j >= 0; j--) {
            if (!fitsAt(j, text.length, true, false)) break;
            rightStart = j;
        }
        if (cursor >= rightStart) {
            return { left: rightStart, right: text.length, leftMarker: true, rightMarker: false };
        }
        // 4. Both sides — expand outward from the cursor.
        var s2 = cursor, e2 = cursor;
        while (s2 > 0 || e2 < text.length) {
            var grew = false;
            if (s2 > 0 && fitsAt(s2 - 1, e2, true, true)) { s2--; grew = true; }
            if (e2 < text.length && fitsAt(s2, e2 + 1, true, true)) { e2++; grew = true; }
            if (!grew) break;
        }
        return { left: s2, right: e2, leftMarker: true, rightMarker: true };
    };

    // Discard-confirmation modal renderer. Mirrors the install
    // modal from Internet Radio: a 150×70 centred frame on top
    // of a translucent white wash, title in Born2bSportyV2FlipCTL,
    // a single-line body in HaxrCorp4090FlipCTL, and two stacked
    // buttons (Cancel / Discard) with the highlighted one
    // wrapped by MenuSelectorFrame.
    TextInputScreen.prototype._renderDiscardModal = function(canvas) {
        var ctx = canvas.ctx;
        var m   = this._discardModal;

        var W = 150, H = 70;
        var X = Math.floor((canvas.w - W) / 2);
        var Y = Math.floor((canvas.h - H) / 2);

        // Wash everything else out — same alpha pattern other
        // modals in the project use.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.fillRect(0, 0, canvas.w, canvas.h);

        new ResponsiveFrame({
            x: X, y: Y, width: W, height: H,
            anchorH: 'left', anchorV: 'top',
            strokeColor: '#000', showStroke: true,
            fillColor:   '#fff', showFill:   true,
            cornerRadius: 4,
            corners: { tl: true, tr: true, bl: true, br: true }
        }).render(canvas);

        var titleY = Y + 6;
        var bodyY  = Y + 23;
        var BTN_H  = 14;
        var BTN_W  = W - 16;
        var BTN_X  = X + Math.floor((W - BTN_W) / 2);
        var btn1Y  = Y + 36;
        var btn2Y  = Y + 52;

        var title = 'Discard changes?';
        var titleW = Born2bSportyV2FlipCTL.textWidth(title);
        Born2bSportyV2FlipCTL.draw(ctx, title,
            X + Math.floor((W - titleW) / 2), titleY, '#000');

        var body = "Your text won't be saved.";
        var bodyW = HaxrCorp4090FlipCTL.textWidth(body);
        HaxrCorp4090FlipCTL.draw(ctx, body,
            X + Math.floor((W - bodyW) / 2), bodyY, '#666');

        this._drawDiscardModalButton(canvas, BTN_X, btn1Y, BTN_W, BTN_H,
            'Keep',    m.buttonIndex === 0);
        this._drawDiscardModalButton(canvas, BTN_X, btn2Y, BTN_W, BTN_H,
            'Discard', m.buttonIndex === 1);
    };

    // One row in the discard modal's stacked button list. Label
    // centred horizontally; when `selected` the row is wrapped by
    // a single-shared MenuSelectorFrame (same visual idiom the
    // install modal uses).
    TextInputScreen.prototype._drawDiscardModalButton = function(canvas, x, y, w, h, label, selected) {
        var ctx = canvas.ctx;
        var lw = HaxrCorp4090FlipCTL.textWidth(label);
        var labelY = y + Math.floor((h - 11) / 2);
        HaxrCorp4090FlipCTL.draw(ctx, label,
            x + Math.floor((w - lw) / 2), labelY, '#000');
        if (selected) {
            if (!this._discardBtnSelector) {
                this._discardBtnSelector = new MenuSelectorFrame({
                    x: 0, y: 0, width: 1, height: 1,
                    anchorH: 'left', anchorV: 'top',
                    strokeColor: '#000', showStroke: true, showFill: false
                });
            }
            this._discardBtnSelector.setPosition(x, y);
            this._discardBtnSelector.setSize(w, h);
            this._discardBtnSelector.render(canvas);
        }
    };

    // Funnel for the "leave the scene with the current input"
    // path — Done in the bottom bar and Save in the discard
    // modal both end up here. Invokes the consumer's onSave
    // callback (if any) and returns whatever it returns so the
    // scene-stack can pop / push as the consumer asked. When no
    // callback is supplied, defaults to 'pop' so a stand-alone
    // sandbox still exits the scene.
    TextInputScreen.prototype._commitSave = function() {
        if (typeof this._onSave === 'function') {
            var r = this._onSave(this.inputText);
            return (r === undefined) ? 'pop' : r;
        }
        return 'pop';
    };

    // Mirror for the "leave the scene without committing" path
    // — Cancel in the bottom bar and Discard in the modal.
    TextInputScreen.prototype._commitDiscard = function() {
        if (typeof this._onDiscard === 'function') {
            var r = this._onDiscard();
            return (r === undefined) ? 'pop' : r;
        }
        return 'pop';
    };

    // Hand focus to the named tab. The keyboard keeps its last
    // (row, col) so we can drop back into the same cell when
    // the user steps Up out of the tab — `setFocused` collapses
    // the wave + suppresses the selector pass.
    TextInputScreen.prototype._focusTab = function(tabName) {
        if (this._focus === tabName) return;
        this._focus = tabName;
        this._123Btn.selected       = (tabName === 'tab123');
        this._backspaceBtn.selected = (tabName === 'tabBackspace');
        if (this.keyboard) this.keyboard.setFocused(false);
        // Moving onto / between the 123 and backspace tabs → effect 3,
        // 10 ms (same tick as the per-key moves).
        this._playHaptic(3, 10);
        if (window.requestRender) window.requestRender();
    };

    // Reverse direction — return focus to the keyboard. The
    // selection coordinates the keyboard kept while it was
    // defocused light up again as soon as `setFocused(true)`
    // re-enables its selector pass.
    TextInputScreen.prototype._focusKeyboard = function() {
        if (this._focus === 'keyboard') return;
        var prev = this._focus;
        this._focus = 'keyboard';
        this._123Btn.selected       = false;
        this._backspaceBtn.selected = false;
        if (this.keyboard) this.keyboard.setFocused(true);
        // Focus-switch buzz: from the input field → effect 2 (full);
        // from a 123 / backspace tab → effect 3, 10 ms.
        if (prev === 'inputField') this._playHaptic(2);
        else if (prev === 'tab123' || prev === 'tabBackspace') this._playHaptic(3, 10);
        if (window.requestRender) window.requestRender();
    };

    // Move focus up onto the input field. Keyboard goes inactive
    // (selector hidden, wave collapsed) while the user steers
    // the text cursor inside the field with Left/Right arrows.
    // Down returns focus to the keyboard via `_focusKeyboard`
    // (see handleInput).
    TextInputScreen.prototype._focusInputField = function() {
        if (this._focus === 'inputField') return;
        this._focus = 'inputField';
        this._123Btn.selected       = false;
        this._backspaceBtn.selected = false;
        if (this.keyboard) this.keyboard.setFocused(false);
        if (this.cursor) this.cursor.reset();
        // Switching up onto the input field → effect 2, full length.
        this._playHaptic(2);
        if (window.requestRender) window.requestRender();
    };

    TextInputScreen.prototype._handleTouchpadMessage = function(e) {
        if (!this.keyboard) return;
        var p = e.data.split(',');
        if (p.length < 3) return;
        var nx = +p[0], ny = +p[1], nt = +p[2];
        if (nx !== nx || ny !== ny || (nt !== 0 && nt !== 1)) return;

        var nowTouching  = (nt === 1);
        var prevTouching = this._tpTouching;

        if (nowTouching && !prevTouching) {
            // Touch-down: anchor the drag to where the finger
            // landed. The baseline row tracks the focused
            // control so a single step of dy naturally crosses
            // any focus boundary:
            //   • Input field is row -1 (virtual, above keyboard
            //     row 0). Baseline col = current text-cursor
            //     index so dx maps to cursor movement.
            //   • Keyboard rows are 0..N-1. Baseline = the
            //     keyboard's current (selectedRow, selectedCol).
            //   • Tab strip is row N (virtual, below the keyboard
            //     last row). Baseline col is parked at the centre
            //     of the currently-focused tab so re-entry into
            //     the keyboard re-aligns on the cells below.
            this._tpBaselineX = nx;
            this._tpBaselineY = ny;
            if (this._focus === 'inputField') {
                this._tpBaselineRow = -1;
                this._tpBaselineCol = this._inputCursor;
            } else if (this._focus === 'tab123' || this._focus === 'tabBackspace') {
                this._tpBaselineRow = this.keyboard.rows.length;
                this._tpBaselineCol = (this._focus === 'tab123') ? 2 : 9;
            } else {
                this._tpBaselineRow = this.keyboard.selectedRow;
                this._tpBaselineCol = this.keyboard.selectedCol;
            }
        }

        if (nowTouching) {
            // Live drag: target row/col = baseline + (delta / step).
            // Raw deltas are first divided by TP_SLOW_DIVIDER so
            // the user can dial the overall pad-to-keyboard ratio
            // up or down without rebalancing the per-axis step
            // constants. Math.round then ticks the selection one
            // cell every effective ±STEP of finger motion.
            var dx = (nx - this._tpBaselineX) / TP_SLOW_DIVIDER;
            var dy = (ny - this._tpBaselineY) / TP_SLOW_DIVIDER;
            var targetRow = this._tpBaselineRow + Math.round(dy / TP_Y_UNITS_PER_STEP);
            var targetCol = this._tpBaselineCol + Math.round(dx / TP_X_UNITS_PER_STEP);
            // Vertical position-to-target resolution. Rows go:
            //   row < 0            → above row 0, input field.
            //   row 0..N-1         → keyboard rows.
            //   row >= rows.length → tab strip is the dead-end.
            //                        Tab focus when the column is
            //                        over its x footprint;
            //                        otherwise clamp to the last
            //                        keyboard row. Continuing to
            //                        drag down does NOT wrap onto
            //                        the numeric row — that path
            //                        is intentionally D-pad-only.
            var lastKbRow      = this.keyboard.rows.length - 1;
            var onTab          = (this._focus === 'tab123' || this._focus === 'tabBackspace');
            var onInputField   = (this._focus === 'inputField');
            if (targetRow < 0) {
                if (!onInputField) {
                    // First frame in the input field. Switch
                    // focus and re-anchor the touchpad baseline
                    // to the current finger position, with the
                    // row baseline at -1 (virtual input-field
                    // row) and the column baseline at the
                    // existing _inputCursor. This way, entry
                    // into the field doesn't shift the | — only
                    // subsequent finger movement does, and dx
                    // maps to cursor movement relative to where
                    // it sat before the user reached up.
                    this._focusInputField();
                    this._tpBaselineX   = nx;
                    this._tpBaselineY   = ny;
                    this._tpBaselineRow = -1;
                    this._tpBaselineCol = this._inputCursor;
                } else {
                    // Continuing in the input field — translate
                    // the column delta into a cursor delta.
                    var maxCursor = this.inputText.length;
                    var newCursor = targetCol;
                    if (newCursor < 0)         newCursor = 0;
                    if (newCursor > maxCursor) newCursor = maxCursor;
                    if (newCursor !== this._inputCursor) {
                        this._inputCursor = newCursor;
                        if (this.cursor) this.cursor.reset();
                    }
                }
            } else if (targetRow >= this.keyboard.rows.length) {
                var tabName = this._tabForCol(targetCol);
                if (tabName) {
                    this._focusTab(tabName);
                } else {
                    if (onTab || onInputField) this._focusKeyboard();
                    this._tpSetSelection(lastKbRow, targetCol);
                }
            } else {
                if (onTab || onInputField) this._focusKeyboard();
                this._tpSetSelection(targetRow, targetCol);
            }
        }

        this._tpTouching = nowTouching;
        if (window.requestRender) window.requestRender();
    };

    TextInputScreen.prototype.handleInput = function(action) {
        // Discard-confirmation modal owns input while it's open
        // — eats every action so the underlying scene can't
        // process keystrokes behind the dim. Back / Esc dismiss
        // the modal back to the keyboard; arrows toggle between
        // Cancel and Discard; OK runs whichever is highlighted.
        if (this._discardModal && this._discardModal.open) {
            if (action === 'esc' || action === 'back') {
                this._discardModal.open = false;
                if (window.requestRender) window.requestRender();
                return;
            }
            if (action === 'up' || action === 'down'
                    || action === 'left' || action === 'right') {
                this._discardModal.buttonIndex = 1 - this._discardModal.buttonIndex;
                if (window.requestRender) window.requestRender();
                return;
            }
            if (action === 'ok') {
                // Keep (index 0) just dismisses the modal — the
                // user is staying in the keyboard with their
                // typed text intact. Discard (index 1) routes
                // through `_commitDiscard` to leave the scene.
                this._discardModal.open = false;
                if (this._discardModal.buttonIndex === 0) {
                    if (window.requestRender) window.requestRender();
                    return;
                }
                return this._commitDiscard();
            }
            return;
        }

        // Any exit attempt — Cancel button ('esc' from z) or
        // Back arrow ('back' from Backspace / Escape) — opens
        // the discard prompt only when the user has actually
        // changed something. If the current text is identical
        // to whatever the field was seeded with on enter,
        // exiting can't lose any work, so we skip straight to
        // the discard path: 'esc' falls through to the Cancel
        // bottom-button below; 'back' commits the discard
        // directly.
        var hasChanges = typeof this.inputText === 'string'
                       && this.inputText !== this._initialText;
        if ((action === 'esc' || action === 'back') && hasChanges) {
            this._discardModal.open = true;
            this._discardModal.buttonIndex = 0;
            if (window.requestRender) window.requestRender();
            return;
        }
        if (action === 'back') {
            // Unchanged Back: nothing to discard, just leave.
            return this._commitDiscard();
        }

        // Bottom-bar buttons take priority — flash + run their
        // onPress, then handle the consequence (pop) ourselves so
        // the press feedback reads cleanly.
        var btn = this._btnActionMap[action];
        if (btn) {
            // Disabled buttons swallow the press entirely — no
            // flash, no onPress, no consequence. Used by Done
            // while validate() returns a warning so the user
            // can't sneak an invalid value through.
            if (btn.disabled) return;
            btn.press();
            if (btn.onPress) btn.onPress();
            if (window.requestRender) window.requestRender();
            var self = this;
            setTimeout(function() {
                btn.release();
                if (window.requestRender) window.requestRender();
            }, 30);
            // 'esc' (Cancel) and 'run' (Done) both leave the
            // scene, but through different consumer callbacks:
            // Done = save (commit), Cancel = discard (no commit).
            // The button-flash above gets a frame to render
            // before the scene-pop ripples up.
            if (action === 'run') return this._commitSave();
            if (action === 'esc') return this._commitDiscard();
            return;
        }
        // Focus-on-tab branch. Arrows + OK are handled at the
        // scene level here so they never reach the keyboard
        // (which would scroll its own hidden selection). Up
        // returns to the keyboard; OK fires the tab's onPress
        // (same effect as the X hardware key flashes above when
        // routed through `_btnActionMap`).
        //
        // Input-field branch handles its own cursor navigation:
        // Left / Right move the | inside the typed text, Down
        // hands focus back onto the keyboard at row 0. Up / OK
        // are no-ops (nothing above the field, no commit yet).
        if (this._focus === 'inputField') {
            if (action === 'left') {
                if (this._inputCursor > 0) this._inputCursor--;
                if (this.cursor) this.cursor.reset();
                if (window.requestRender) window.requestRender();
                return;
            }
            if (action === 'right') {
                if (this._inputCursor < this.inputText.length) this._inputCursor++;
                if (this.cursor) this.cursor.reset();
                if (window.requestRender) window.requestRender();
                return;
            }
            if (action === 'down') {
                this._focusKeyboard();
                if (this.keyboard && this.keyboard.snapToRow) {
                    this.keyboard.snapToRow(0);
                }
                return;
            }
            return;
        }
        if (this._focus === 'tab123' || this._focus === 'tabBackspace') {
            var focusedBtn = this._btnForTab(this._focus);
            if (action === 'up') {
                this._focusKeyboard();
                return;
            }
            if (action === 'down') {
                // Step past the tab onto the keyboard's numeric
                // row (row 0 — peek in ABC, numbers in SYM). The
                // column snaps to the x-aligned cell so vertical
                // navigation tracks finger / cursor position.
                this._focusKeyboard();
                if (this.keyboard && this.keyboard.snapToRow) {
                    this.keyboard.snapToRow(0);
                }
                return;
            }
            if (action === 'ok' && focusedBtn) {
                focusedBtn.press();
                if (focusedBtn.onPress) focusedBtn.onPress();
                if (window.requestRender) window.requestRender();
                setTimeout(function() {
                    focusedBtn.release();
                    if (window.requestRender) window.requestRender();
                }, 30);
                return;
            }
            // left / right / back: no-op for now — lateral nav
            // between the tabs (and into Cancel / Done) isn't
            // part of the current spec.
            return;
        }
        // Keyboard-focused branch. Intercept Down at the bottom
        // row so the cursor hops onto the tab whose x footprint
        // the outgoing column sits over (123 on the left, the
        // backspace tab on the right). Other cols fall through
        // to the keyboard's normal wrap-to-row-0 behaviour.
        if (action === 'down' && this.keyboard
                && this.keyboard.selectedRow === this.keyboard.rows.length - 1) {
            var targetTab = this._tabForCol(this.keyboard.selectedCol);
            if (targetTab) {
                this._focusTab(targetTab);
                return;
            }
        }
        // Intercept Up on the top keyboard row (row 0 — peek in
        // ABC, numbers in SYM) so the cursor steps onto the
        // input field above instead of wrapping to the bottom.
        // The keyboard keeps its (row, col); a follow-up Down
        // from the input field brings the user back to row 0.
        if (action === 'up' && this.keyboard
                && this.keyboard.selectedRow === 0) {
            this._focusInputField();
            return;
        }
        // Auto-repeat suppression for the shift tap-toggle. Browser
        // keyboards fire repeated keydown events while a key is
        // held, which would oscillate `shiftState` back-and-forth
        // through `off ↔ shift` during a long press. The first
        // press sets `_shiftToggledThisPress` here; subsequent OK
        // actions during the same hold are ignored (visually the
        // press flash also stays clamped to one tap). Cleared on
        // keyup by the long-press handler.
        if (action === 'ok' && this._isHighlightOnShift()) {
            if (this._shiftToggledThisPress) return;
            this._shiftToggledThisPress = true;
        }
        if (this.keyboard) {
            // Keyboard returns the sentinel string 'done' when
            // the user OKs the on-screen return key. Map that to
            // the same pop the bottom-bar Done button triggers
            // so the test scene closes consistently from either
            // affordance. Future consumers (multi-line text
            // input) can ignore the return value or wire it up
            // differently.
            var kbResult = this.keyboard.handleInput(action);
            if (kbResult === 'done') return 'pop';
        }
    };

    // Greedy word-wrap for the big composer field. Returns
    // [{ start, end, str }] with character offsets into `text`
    // (end exclusive) so the cursor index maps onto a line.
    // Overlong words hard-break mid-word.
    TextInputScreen.prototype._wrapInputText = function(text, maxW) {
        var F = HaxrCorp4090FlipCTL;
        var lines = [];
        if (!text) return lines;
        var start = 0, i = 0, lastSpace = -1;
        while (i < text.length) {
            var slice = text.slice(start, i + 1);
            if (F.textWidth(slice) > maxW && i > start) {
                var brk = (lastSpace > start) ? lastSpace + 1 : i;
                lines.push({ start: start, end: brk,
                             str: text.slice(start, brk) });
                start = brk;
                lastSpace = -1;
                continue;
            }
            if (text[i] === ' ') lastSpace = i;
            i++;
        }
        lines.push({ start: start, end: text.length,
                     str: text.slice(start) });
        return lines;
    };

    TextInputScreen.prototype.render = function(canvas) {
        var ctx = canvas.ctx;
        canvas.clear('#fff');

        // Status bar (kept on top — modal frame sits below it).
        UI.drawStatusBar(canvas, '');

        // Title text centred above the input field. Driven by
        // `this.fieldTitle` so consumers can swap the caption
        // per-form without touching the scene; left blank skips
        // the render entirely. Math.round so even/odd widths
        // round to the same nearest pixel as the input field
        // does — keeps title and field visually anchored on the
        // same axis.
        // Big composer: the title/counter line rides 2 px higher so
        // it clears the taller input box (top at y=31).
        var titleY = this._bigField ? 20 : 24;
        if (this.fieldTitle) {
            var titleW = HaxrCorp4090FlipCTL.textWidth(this.fieldTitle);
            var titleX = Math.round((canvas.w - titleW) / 2);
            HaxrCorp4090FlipCTL.draw(ctx, this.fieldTitle, titleX, titleY, '#000');
        }
        // Remaining-characters counter, flush right on the title
        // line (only when a maxLen budget was configured).
        if (this._maxLen !== null) {
            var chLeft = Math.max(0, this._maxLen - this.inputText.length);
            var chTxt  = chLeft + ' left';
            HaxrCorp4090FlipCTL.draw(ctx, chTxt,
                canvas.w - 4 - HaxrCorp4090FlipCTL.textWidth(chTxt),
                titleY, '#696969');
        }

        // Input field auto-sizing. Starts 150 px wide; grows
        // with the typed text up to a 238 px cap. Padding is
        // 6 px on each side, so the inner text area runs from
        // 138 px (at the 150-wide minimum) up to 226 px (at the
        // 238-wide cap). Beyond that, text gets truncated with
        // `<.` / `.>` markers — HaxrCorp4090FlipCTL has no triple-dot
        // glyph, so we use a single period each side.
        var INPUT_PAD       = 6;
        var INPUT_MIN_W     = 150;
        var INPUT_MAX_W     = 238;
        var inputH, inputW, inputX, inputY;
        if (this._bigField) {
            // Composer box — exact geometry from the design mock:
            // (4, 31), 246 × 35.
            inputX = 4;
            inputY = 31;
            inputW = 246;
            inputH = 35;
        } else {
            inputH = 14;
            var fullTextWidth = HaxrCorp4090FlipCTL.textWidth(this.inputText);
            inputW = fullTextWidth + INPUT_PAD * 2;
            if (inputW < INPUT_MIN_W) inputW = INPUT_MIN_W;
            if (inputW > INPUT_MAX_W) inputW = INPUT_MAX_W;
            // Centre the field horizontally as it grows so the title
            // and field stay visually anchored to the same axis.
            // Math.round matches the title's centering — both pick
            // the same side when (canvas.w - w) is odd.
            inputX = Math.round((canvas.w - inputW) / 2);
            inputY = titleY + 14;
        }
        var inputFrame = new ResponsiveFrame({
            x: inputX, y: inputY,
            width: inputW, height: inputH,
            anchorH: 'left', anchorV: 'top',
            showStroke: false,
            fillColor: '#CCCCCC', showFill: true,
            cornerRadius: 3,
            corners: { tl: true, tr: true, bl: true, br: true }
        });
        inputFrame.render(canvas);

        // 2-px black selector frame around the input field when
        // it owns focus — matches the keyboard-cell selection
        // style. ResponsiveFrame handles arbitrary corner radii
        // (drawRoundFrame only ships with r=2/3 tables), so we
        // use it here for both the inner ring (at the field's
        // r=3 contour) and the outer ring (1 px outside, r=4).
        if (this._focus === 'inputField') {
            new ResponsiveFrame({
                x: inputX - 1, y: inputY - 1,
                width: inputW + 2, height: inputH + 2,
                anchorH: 'left', anchorV: 'top',
                showStroke: true, strokeColor: '#000', showFill: false,
                cornerRadius: 4,
                corners: { tl: true, tr: true, bl: true, br: true }
            }).render(canvas);
            new ResponsiveFrame({
                x: inputX, y: inputY,
                width: inputW, height: inputH,
                anchorH: 'left', anchorV: 'top',
                showStroke: true, strokeColor: '#000', showFill: false,
                cornerRadius: 3,
                corners: { tl: true, tr: true, bl: true, br: true }
            }).render(canvas);
        }

        // Typed text + blinking cursor inside the input field.
        // The cursor sits at `_inputCursor` so it can travel
        // through the text with Left / Right rather than always
        // hugging the right edge. When the text overruns the
        // visible inner width we truncate with single-period
        // markers (HaxrCorp4090FlipCTL doesn't ship a triple-dot
        // glyph), keeping the cursor in view.
        this.cursor.update();
        if (this._bigField) {
            // Word-wrapped, top-left anchored text. When the text
            // outgrows the box the window slides so the cursor's
            // line stays visible (tail-anchored while typing).
            var bTextX  = inputX + INPUT_PAD;
            var bTextY  = inputY + 4;
            var bInnerW = inputW - INPUT_PAD * 2;
            var LINE_H  = 11;
            var maxLines = Math.floor((inputH - 8) / LINE_H) + 1;   // 3
            var lines = this._wrapInputText(this.inputText, bInnerW);
            // Locate the cursor's line.
            var curLine = 0;
            for (var li = 0; li < lines.length; li++) {
                if (this._inputCursor >= lines[li].start
                        && this._inputCursor <= lines[li].end) curLine = li;
            }
            var first = Math.max(0, Math.min(lines.length - maxLines,
                                             curLine - (maxLines - 1)));
            if (lines.length <= maxLines) first = 0;
            for (var ln = first; ln < Math.min(lines.length, first + maxLines); ln++) {
                var rowY = bTextY + (ln - first) * LINE_H;
                HaxrCorp4090FlipCTL.draw(ctx, lines[ln].str, bTextX, rowY, '#000');
                if (this.cursor.isVisible() && ln === curLine) {
                    var cx = bTextX + HaxrCorp4090FlipCTL.textWidth(
                        lines[ln].str.slice(0, this._inputCursor - lines[ln].start)) + 1;
                    canvas.drawCursor(cx, rowY, 1, 11, '#000');
                }
            }
            // Empty text: still blink the cursor at the box origin.
            if (lines.length === 0 && this.cursor.isVisible()) {
                canvas.drawCursor(bTextX + 1, bTextY, 1, 11, '#000');
            }
        } else {
        var textX  = inputX + INPUT_PAD;
        var textY  = inputY + Math.floor((inputH - 11) / 2);
        var innerW = inputW - INPUT_PAD * 2;
        var seg = this._fitInputText(this.inputText, this._inputCursor, innerW);
        var LEFT_MARKER  = '<...';
        var RIGHT_MARKER = '...>';
        var visibleText = (seg.leftMarker ? LEFT_MARKER : '')
            + this.inputText.slice(seg.left, seg.right)
            + (seg.rightMarker ? RIGHT_MARKER : '');
        HaxrCorp4090FlipCTL.draw(ctx, visibleText, textX, textY, '#000');
        if (this.cursor.isVisible()) {
            var leftMW = seg.leftMarker ? HaxrCorp4090FlipCTL.textWidth(LEFT_MARKER) : 0;
            var cursorX = textX + leftMW
                + HaxrCorp4090FlipCTL.textWidth(this.inputText.slice(seg.left, this._inputCursor))
                + 1;
            canvas.drawCursor(cursorX, textY, 1, 11, '#000');
        }
        }

        // Live validation message — drawn 3 px below the input
        // frame, centred horizontally. The validator decides on
        // every render whether the current text deserves a
        // warning (e.g. duplicate filename). Returning an empty
        // string or null suppresses the row entirely.
        var warning = this._validate ? this._validate(this.inputText) : null;
        if (warning) {
            var ww = HaxrCorp4090FlipCTL.textWidth(warning);
            HaxrCorp4090FlipCTL.draw(ctx, warning,
                Math.round((canvas.w - ww) / 2),
                inputY + inputH + 3, '#000');
        }
        // Disable Done when the validator is unhappy — the
        // disabled chrome (light-gray fill, dim text) tells the
        // user the commit won't go through. handleInput also
        // gates 'run' on the same check so the press itself
        // can't sneak past.
        if (this._doneBtn) {
            this._doneBtn.disabled = !!warning;
        }

        // Keyboard renders the chrome + cells, then via the
        // interlayer callback hands off to the bottom-button row,
        // then finishes with its selector frame ON TOP. That
        // ordering lets the keyboard's selection ring sit visually
        // in front of the 123 tab when they overlap (and the 123
        // tab sits on top of the keyboard's empty bottom margin).
        var self = this;
        this.keyboard.render(canvas, function() {
            for (var bi = 0; bi < self._bottomBtns.length; bi++) {
                var bb = self._bottomBtns[bi];
                if (bb) bb.render(canvas);
            }
        });

        // Tab-button selectors render LAST so their wraparound
        // strokes layer on top of any keyboard pixels that might
        // overlap (e.g., the selector-frame outer ring of the
        // keyboard cell directly above them during transitions).
        if (this._123Btn && this._123Btn.renderSelector) {
            this._123Btn.renderSelector(canvas);
        }
        if (this._backspaceBtn && this._backspaceBtn.renderSelector) {
            this._backspaceBtn.renderSelector(canvas);
        }

        // Discard-confirmation modal renders LAST so it sits on
        // top of everything else (keyboard, tabs, bottom-bar
        // selectors). The wash inside `_renderDiscardModal` dims
        // the page underneath.
        if (this._discardModal && this._discardModal.open) {
            this._renderDiscardModal(canvas);
        }
    };

    return TextInputScreen;
})();

// Backward-compatible alias. Boot menu / debug-config / app
// switcher entries still reference `KeyboardTestScene`; pointing
// it at the canonical `TextInputScreen` constructor keeps those
// call sites working without changes. New consumers (e.g. the
// Wi-Fi password modal) should instantiate `TextInputScreen`
// directly with an options object.
var KeyboardTestScene = TextInputScreen;
