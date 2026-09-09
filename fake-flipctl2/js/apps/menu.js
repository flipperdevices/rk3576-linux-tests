var MenuScene = (function() {
    // Layout mirrors the submenu — same container anchor, same selector
    // geometry (including the scroll / no-scroll width switch), same
    // scrollbar geometry.
    var CONTAINER_X = 5;
    var CONTAINER_Y = UI.STATUS_BAR_H + 12;    // 25 for the default 13px status bar
    var CONTAINER_W = 224;
    var DIVIDER_COLOR = '#CCCCCC';
    var ANIMATED_ICON_FRAME_MS = 200;

    // Viewport: the menu area fits 5 lines (5*20 + 4 dividers = 104px).
    // When the list is longer, scroll.
    var VISIBLE_COUNT = 5;
    var VIEWPORT_H = VISIBLE_COUNT * 20 + (VISIBLE_COUNT - 1); // 104
    var SCROLLBAR_X         = 253;
    var SCROLLBAR_Y         = 15;
    var SCROLLBAR_H         = 127;
    var SCROLLBAR_THUMB_PAD = 1;

    // MenuSelectorFrame around the selected line. Width depends on
    // scrollbar visibility — matches the submenu treatment.
    var SELECTOR_X            = 4;
    var SELECTOR_W_WITH_SCROLL = 244;
    var SELECTOR_W_NO_SCROLL   = 247;
    var SELECTOR_H            = 22;
    var SELECTOR_CORNER_R     = 3;
    var SELECTOR_Y_OFFSET     = -1;

    var menuItems = [
        'Router',
        'Boot Menu',
        'Apps',
        'Files',
        'Network',
        'Testing',
        'Settings'
    ];

    // Active boot-target profile for the current menu session (set by
    // the MenuScene constructor). Lets appsMenu drop TV Media Box from
    // the Apps list when that app has moved up to the main-menu first
    // slot (TV Media Box target).
    var _menuTargetProfile = '';

    // Modal shown when the user tries to open 5G Modem while airplane
    // mode is on. Transparent overlay under a ResponsiveFrame with a
    // two-line message and two app-defined buttons (Cancel / Turn off).
    function makeAirplaneBlockModal(submenu) {
        var FRAME_X = 16, FRAME_Y = 40;
        var FRAME_W = 224, FRAME_H = 60;

        var cancelBtn = new UI.LeftButton('Cancel', 48, 'esc', function() {
            submenu.closeModal();
        });
        var turnOffBtn = new UI.RightButton('Turn off', 48, 'run', function() {
            UI.setAirplaneMode(false);
            submenu.closeModal();
            // Proceed to the original 5G Modem action.
            submenu.sceneManager.push(new Modem5gScene());
        });

        return {
            handleInput: function(action) {
                var btn = null;
                if (action === 'back' || action === 'esc') btn = cancelBtn;
                else if (action === 'ok' || action === 'run')  btn = turnOffBtn;
                if (!btn) return false;
                btn.press();
                if (window.requestRender) window.requestRender();
                setTimeout(function() {
                    btn.release();
                    if (btn.onPress) btn.onPress();
                    if (window.requestRender) window.requestRender();
                }, 30);
                return true;
            },
            render: function(canvas) {
                // Transparent overlay under the modal content.
                canvas.ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
                canvas.ctx.fillRect(0, 0, canvas.w, canvas.h);

                // Frame.
                var frame = new ResponsiveFrame({
                    x: FRAME_X, y: FRAME_Y,
                    width: FRAME_W, height: FRAME_H,
                    anchorH: 'left', anchorV: 'top',
                    strokeColor: '#000', showStroke: true,
                    fillColor: '#ffffff', showFill: true,
                    cornerRadius: 3
                });
                frame.render(canvas);

                // Message (HaxrCorp4090FlipCTL, centred).
                var lines = [
                    'To use 5G Modem you need',
                    'to turn off Airplane mode'
                ];
                var lineH = 11;
                var totalH = lines.length * lineH;
                var startY = FRAME_Y + Math.floor((FRAME_H - totalH) / 2);
                for (var i = 0; i < lines.length; i++) {
                    var w = HaxrCorp4090FlipCTL.textWidth(lines[i]);
                    var x = Math.floor((canvas.w - w) / 2);
                    HaxrCorp4090FlipCTL.draw(canvas.ctx, lines[i], x, startY + i * lineH, '#000');
                }

                // Buttons.
                cancelBtn.render(canvas);
                turnOffBtn.render(canvas);
            }
        };
    }

    function networkMenu(sm) {
        var subMenu = new SubMenuScene(sm, 'Network', [
            'Airplane mode',
            'Routing info',
            '5G Modem',
            'Wi-Fi',
            'Ethernet'
        ], {
            'Routing info': function() { return new RoutingScene(); },
            '5G Modem': function(submenu) {
                if (UI.getAirplaneMode()) {
                    submenu.showModal(makeAirplaneBlockModal(submenu));
                    return null;
                }
                return new Modem5gScene();
            },
            'Wi-Fi':    function() { return new WifiScene(sm); },
            'Ethernet': function() { return new EthernetScene(sm); }
            // 'Airplane mode' has no factory — it's a toggle (see below).
        });
        // Treat Network as a first-class app in the App Switcher:
        // enter() registers it with RunningApps, exit() snapshots it.
        // The factoryFn is used when the user picks the Network card
        // from the switcher to re-open a fresh instance.
        subMenu.markAsApp(Icons.network, function(reSm) { return networkMenu(reSm || sm); });

        var iconMap = {
            'Routing info': Icons.info_icon,
            '5G Modem': Icons.modem_5g,
            'Wi-Fi': Icons.wifi,
            'Ethernet': Icons.ethernet,
            'Airplane mode': Icons.airplane_mode
        };
        var animatedIconMap = {
            'Airplane mode': AnimatedIcons.airplane_mode_animated
        };
        for (var i = 0; i < subMenu.items.length; i++) {
            var name = subMenu.items[i].text;
            subMenu.items[i].icon = iconMap[name] || null;
            subMenu.items[i].iconAnimated = animatedIconMap[name] || null;
        }

        // Wi-Fi row shows the current state pulled live from the
        // UI polling state each render. Three branches:
        //   • radio off  → 'OFF' (matches the toggle label inside
        //                  the Wi-Fi page so the two screens
        //                  agree at a glance)
        //   • connected  → SSID (or 'connected' fallback)
        //   • idle       → 'not connected'
        for (var j = 0; j < subMenu.items.length; j++) {
            if (subMenu.items[j].text === 'Wi-Fi') {
                subMenu.items[j].statusProvider = function() {
                    if (!UI.getWifiEnabled()) return 'OFF';
                    var w = UI.getWifiInfo();
                    if (!w.connected) return 'not connected';
                    return w.ssid || 'connected';
                };
                break;
            }
        }

        // 5G Modem row surfaces the "Airplane mode" state so the user
        // understands why tapping it will be blocked.
        for (var m = 0; m < subMenu.items.length; m++) {
            if (subMenu.items[m].text === '5G Modem') {
                subMenu.items[m].statusProvider = function() {
                    return UI.getAirplaneMode() ? 'Airplane mode' : null;
                };
                break;
            }
        }

        // Airplane mode: a live ON/OFF toggle wired to the real device
        // state via UI.getAirplaneMode / UI.setAirplaneMode. The setter
        // optimistically updates local state and calls the server; the
        // 3s poll reconciles if anything drifts.
        for (var k = 0; k < subMenu.items.length; k++) {
            if (subMenu.items[k].text === 'Airplane mode') {
                var line = subMenu.items[k];
                line.statusProvider = function() {
                    return UI.getAirplaneMode() ? '< ON >' : '< OFF >';
                };
                line.onToggle = function() {
                    UI.setAirplaneMode(!UI.getAirplaneMode());
                };
                break;
            }
        }

        return subMenu;
    }

    function testingMenu(sm) {
        return new SubMenuScene(sm, 'Testing', [
            'Screen',
            'Screen for photos',
            'UI Demos',
            'Input',
            'Touchpad',
            'Touchpad ABS',
            'Screen Keyboard',
            'Network LEDs',
            'Sound',
            'UIinput forwarding',
            'Haptic tests',
            'Figma live preview',
            'UI PNG viewer',
            'GPIO',
            'Switch to fake-flipctl'
        ], {
            'Screen': function() { return new ScreenTestScene(); },
            'Screen for photos': function() { return new ScreenForPhotosScene(sm); },
            'UI Demos': function() { return demoMenu(sm); },
            'Touchpad': function() { return new TouchpadTestScene(); },
            'Touchpad ABS': function() { return new TouchpadAbsScene(); },
            'Screen Keyboard': function() { return new KeyboardTestScene(); },
            'Network LEDs': function() { return new NetworkLedsScene(sm); },
            'Sound': function() { return new SoundMenuScene(sm); },
            'UIinput forwarding': function() { return new UIInputForwardingScene(sm); },
            'Haptic tests': function() { return new HapticTestScene(sm); },
            'Figma live preview': function() { return new FigmaLivePreviewScene(sm); },
            'UI PNG viewer': function() { return new UiPngViewerScene(sm); },
            'Switch to fake-flipctl': function() {
                fetch('/api/switch/flipctl', { method: 'POST' });
                return null;
            }
        });
    }

    // Testing → UI Demos bucket. Hosts the design-only UI demo
    // scenes we don't want polluting the top of the Testing
    // submenu. Add new "* - UI demo" entries here as they land.
    function demoMenu(sm) {
        return new SubMenuScene(sm, 'UI Demos', [
            'Boot menu - UI demo',
            'Boot Menu v3',
            'MESHCORE',
            'Power menu - UI demo'
        ], {
            'Boot menu - UI demo':  function() { return new UIDemoScene(sm); },
            'Boot Menu v3':         function() { return new BootMenuV2DemoScene(sm); },
            'MESHCORE':             function() { return new MeshcoreDemoScene(sm); },
            'Power menu - UI demo': function() { return new PowerMenuUIDemoScene(sm); }
        });
    }

    function appsMenu(sm) {
        // App registry. Single source of truth for each app's
        // icon (shown next to the entry in this submenu *and* in
        // the App Switcher's title bar). Two flavours:
        //
        //   • Placeholder apps — provide `image` (PNG mockup);
        //     the factory wraps PlaceholderAppScene so the row
        //     opens the static asset.
        //   • Real apps — provide `factory: function(sm) { ... }`
        //     returning a custom scene. The icon still drives
        //     the menu row; image is ignored.
        //
        // Adding a placeholder: drop a PNG into assets/apps/ and
        // add an `image` + `icon` entry.
        // Adding a real app: register the script in index.html,
        // add an `icon` + `factory` entry below.
        // Per-entry shape:
        //   icon          — STATIC sprite (single frame) shown
        //                   in the menu row when unselected,
        //                   AND in the App Switcher card title
        //                   bar (which is animation-unaware).
        //   iconAnimated  — OPTIONAL multi-frame strip; MenuLine
        //                   plays it at FRAME_MS cadence while
        //                   the row is selected. Same convention
        //                   the main menu's Settings / Network /
        //                   etc. use.
        //   image         — placeholder PNG mockup; only used by
        //                   the PlaceholderAppScene factory.
        //   factory       — custom scene factory; replaces the
        //                   placeholder path entirely.
        // Real apps only — mock placeholders (Media / NMap /
        // "Yet another app" / Router) have been removed. Add new
        // entries here with a `factory(sm)` that returns the
        // real scene instance; PlaceholderAppScene fallback is
        // gone too.
        var APPS = {
            'Internet radio':  { factory: function(sm) { return new InternetRadioScene(sm); },
                                 // No dedicated static — MenuLine
                                 // draws frame 0 of `iconAnimated`
                                 // when no `icon` is supplied,
                                 // which is exactly the visual we
                                 // want for the unselected row.
                                 icon:         null,
                                 iconAnimated: (typeof AnimatedIcons !== 'undefined')
                                     ? AnimatedIcons.internet_radio_anim
                                     : null },
            'Voice recorder':  { factory:      function(sm) { return new VoiceRecorderScene(sm); },
                                 icon:         Icons.voice_recorder,
                                 iconAnimated: null },
            'Walkie Talkie':   { factory:      function(sm) { return new WalkieTalkieScene(sm); },
                                 // No dedicated static — MenuLine
                                 // draws frame 0 of `iconAnimated`
                                 // for the unselected row, same as
                                 // Internet radio above.
                                 icon:         null,
                                 iconAnimated: (typeof AnimatedIcons !== 'undefined')
                                     ? AnimatedIcons.walkie_talkie
                                     : null },
            'TV Media Box':    { factory:      function(sm) { return new TVMediaBoxScene(sm); },
                                 // Media glyph (grayscale), matching the
                                 // app's title bar + App Switcher card.
                                 icon:         (typeof Icons !== 'undefined')
                                     ? Icons.media : null,
                                 iconAnimated: null }
        };
        var order = ['Internet radio', 'Voice recorder', 'Walkie Talkie', 'TV Media Box'];
        // With the TV Media Box target active, that app lives in the
        // main menu's first slot — drop it from Apps to avoid showing
        // it twice.
        if (_menuTargetProfile === 'TV Media Box') {
            order = order.filter(function(n) { return n !== 'TV Media Box'; });
        }

        var factories = {};
        order.forEach(function(name) {
            var def = APPS[name];
            factories[name] = function() {
                // Every remaining app supplies a real factory.
                // PlaceholderAppScene is no longer used here —
                // the mock entries that depended on it are gone.
                return def.factory(sm);
            };
        });

        var subMenu = new SubMenuScene(sm, 'Apps', order, factories);

        // Surface each app's icon in the menu row so the Apps list
        // matches the App Switcher visually. Animated strips live
        // in `iconAnimated` — MenuLine plays them on selection;
        // unselected rows render `icon` (the static frame).
        for (var i = 0; i < subMenu.items.length; i++) {
            var entryName = subMenu.items[i].text;
            var entryDef  = APPS[entryName];
            subMenu.items[i].icon         = entryDef.icon;
            subMenu.items[i].iconAnimated = entryDef.iconAnimated || null;
        }

        return subMenu;
    }

    function settingsMenu(sm) {
        var subMenu = new SubMenuScene(sm, 'Settings', [
            'System info',
            'Battery info',
            'Disk info',
            'Update',
            'Reboot'
        ], {
            'Battery info': function() { return new PowerScene(); },
            'Disk info':    function() { return new DiskSpaceScene(); },
            'Update':       function() { return new UpdateScene(); },
            // Fire-and-forget POST. Server runs `sudo reboot` in a
            // detached unit so the response flushes before the OS
            // tears the connection down — same pattern the
            // /api/switch/flipctl handler uses. Factory returns
            // null so no new scene is pushed onto the stack.
            'Reboot':       function() {
                fetch('/api/system/reboot', { method: 'POST' });
                return null;
            }
        });
        // Treat Settings as a first-class app in the App Switcher.
        subMenu.markAsApp(Icons.system, function(reSm) { return settingsMenu(reSm || sm); });
        return subMenu;
    }

    var subMenus = {
        'Network': networkMenu,
        // Files / Router have no backing scene yet — factories
        // return null so pressing ok/run is a no-op until wired
        // up.
        'Files':   function() { return null; },
        'Apps':    appsMenu,
        'Testing': testingMenu,
        'Settings': settingsMenu,
        'Router':  function() { return null; },
        'Boot Menu': function(reSm) { return new BootMenuScene(reSm); },
        // Target apps surfaced in the main-menu first slot.
        'TV Media Box':     function(reSm) { return new TVMediaBoxScene(reSm); },
        'Desktop Computer': function(reSm) {
            return (typeof DesktopComputerScene === 'function')
                ? new DesktopComputerScene(reSm) : null;
        }
    };

    function MenuScene(sceneManager, targetProfile) {
        this.sceneManager = sceneManager;
        this.displayName = 'Main Menu';
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.items = [];

        // First menu item is the active target's app, replacing the
        // old fixed "Router" slot: TV Media Box target → TV Media Box,
        // otherwise (Desktop / unknown) → Desktop Computer.
        _menuTargetProfile = targetProfile || '';
        this.menuNames = menuItems.slice();
        this.menuNames[0] = (_menuTargetProfile === 'TV Media Box')
            ? 'TV Media Box' : 'Desktop Computer';

        var iconMap = {
            'Settings':         Icons.system,
            'Boot Menu':        (typeof Icons !== 'undefined') ? Icons.flipper_os : null,
            'TV Media Box':     (typeof Icons !== 'undefined') ? Icons.media : null,
            'Desktop Computer': (typeof Icons !== 'undefined') ? Icons.desktop_computer : null
            // 'Network' / 'Files' / 'Apps' / 'Testing' have no static
            // icon — they fall back to frame 0 of their animated strip
            // while unselected.
        };
        var animatedIconMap = {
            'Settings': AnimatedIcons.settings_animated,
            'Files':    AnimatedIcons.files_animated,
            'Apps':     AnimatedIcons.apps_animated,
            'Network':  AnimatedIcons.network_animated,
            'Testing':  AnimatedIcons.testing_animated
        };

        for (var i = 0; i < this.menuNames.length; i++) {
            this.items.push(new MenuLine({
                text: this.menuNames[i],
                width: CONTAINER_W,
                icon: iconMap[this.menuNames[i]] || null,
                iconAnimated: animatedIconMap[this.menuNames[i]] || null,
                // New Born2bSportyV2FlipCTL conversion sits 2 px lower
                // than the old Medium — lift the selected label back up
                // (stock nudge +1 → -1).
                activeLabelYNudge: -1
            }));
        }

        this.items[this.selectedIndex].state = MenuLine.STATE_SELECTED;

        this.selectorFrame = new MenuSelectorFrame({
            x: SELECTOR_X,
            y: 0,                         // scene updates each frame
            width: SELECTOR_W_WITH_SCROLL, // scene updates each frame
            height: SELECTOR_H,
            anchorH: 'left',
            anchorV: 'top',
            strokeColor: '#000',
            showStroke: true,
            showFill: false
        });

        this.scrollbar = new UI.Scrollbar(this.menuNames.length, VISIBLE_COUNT, this.scrollOffset);
    }

    MenuScene.prototype.enter = function() {
        if (this._animTimer) return;
        this._animTimer = setInterval(function() {
            if (window.requestRender) window.requestRender();
        }, ANIMATED_ICON_FRAME_MS);
    };
    MenuScene.prototype.exit = function() {
        if (this._animTimer) {
            clearInterval(this._animTimer);
            this._animTimer = null;
        }
    };

    MenuScene.prototype._ensureVisible = function() {
        // Shift the viewport so the selected line is inside it.
        if (this.selectedIndex < this.scrollOffset) {
            this.scrollOffset = this.selectedIndex;
        } else if (this.selectedIndex >= this.scrollOffset + VISIBLE_COUNT) {
            this.scrollOffset = this.selectedIndex - VISIBLE_COUNT + 1;
        }
    };

    MenuScene.prototype.handleInput = function(action) {
        var n = this.items.length;
        if (action === 'down' || action === 'up') {
            // Infinity scroll: down past the last item jumps to the first,
            // up past the first jumps to the last.
            this.items[this.selectedIndex].state = MenuLine.STATE_DEFAULT;
            if (action === 'down') {
                this.selectedIndex = (this.selectedIndex + 1) % n;
            } else {
                this.selectedIndex = (this.selectedIndex - 1 + n) % n;
            }
            this.items[this.selectedIndex].state = MenuLine.STATE_SELECTED;
            this._ensureVisible();
        } else if (action === 'ok' || action === 'run') {
            // 30ms "press" flash on the selected line, then open the
            // submenu. The render loop paints the selector frame filled
            // black while the line is PRESSED, and the line inverts its
            // own text/icon to white.
            var self = this;
            var idx = this.selectedIndex;
            var line = this.items[idx];
            line.state = MenuLine.STATE_PRESSED;
            if (window.requestRender) window.requestRender();
            setTimeout(function() {
                line.state = MenuLine.STATE_SELECTED;
                var factory = subMenus[self.menuNames[idx]];
                if (factory) {
                    var next = factory(self.sceneManager);
                    if (next) self.sceneManager.push(next);
                }
                if (window.requestRender) window.requestRender();
            }, 30);
        } else if (action === 'back' || action === 'esc') {
            return 'pop';
        }
    };

    MenuScene.prototype.render = function(canvas) {
        canvas.clear('#fff');
        UI.drawStatusBar(canvas, '');

        // Selector width tracks scrollbar visibility; the gray divider
        // matches the selector's straight edge (width − 2×radius).
        var total = this.items.length;
        var hasScroll = total > VISIBLE_COUNT;
        var selectorW = hasScroll ? SELECTOR_W_WITH_SCROLL : SELECTOR_W_NO_SCROLL;
        var dividerX = SELECTOR_X + SELECTOR_CORNER_R;
        var dividerW = selectorW - 2 * SELECTOR_CORNER_R;

        // Render only the slice of items currently in the viewport.
        // Dividers still sit between every visible pair (the "no
        // divider on first / last" rule is satisfied because we draw
        // a divider only between rendered items).
        var first = this.scrollOffset;
        var last = Math.min(total, first + VISIBLE_COUNT);
        var y = CONTAINER_Y;
        var selectedLineY = CONTAINER_Y;
        for (var i = first; i < last; i++) {
            if (i === this.selectedIndex) selectedLineY = y;
            this.items[i].render(canvas, CONTAINER_X, y);
            y += MenuLine.H;
            if (i < last - 1) {
                canvas.drawHLine(dividerX, y, dividerW, DIVIDER_COLOR);
                y += 1;
            }
        }

        // Selector frame. Filled while PRESSED (covers the selected
        // line backdrop in black); outline otherwise.
        var pressed = this.items[this.selectedIndex].state === MenuLine.STATE_PRESSED;
        this.selectorFrame.setPosition(SELECTOR_X, selectedLineY + SELECTOR_Y_OFFSET);
        this.selectorFrame.setSize(selectorW, SELECTOR_H);
        this.selectorFrame.setShowFill(pressed);
        if (pressed) this.selectorFrame.setFillColor('#000');
        this.selectorFrame.render(canvas);

        // The filled frame just painted over the selected line content.
        // Redraw the selected line on top so its (inverted) text/icon
        // sit over the black backdrop.
        if (pressed) {
            this.items[this.selectedIndex].render(canvas, CONTAINER_X, selectedLineY);
        }

        // Scrollbar along the right edge. Dotted line spans the full
        // SCROLLBAR_H (2px off the status bar and bottom); the thumb is
        // inset 1px more so it sits at least 3px from each edge.
        this.scrollbar.update(total, VISIBLE_COUNT, this.scrollOffset);
        this.scrollbar.render(canvas, SCROLLBAR_X, SCROLLBAR_Y, SCROLLBAR_H, SCROLLBAR_THUMB_PAD);
    };

    return MenuScene;
})();
