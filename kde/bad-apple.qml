// Bad Apple!! for KDE Plasma 6 — the KWin half.
//
// Wayland doesn't let applications position their own windows, so
// bad_apple_kde.py only creates plain white windows and plays the music; this
// declarative KWin script (loaded over D-Bus, running inside the compositor)
// adopts those windows by PID and moves/resizes them into each frame.
//
// bad_apple_kde.py copies this file into a fresh temp dir next to a generated
// config.js (KWin caches QML by path, so every run needs a new one).

import QtQuick
import org.kde.kwin
import "config.js" as Config

Item {
    id: root

    readonly property int gridW: 64
    readonly property int gridH: 48
    readonly property int fps: 30

    // Plain JS state. `property var` holds references, so mutating in place is fine.
    property var st: ({
        pool: [],          // { win, key (packed box or -1 = parked) }
        keys: null,        // Int32Array: every box, packed x | y<<8 | w<<16 | h<<24
        starts: null,      // Int32Array: frame -> index of its first box in keys
        count: 0,
        shown: -1,
        xs: [], ys: [],    // grid line -> screen pixel
        park: null,        // where hidden windows wait (off every screen)
        focus: null,       // the window that had focus before we started
        done: false
    })

    function log(msg) { console.info("bad-apple: " + msg); }

    function base64(str) {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const map = new Int16Array(128);
        for (let i = 0; i < 64; i++) map[abc.charCodeAt(i)] = i;
        const pad = str.endsWith("==") ? 2 : str.endsWith("=") ? 1 : 0;
        const out = new Uint8Array(str.length / 4 * 3 - pad);
        let o = 0;
        for (let i = 0; i < str.length; i += 4) {
            const n = map[str.charCodeAt(i)] << 18 | map[str.charCodeAt(i + 1)] << 12 |
                      map[str.charCodeAt(i + 2)] << 6 | map[str.charCodeAt(i + 3)];
            out[o++] = n >> 16;
            if (o < out.length) out[o++] = n >> 8 & 255;
            if (o < out.length) out[o++] = n & 255;
        }
        return out;
    }

    // boxes.bin: 4-byte records [x, y, w, h]; w == 0 ends a frame.
    function parse(bytes) {
        const n = bytes.length >> 2;
        const keys = new Int32Array(n);
        const starts = [0];
        let k = 0;
        for (let i = 0; i < n; i++) {
            const o = i << 2;
            if (bytes[o + 2] === 0) starts.push(k);
            else keys[k++] = bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24;
        }
        st.keys = keys;
        st.starts = new Int32Array(starts);
        st.count = starts.length - 1;
    }

    // Same matching as web/bad-apple.js: a box keeps its window if it didn't
    // change, otherwise takes the nearest visible window (resizes cost double:
    // on Wayland they need a round-trip to the app), otherwise a parked one.
    function assign(cur, boxes) {
        const N = cur.length, next = new Int32Array(N).fill(-1);
        const m = Math.min(boxes.length, N);
        const byKey = new Map();
        for (let i = 0; i < N; i++) {
            const k = cur[i];
            if (k < 0) continue;
            const list = byKey.get(k);
            if (list) list.push(i); else byKey.set(k, [i]);
        }
        const left = [];
        for (let b = 0; b < m; b++) {
            const k = boxes[b], list = byKey.get(k);
            if (list && list.length) next[list.pop()] = k; else left.push(k);
        }
        if (!left.length) return next;

        const free = [], hidden = [];
        for (let i = 0; i < N; i++) if (next[i] < 0) (cur[i] >= 0 ? free : hidden).push(i);

        const boxDone = new Uint8Array(left.length);
        if (free.length) {
            // KWin's JS engine has no TypedArray.sort, and costs are small
            // integers anyway: counting sort, stable, so ties keep b-then-j order.
            const P = left.length * free.length, cost = new Int16Array(P);
            const MAXC = 3 * (gridW + gridH), counts = new Int32Array(MAXC + 2);
            let p = 0;
            for (let b = 0; b < left.length; b++) {
                const k = left[b], x = k & 255, y = k >> 8 & 255, w = k >> 16 & 255, h = k >>> 24;
                for (let j = 0; j < free.length; j++) {
                    const c = cur[free[j]];
                    const d = Math.abs(x - (c & 255)) + Math.abs(y - (c >> 8 & 255)) +
                              2 * (Math.abs(w - (c >> 16 & 255)) + Math.abs(h - (c >>> 24)));
                    cost[p] = d;
                    counts[d + 1]++;
                    p++;
                }
            }
            for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1];
            const pairs = new Int32Array(P);
            for (let b = 0, q = 0; b < left.length; b++)
                for (let j = 0; j < free.length; j++, q++) pairs[counts[cost[q]]++] = b << 8 | j;
            const winDone = new Uint8Array(free.length);
            let todo = Math.min(left.length, free.length);
            for (let q = 0; q < p && todo; q++) {
                const b = pairs[q] >> 8 & 255, j = pairs[q] & 255;
                if (boxDone[b] || winDone[j]) continue;
                boxDone[b] = winDone[j] = 1;
                next[free[j]] = left[b];
                todo--;
            }
        }
        for (let b = 0, h = 0; b < left.length && h < hidden.length; b++)
            if (!boxDone[b]) next[hidden[h++]] = left[b];
        return next;
    }

    // The full area, panels included: every screen's bounding box by default,
    // or one screen ("active" = the focused one, or an output name like DP-1).
    function pickArea() {
        if (Config.screen === "all") {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const s of Workspace.screens) {
                const g = s.geometry;
                x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
                x1 = Math.max(x1, g.x + g.width); y1 = Math.max(y1, g.y + g.height);
            }
            return Qt.rect(x0, y0, x1 - x0, y1 - y0);
        }
        let output = Workspace.activeScreen;
        for (const s of Workspace.screens) if (s.name === Config.screen) output = s;
        const g = output.geometry;
        return Qt.rect(g.x, g.y, g.width, g.height);
    }

    function layout() {
        const a = pickArea();
        let fw = a.width, fh = a.height;
        if (Config.fit !== "stretch") {
            const s = Math.min(a.width / gridW, a.height / gridH);
            fw = gridW * s; fh = gridH * s;
        }
        const fx = a.x + (a.width - fw) / 2, fy = a.y + (a.height - fh) / 2;
        const xs = [], ys = [];
        for (let i = 0; i <= gridW; i++) xs.push(Math.round(fx + i * fw / gridW));
        for (let i = 0; i <= gridH; i++) ys.push(Math.round(fy + i * fh / gridH));
        st.xs = xs; st.ys = ys;
        st.area = a;  // the backdrop covers all of it, letterbox included

        // park hidden windows to the left of every screen
        let left = 0, top = 0;
        for (const s of Workspace.screens) { left = Math.min(left, s.geometry.x); top = Math.min(top, s.geometry.y); }
        st.park = Qt.rect(left - 4000, top, 160, 90);
        log("playing on " + a.width + "x" + a.height + "+" + a.x + "+" + a.y + " (" + (Config.fit) + ")");
    }

    function adopt(w) {
        if (!w || w.pid !== Config.pid || !w.normalWindow) return;
        for (const e of st.pool) if (e.win === w) return;
        if (w.caption === Config.backdropTitle) {
            // optional black window behind the picture, so a busy desktop doesn't show through
            w.noBorder = true;
            w.keepAbove = true;
            w.skipTaskbar = w.skipPager = w.skipSwitcher = true;
            w.frameGeometry = st.area;
            st.backdrop = w;
            return;
        }
        w.keepAbove = true;
        w.skipTaskbar = true;
        w.skipPager = true;
        w.skipSwitcher = true;
        if (Config.borderless) w.noBorder = true;
        const e = { win: w, key: 0 };
        park(e);
        st.pool.push(e);
    }

    function release(w) {
        st.pool = st.pool.filter(e => e.win !== w);
    }

    function park(e) {
        if (e.key < 0) return;
        e.win.opacity = 0;
        e.win.frameGeometry = st.park;
        e.key = -1;
    }

    function place(e, k) {
        const x = k & 255, y = k >> 8 & 255, w = k >> 16 & 255, h = k >>> 24;
        const xs = st.xs, ys = st.ys;
        e.win.frameGeometry = Qt.rect(xs[x], ys[y], xs[x + w] - xs[x], ys[y + h] - ys[y]);
        if (e.key < 0) e.win.opacity = 1;
        e.key = k;
    }

    function draw(f) {
        const pool = st.pool;
        const cur = new Int32Array(pool.length);
        for (let i = 0; i < pool.length; i++) cur[i] = pool[i].key;
        const next = f < 0 ? new Int32Array(pool.length).fill(-1)
                           : assign(cur, st.keys.subarray(st.starts[f], st.starts[f + 1]));
        for (let i = 0; i < pool.length; i++) {
            if (next[i] === cur[i]) continue;
            if (next[i] < 0) park(pool[i]); else place(pool[i], next[i]);
        }
        st.shown = f;
    }

    // Before drawing a new frame, count how many windows really reached the
    // geometry asked for in the previous one (Wayland applies a resize only
    // after the app acknowledges it). Summarised in the journal at the end.
    function measure() {
        for (const e of st.pool) {
            if (e.key < 0) continue;
            const k = e.key, g = e.win.frameGeometry;
            const x = k & 255, y = k >> 8 & 255, w = k >> 16 & 255, h = k >>> 24;
            const ww = st.xs[x + w] - st.xs[x], wh = st.ys[y + h] - st.ys[y];
            st.checked = (st.checked || 0) + 1;
            // too-small boxes are clamped to the decoration's minimum: not a lag
            const sizeOk = (ww < 80 || Math.abs(g.width - ww) <= 1) && (wh < 40 || Math.abs(g.height - wh) <= 1);
            if (Math.abs(g.x - st.xs[x]) > 1 || Math.abs(g.y - st.ys[y]) > 1 || !sizeOk) st.stale = (st.stale || 0) + 1;
        }
    }

    function finish() {
        if (st.done) return;
        st.done = true;
        timer.stop();
        draw(-1);
        if (st.backdrop) {
            const g = st.backdrop.frameGeometry;
            log("backdrop: " + g.width + "x" + g.height + "+" + g.x + "+" + g.y);
        }
        log("finished" + (Config.measure ? "; " + (st.stale || 0) + " of " + (st.checked || 0) +
                          " window placements were still pending a frame later" : ""));
    }

    function tick() {
        if (st.done) return;
        const now = Date.now();
        if (now < Config.startAt) return;
        const f = Config.startFrame + Math.floor((now - Config.startAt) * fps / 1000);
        if (f >= Config.endFrame || f >= st.count) { finish(); return; }
        if (f !== st.shown) {
            if (Config.measure && st.shown >= 0) measure();
            draw(f);
        }
    }

    Component.onCompleted: {
        const t = Date.now();
        parse(base64(Config.frames));
        layout();
        st.focus = Workspace.activeWindow;
        for (const w of Workspace.windows) adopt(w);
        log("ready: " + st.count + " frames decoded in " + (Date.now() - t) + " ms, waiting for windows of pid " + Config.pid);
    }

    Connections {
        target: Workspace
        function onWindowAdded(w) { root.adopt(w); }
        function onWindowRemoved(w) { root.release(w); }
        // new windows grab focus; give it back to whatever had it
        function onWindowActivated(w) {
            if (w && w.pid === Config.pid && root.st.focus && root.st.focus.pid !== Config.pid) {
                try { Workspace.activeWindow = root.st.focus; } catch (e) { root.st.focus = null; }
            }
        }
    }

    Timer {
        id: timer
        interval: 5
        repeat: true
        running: true
        onTriggered: root.tick()
    }
}
