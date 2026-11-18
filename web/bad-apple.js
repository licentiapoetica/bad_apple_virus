/*!
 * bad-apple.js — "Bad Apple!!" played back with fake desktop windows.
 * Browser port of the bad_apple_virus project. MIT License.
 *
 *   <script src="/bad-apple/bad-apple.js" defer></script>
 *
 *   <bad-apple theme="xp"></bad-apple>               embedded player
 *   <button data-bad-apple>Don't click</button>      full-page "virus" takeover
 *   BadApple.takeover({ theme: 'classic' })          same thing, from JS
 *   BadApple.konami()                                takeover on ↑↑↓↓←→←→BA
 *
 * Expects bad-apple.frames.gz (+ bad-apple.ogg / bad-apple.mp3) next to this
 * file unless you point `frames` / `audio` somewhere else.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.BadApple) return;

  // The video is 64x48 "pixels"; every frame is a list of white rectangles.
  const GRID_W = 64, GRID_H = 48, FPS = 30, MAX_WINDOWS = 255;
  const THEMES = ['win10', 'classic', 'xp', 'breeze'];
  const FITS = ['contain', 'stretch', 'cover'];

  const thisScript = document.currentScript ||
    [...document.querySelectorAll('script[src]')].find(s => /bad-apple[^/]*\.js([?#]|$)/.test(s.src));
  const BASE = new URL('.', thisScript ? thisScript.src : location.href).href;

  const defaults = {
    frames: BASE + 'bad-apple.frames.gz',
    audio: [BASE + 'bad-apple.ogg', BASE + 'bad-apple.mp3'],
    theme: 'win10',      // win10 | classic | xp | breeze
    fit: 'contain',      // contain | stretch | cover
    backdrop: '#000',    // any CSS colour; 'transparent' lets the page show through
    title: 'Bad Apple!!',
    windows: 155,        // the busiest frame needs 155; fewer drops the smallest boxes
    loop: false,
    autoplay: false,
    muted: false,
    volume: 1,
  };

  /* ------------------------------------------------------------------ data */

  // boxes.bin format: 4-byte records [x, y, w, h]; a record with w == 0 ends a
  // frame. Boxes are packed into one int (x | y<<8 | w<<16 | h<<24).
  function parseFrames(bytes) {
    const n = bytes.length >> 2;
    const keys = new Int32Array(n);
    const starts = [0];
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i << 2;
      if (bytes[o + 2] === 0) starts.push(k);
      else keys[k++] = bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24;
    }
    return { keys: keys.subarray(0, k), starts: Int32Array.from(starts), count: starts.length - 1 };
  }

  async function gunzipIfNeeded(bytes) {
    // Still gzipped unless the server already sent it with Content-Encoding.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot gunzip (no DecompressionStream)');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Pages opened straight from disk (file://) may not fetch(), but they may
  // run scripts: bad-apple.frames.js carries the same bytes as base64.
  let scriptQueue = Promise.resolve();
  function loadFramesScript(url) {
    const src = url.replace(/\.gz([?#].*)?$/, '') .replace(/([?#].*)?$/, '.js');
    const run = () => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => {
        el.remove();
        const b64 = window.BadAppleFrameData;
        delete window.BadAppleFrameData;
        if (typeof b64 !== 'string') return reject(new Error(src + ' did not define the frames'));
        const bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(bytes);
      };
      el.onerror = () => { el.remove(); reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
    // one at a time, since they all hand over through the same global
    const p = scriptQueue.then(run, run);
    scriptQueue = p.catch(() => {});
    return p;
  }

  const frameCache = new Map();
  function loadFrames(url) {
    if (!frameCache.has(url)) {
      const p = (async () => {
        const local = new URL(url, location.href).protocol === 'file:';
        let bytes;
        if (local) bytes = await loadFramesScript(url);
        else {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        return parseFrames(await gunzipIfNeeded(bytes));
      })();
      p.catch(() => frameCache.delete(url));
      frameCache.set(url, p);
    }
    return frameCache.get(url);
  }

  /* ------------------------------------------------------- window matching */

  // Decide which window shows which box. The original reused windows
  // largest-box-first every frame, so title bars jumped around; here each box
  // keeps the window it had, or takes the nearest free one (resizing is
  // weighted heavier than moving). cur/next: per-window box key, -1 = hidden.
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
      const pairs = new Int32Array(left.length * free.length);
      let p = 0;
      for (let b = 0; b < left.length; b++) {
        const k = left[b], x = k & 255, y = k >> 8 & 255, w = k >> 16 & 255, h = k >>> 24;
        for (let j = 0; j < free.length; j++) {
          const c = cur[free[j]];
          const cost = Math.abs(x - (c & 255)) + Math.abs(y - (c >> 8 & 255)) +
            2 * (Math.abs(w - (c >> 16 & 255)) + Math.abs(h - (c >>> 24)));
          pairs[p++] = cost << 16 | b << 8 | j;
        }
      }
      pairs.sort();
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
    for (let b = 0, h = 0; b < left.length && h < hidden.length; b++) {
      if (!boxDone[b]) next[hidden[h++]] = left[b];
    }
    return next;
  }

  /* ------------------------------------------------------------------- css */

  const APPLE = 'data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
    "<path fill='#d8262b' d='M8 4.6C6.7 3.5 3.3 3.4 2.9 6.6c-.4 2.8 1.4 6.7 3.1 7.1.7.2 1.3-.3 2-.3s1.3.5 2 .3c1.7-.4 3.5-4.3 3.1-7.1C12.7 3.4 9.3 3.5 8 4.6z'/>" +
    "<path fill='#45a033' d='M8.3 4.2c.3-1.7 1.5-2.7 3.2-2.8-.2 1.7-1.4 2.7-3.2 2.8z'/>" +
    "<path fill='none' stroke='#6b4423' stroke-width='.9' stroke-linecap='round' d='M8 4.7c0-1.2-.4-2.1-1.1-2.8'/>" +
    "<path fill='#fff' opacity='.45' d='M4.6 6.1c.3-1 1.1-1.4 1.8-1.3-.8.4-1.2 1-1.3 1.9z'/></svg>");

  const CSS = `
:host{display:block;position:relative;aspect-ratio:4/3;overflow:hidden;contain:content;background:#000;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
:host([hidden]){display:none}
[hidden]{display:none!important}
.stage{position:absolute;inset:0;overflow:hidden;cursor:pointer;outline:none;--font:system-ui,sans-serif}
.stage:focus-visible{box-shadow:inset 0 0 0 3px #4d90fe}
.field{position:absolute;inset:0;pointer-events:none}
.win{position:absolute;left:0;top:0;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:#fff;
  contain:layout paint style}
.field .win{contain:strict}
.tb{flex:none;box-sizing:border-box;height:var(--tb);display:flex;align-items:center;gap:calc(var(--tb)*.25);
  padding-left:calc(var(--tb)*.25);font:400 calc(var(--tb)*.45)/1 var(--font);white-space:nowrap;overflow:hidden}
.ic{flex:none;display:block;width:calc(var(--tb)*.55);height:calc(var(--tb)*.55);background:url("${APPLE}") center/contain no-repeat}
.tt{flex:1 1 0;min-width:0;overflow:hidden}
.bt{flex:none;align-self:stretch;display:flex;--g:calc(var(--tb)*.3)}
.bt i{position:relative;display:block;width:calc(var(--tb)*1.5)}
.bt i::before,.bt i::after{content:"";position:absolute;left:50%;top:50%;box-sizing:border-box}
.mn::before{width:var(--g);border-top:1px solid;transform:translate(-50%,-50%)}
.mx::before{width:var(--g);height:var(--g);border:1px solid;transform:translate(-50%,-50%)}
.cl::before,.cl::after{width:calc(var(--g)*1.35);border-top:1px solid;transform:translate(-50%,-50%) rotate(45deg)}
.cl::after{transform:translate(-50%,-50%) rotate(-45deg)}
.bd{flex:1 1 0;min-height:0;background:#fff}

/* modern Windows — the look of the original */
.t-win10{--font:"Segoe UI",system-ui,sans-serif}
.t-win10 .win{border:1px solid #6e6e6e;box-shadow:0 0 calc(var(--tb)*.5) rgba(0,0,0,.4)}
.t-win10 .tb{background:#fff;color:#111}
.t-win10 .dlg .cl:hover{background:#e81123;color:#fff}

/* Windows 9x */
.t-classic{--font:Tahoma,"MS Sans Serif",Geneva,sans-serif}
.t-classic .win{background:#c0c0c0;padding:2px;
  box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #dfdfdf,inset -2px -2px #808080,inset 2px 2px #fff}
.t-classic .tb{background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:700;
  padding-left:calc(var(--tb)*.15);gap:calc(var(--tb)*.15)}
.t-classic .bt{align-items:center;gap:1px;padding-right:2px;--g:calc(var(--tb)*.32)}
.t-classic .bt i{width:calc(var(--tb)*.8);height:calc(var(--tb)*.7);background:#c0c0c0;color:#000;
  box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px #808080,inset 2px 2px #dfdfdf}
.t-classic .mx{margin-right:2px}
.t-classic .mn::before{border-top-width:2px;transform:translate(-50%,calc(var(--g)*.5))}
.t-classic .mx::before{border-top-width:2px}
.t-classic .cl::before,.t-classic .cl::after{border-top-width:2px}
.t-classic .bd{margin-top:2px}

/* Windows XP */
.t-xp{--font:"Trebuchet MS",Tahoma,sans-serif;--xb:max(2px,calc(var(--tb)*.12))}
.t-xp .win{background:#0831d9;padding:0 var(--xb) var(--xb);border-radius:calc(var(--tb)*.3) calc(var(--tb)*.3) 0 0}
.t-xp .tb{margin:0 calc(-1*var(--xb));padding-left:calc(var(--tb)*.25);color:#fff;font-weight:700;text-shadow:1px 1px #0f1089;
  background:linear-gradient(#0997ff,#0053ee 8%,#0050ee 40%,#06f 88%,#06f 93%,#005bff 95%,#003dd7 96%,#003dd7)}
.t-xp .bt{align-items:center;gap:calc(var(--tb)*.08);padding-right:calc(var(--tb)*.15);--g:calc(var(--tb)*.3)}
.t-xp .bt i{box-sizing:border-box;width:calc(var(--tb)*.74);height:calc(var(--tb)*.74);border:1px solid #fff;
  border-radius:calc(var(--tb)*.12);background:linear-gradient(135deg,#6aa6ff,#245ee0);color:#fff}
.t-xp .bt .cl{background:linear-gradient(135deg,#f3997b,#d3411b)}
.t-xp .mn::before{border-top-width:2px;transform:translate(-50%,calc(var(--g)*.45))}
.t-xp .mx::before{border-top-width:2px}
.t-xp .cl::before,.t-xp .cl::after{border-top-width:2px}

/* KDE Plasma — Breeze */
.t-breeze{--font:"Noto Sans",Cantarell,"Segoe UI",system-ui,sans-serif}
.t-breeze .win{border-radius:calc(var(--tb)*.2) calc(var(--tb)*.2) 0 0;
  box-shadow:0 0 0 1px rgba(0,0,0,.2),0 calc(var(--tb)*.15) calc(var(--tb)*.7) rgba(0,0,0,.45)}
.t-breeze .tb{background:#dee0e2;color:#232629;border-bottom:1px solid #c6c8ca}
.t-breeze .tt{text-align:center}
.t-breeze .bt{align-items:center;gap:calc(var(--tb)*.15);padding-right:calc(var(--tb)*.25);--g:calc(var(--tb)*.24)}
.t-breeze .bt i{width:calc(var(--tb)*.62);height:calc(var(--tb)*.62);border-radius:50%}
.t-breeze .mn::before,.t-breeze .mx::before{width:var(--g);height:var(--g);border:0;border-left:1.5px solid;border-bottom:1.5px solid}
.t-breeze .mn::before{transform:translate(-50%,-75%) rotate(-45deg)}
.t-breeze .mx::before{transform:translate(-50%,-25%) rotate(135deg)}
.t-breeze .cl::before,.t-breeze .cl::after{border-top-width:1.5px}
.t-breeze .dlg .cl:hover{background:#da4453;color:#fff}

/* the "Play?" dialog */
.dlg{--tb:28px;left:50%;top:50%;transform:translate(-50%,-50%);width:min(21em,88%);cursor:default;
  font:13px/1.35 var(--font);color:#111;z-index:2;animation:pop .18s ease-out}
.dlg .bd{flex:none;display:flex;flex-direction:column;gap:14px;padding:14px 16px}
.dlg .bt{cursor:pointer}
.msg{display:flex;align-items:center;gap:12px}
.msg .ic{width:34px;height:34px}
.row{display:flex;justify-content:flex-end}
.btn{font:inherit;min-width:6.5em;padding:5px 14px;cursor:pointer;color:#000;background:#e1e1e1;border:1px solid #adadad}
.btn:hover{background:#e5f1fb;border-color:#0078d7}
.btn:disabled{opacity:.55;cursor:default}
.t-classic .btn{background:#c0c0c0;border:0;border-radius:0;
  box-shadow:inset -1px -1px #0a0a0a,inset 1px 1px #fff,inset -2px -2px #808080,inset 2px 2px #dfdfdf}
.t-classic .dlg .bd{background:#c0c0c0;margin-top:0}
.t-xp .btn{border:1px solid #003c74;border-radius:3px;background:linear-gradient(#fff,#ecebe6 86%,#d6d0c5)}
.t-xp .dlg .bd{background:#ece9d8}
.t-breeze .btn{border:1px solid #b8babc;border-radius:4px;background:#fcfcfc}
.t-breeze .btn:hover{border-color:#3daee9}
.t-breeze .dlg .bd{background:#eff0f1}
.btn:focus-visible{outline:2px solid #3daee9;outline-offset:2px}
.x{position:absolute;top:12px;right:12px;z-index:3;font:600 12px/1 system-ui,sans-serif;color:#fff;cursor:pointer;
  background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:7px 12px}
.x:hover{background:rgba(0,0,0,.85)}
.in{animation:fade .35s ease-out}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:translate(-50%,-50%) scale(.92)}}
@media (prefers-reduced-motion:reduce){.in,.dlg{animation:none}}
`;

  const WIN_HTML = '<div class="win" style="display:none"><div class="tb"><i class="ic"></i><span class="tt"></span>' +
    '<span class="bt"><i class="mn"></i><i class="mx"></i><i class="cl"></i></span></div><div class="bd"></div></div>';

  const MIME = { ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', wav: 'audio/wav', flac: 'audio/flac' };

  function clean(o) {
    const r = {};
    for (const k in o || {}) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
    return r;
  }

  /* ---------------------------------------------------------------- player */

  class Player {
    /**
     * @param {ShadowRoot|HTMLElement} root  where the player renders
     * @param {HTMLElement} host             element that receives play/pause/ended/error events
     */
    constructor(root, host, options) {
      this.root = root;
      this.host = host;
      this.o = { ...defaults, ...clean(options) };
      this.state = 'idle';               // idle | playing | paused | ended | destroyed
      this.data = null;
      this.ready = null;
      this.pos = 0;                      // seconds, when not running off a live clock
      this.t0 = 0;
      this.shown = -1;
      this.wins = [];
      this.cur = new Int32Array(Math.max(1, Math.min(MAX_WINDOWS, this.o.windows | 0))).fill(-1);
      this.xs = new Int32Array(GRID_W + 1);
      this.ys = new Int32Array(GRID_H + 1);
      this._dirty = true;
      this._raf = 0;
      this._tick = this._tick.bind(this);
      this.onClose = typeof this.o.onClose === 'function' ? this.o.onClose : null;
      this._build();
      this.closeBtn.hidden = !this.onClose;
      this._setupAudio();
      this.set({});
      this._prompt('Play ' + this.o.title + '?', 'Play');
      if (this.o.autoplay) this.play();
      else if ('IntersectionObserver' in window) {
        // fetch the frames once the player is about to scroll into view
        this._io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) this.load(); }, { rootMargin: '300px' });
        this._io.observe(this.stage);
      } else this.load();
    }

    _build() {
      this.root.innerHTML = `<style>${CSS}</style>` +
        '<div class="stage" part="stage" tabindex="0" role="group" aria-label="Bad Apple!! played with desktop windows. Click or press Space to play or pause.">' +
        '<div class="field" aria-hidden="true"></div>' +
        '<div class="win dlg" role="dialog" hidden><div class="tb"><i class="ic"></i><span class="tt"></span>' +
        '<span class="bt"><i class="cl" title="Close"></i></span></div>' +
        '<div class="bd"><div class="msg"><i class="ic"></i><span class="txt"></span></div>' +
        '<div class="row"><button class="btn" type="button"></button></div></div></div>' +
        '<button class="x" type="button" hidden>✕ Close <span aria-hidden="true">(Esc)</span></button></div>';
      const $ = s => this.root.querySelector(s);
      this.stage = $('.stage');
      this.field = $('.field');
      this.dlg = $('.dlg');
      this.dlgText = $('.dlg .txt');
      this.dlgBtn = $('.dlg .btn');
      this.closeBtn = $('.x');
      this.tpl = document.createElement('template');
      this.tpl.innerHTML = WIN_HTML;

      this.dlgBtn.addEventListener('click', e => { e.stopPropagation(); this.play(); });
      $('.dlg .cl').addEventListener('click', e => { e.stopPropagation(); this.onClose ? this.onClose() : (this.dlg.hidden = true); });
      this.dlg.addEventListener('click', e => e.stopPropagation());
      this.closeBtn.addEventListener('click', e => { e.stopPropagation(); this.onClose && this.onClose(); });
      this.stage.addEventListener('click', () => this.toggle());
      this.stage.addEventListener('keydown', e => {
        if (e.target === this.stage && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); this.toggle(); }
      });
      this._ro = new ResizeObserver(() => this._layout());
      this._ro.observe(this.stage);
    }

    _setupAudio() {
      const srcs = [].concat(this.o.audio || []).filter(Boolean);
      this.audio = null;
      this.audioBroken = false;
      if (!srcs.length) return;
      const a = this.audio = document.createElement('audio');
      a.preload = 'none';
      srcs.forEach((url, i) => {
        const s = document.createElement('source');
        s.src = url;
        const type = MIME[(String(url).split(/[?#]/)[0].split('.').pop() || '').toLowerCase()];
        if (type) s.type = type;
        if (i === srcs.length - 1) s.addEventListener('error', () => this._audioFailed());
        a.appendChild(s);
      });
      a.addEventListener('pause', () => { if (this.state === 'playing' && !a.ended) this.pause(); });
      a.addEventListener('play', () => { if (this.state === 'paused') this.play(); });
      this.stage.appendChild(a);
    }

    _audioFailed() {
      if (this.audioBroken) return;
      // keep the picture going on a wall clock from where the audio was
      const t = this._clock();
      this.audioBroken = true;
      this.pos = t;
      this.t0 = performance.now();
      console.warn('[bad-apple] audio unavailable, playing silently');
    }

    _useAudio() { return !!this.audio && !this.audioBroken; }

    /** Update options live: theme, fit, backdrop, title, loop, muted, volume. */
    set(options) {
      Object.assign(this.o, clean(options));
      const o = this.o;
      const theme = THEMES.includes(o.theme) ? o.theme : 'win10';
      this.stage.className = 'stage t-' + theme + (this.onClose ? ' in' : '');
      this.stage.style.background = o.backdrop;
      for (const el of this.root.querySelectorAll('.tt')) el.textContent = o.title;
      this.dlg.setAttribute('aria-label', o.title);
      if (this.audio) { this.audio.muted = !!o.muted; this.audio.volume = Math.max(0, Math.min(1, +o.volume || 0)); }
      this._layout();
      return this;
    }

    /** Start fetching the frame data (called automatically). */
    load() {
      if (!this.ready) {
        if (this._io) { this._io.disconnect(); this._io = null; }
        this.ready = loadFrames(this.o.frames).then(d => {
          this.data = d;
          if (this.state === 'idle') this._prompt('Play ' + this.o.title + '?', 'Play');
          if (this.state === 'playing') this.dlg.hidden = true;
          return d;
        }, err => {
          this.ready = null;
          if (this.state !== 'destroyed') {
            this.state = 'idle';
            if (this.audio) this.audio.pause();
            this._prompt('Could not load the frames (' + err.message + ').', 'Retry');
            this._emit('error', err);
          }
          throw err;
        });
        this.ready.catch(() => {});
      }
      return this.ready;
    }

    play() {
      if (this.state === 'playing' || this.state === 'destroyed') return;
      if (this.state === 'ended') this.pos = 0;
      this.load();
      this.state = 'playing';
      this.t0 = performance.now();
      this._at = -1;
      // Start the audio right now, inside the click, so browsers allow it. The
      // clock is the audio, so frames that are still downloading catch up in sync.
      if (this._useAudio()) {
        const a = this.audio;
        try { if (Math.abs(a.currentTime - this.pos) > 0.05) a.currentTime = this.pos; } catch (e) { /* not seekable yet */ }
        const p = a.play();
        if (p) p.catch(err => {
          if (err.name === 'NotAllowedError') {
            // Autoplay was blocked. Muted: nothing to hear, so run on the wall
            // clock. With sound: wait for a click.
            if (this.o.muted) this._audioFailed();
            else if (this.state === 'playing') { this.state = 'idle'; this._prompt('Play ' + this.o.title + '?', 'Play'); }
          } else if (err.name !== 'AbortError') this._audioFailed();
        });
      }
      if (this.data) this.dlg.hidden = true; else this._prompt('Loading…', null);
      this._emit('play');
      if (!this._raf) this._raf = requestAnimationFrame(this._tick);
    }

    pause() {
      if (this.state !== 'playing') return;
      this.pos = this._clock();
      this.state = 'paused';
      if (this.audio) this.audio.pause();
      this._prompt('Paused', 'Resume');
      this._emit('pause');
    }

    toggle() { this.state === 'playing' ? this.pause() : this.play(); }

    /** Jump to a time in seconds. */
    seek(seconds) {
      this.pos = Math.max(0, +seconds || 0);
      this.t0 = performance.now();
      this._at = -1;
      if (this.audio) { try { this.audio.currentTime = this.pos; } catch (e) { /* ignore */ } }
      if (this.state === 'ended') this.state = 'paused';
      if (this.data && this.state !== 'playing') this._draw(Math.min(this.data.count - 1, Math.floor(this.pos * FPS)));
    }

    get currentTime() { return this._clock(); }
    get duration() { return this.data ? this.data.count / FPS : NaN; }

    destroy() {
      this.state = 'destroyed';
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this.audio) { this.audio.pause(); this.audio.replaceChildren(); this.audio.load(); }
      this.root.replaceChildren();
    }

    _clock() {
      if (this.state !== 'playing') return this.pos;
      const now = performance.now();
      if (this._useAudio()) {
        // currentTime only advances in steps on some browsers; extrapolate a bit
        const a = this.audio, t = a.currentTime;
        if (t !== this._at) { this._at = t; this._ap = now; }
        return a.paused || a.readyState < 3 ? t : t + Math.min((now - this._ap) / 1000, 0.1);
      }
      return this.pos + (now - this.t0) / 1000;
    }

    _tick() {
      this._raf = 0;
      if (this.state !== 'playing') return;
      this._raf = requestAnimationFrame(this._tick);
      if (!this.data) return;
      const f = Math.floor(this._clock() * FPS);
      if (f >= this.data.count) return this._end();
      if (f !== this.shown || this._dirty) this._draw(f);
    }

    _end() {
      if (this.o.loop) {
        this.pos = 0;
        this.t0 = performance.now();
        this._at = -1;
        if (this._useAudio()) { this.audio.currentTime = 0; this.audio.play().catch(() => {}); }
        return;
      }
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.state = 'ended';
      this.pos = 0;
      if (this.audio) this.audio.pause();
      this._draw(-1);
      this._prompt('That was Bad Apple!!', 'Play again');
      this._emit('ended');
    }

    _layout() {
      const W = this.stage.clientWidth, H = this.stage.clientHeight;
      if (!W || !H) return;
      let fw = W, fh = H;
      if (this.o.fit !== 'stretch') {
        const s = (this.o.fit === 'cover' ? Math.max : Math.min)(W / GRID_W, H / GRID_H);
        fw = GRID_W * s; fh = GRID_H * s;
      }
      const fx = (W - fw) / 2, fy = (H - fh) / 2;
      for (let i = 0; i <= GRID_W; i++) this.xs[i] = Math.round(fx + i * fw / GRID_W);
      for (let i = 0; i <= GRID_H; i++) this.ys[i] = Math.round(fy + i * fh / GRID_H);
      const tb = Math.max(6, Math.min(32, Math.round(fh / GRID_H * 1.3)));
      this.field.style.setProperty('--tb', tb + 'px');
      this._dirty = true;
      if (this.state !== 'playing' && this.shown >= 0 && this.data) this._draw(this.shown);
    }

    _draw(f) {
      let next;
      if (f < 0) next = new Int32Array(this.cur.length).fill(-1);
      else {
        const d = this.data;
        next = assign(this.cur, d.keys.subarray(d.starts[f], d.starts[f + 1]));
      }
      for (let i = 0; i < next.length; i++) if (this._dirty || next[i] !== this.cur[i]) this._place(i, next[i]);
      this.cur = next;
      this.shown = f;
      this._dirty = false;
    }

    _place(i, k) {
      let w = this.wins[i];
      if (k < 0) {
        if (w && w.vis) { w.el.style.display = 'none'; w.vis = false; }
        return;
      }
      if (!w) {
        const el = this.tpl.content.firstChild.cloneNode(true);
        el.querySelector('.tt').textContent = this.o.title;
        this.field.appendChild(el);
        w = this.wins[i] = { el, x: NaN, y: NaN, w: -1, h: -1, vis: false };
      }
      const gx = k & 255, gy = k >> 8 & 255, gw = k >> 16 & 255, gh = k >>> 24;
      const L = this.xs[gx], T = this.ys[gy], Wd = this.xs[gx + gw] - L, Ht = this.ys[gy + gh] - T;
      const st = w.el.style;
      if (L !== w.x || T !== w.y) { st.transform = `translate(${L}px,${T}px)`; w.x = L; w.y = T; }
      if (Wd !== w.w) { st.width = Wd + 'px'; w.w = Wd; }
      if (Ht !== w.h) { st.height = Ht + 'px'; w.h = Ht; }
      if (!w.vis) { st.display = ''; w.vis = true; }
    }

    _prompt(text, button) {
      if (this.state === 'destroyed') return;
      this.dlgText.textContent = text;
      this.dlgBtn.hidden = !button;
      if (button) this.dlgBtn.textContent = button;
      this.dlg.hidden = false;
    }

    _emit(type, detail) {
      this.host.dispatchEvent(new CustomEvent(type, { detail: detail === undefined ? this : detail }));
    }
  }

  /* -------------------------------------------------------- <bad-apple> tag */

  function attrOptions(el) {
    const get = n => el.hasAttribute(n) ? el.getAttribute(n) : undefined;
    const audio = get('audio');
    const windows = parseInt(get('windows'), 10);
    const volume = parseFloat(get('volume'));
    return clean({
      theme: get('theme'),
      fit: FITS.includes(get('fit')) ? get('fit') : undefined,
      backdrop: get('backdrop'),
      title: get('window-title'),
      frames: get('frames'),
      audio: audio === undefined ? undefined : audio.trim() === 'none' ? [] : audio.split(',').map(s => s.trim()),
      windows: windows > 0 ? windows : undefined,
      volume: volume >= 0 ? volume : undefined,
      loop: el.hasAttribute('loop'),
      autoplay: el.hasAttribute('autoplay'),
      muted: el.hasAttribute('muted'),
    });
  }

  class BadAppleElement extends HTMLElement {
    static get observedAttributes() { return ['theme', 'fit', 'backdrop', 'window-title', 'loop', 'muted', 'volume']; }
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: 'open' });
    }
    connectedCallback() {
      if (!this.player) this.player = new Player(this._shadow, this, attrOptions(this));
    }
    disconnectedCallback() {
      // moving the element around the DOM shouldn't kill the player
      setTimeout(() => {
        if (!this.isConnected && this.player) { this.player.destroy(); this.player = null; }
      });
    }
    attributeChangedCallback() { if (this.player) this.player.set(attrOptions(this)); }
    play() { if (this.player) this.player.play(); }
    pause() { if (this.player) this.player.pause(); }
    seek(t) { if (this.player) this.player.seek(t); }
  }
  if (window.customElements && !customElements.get('bad-apple')) customElements.define('bad-apple', BadAppleElement);

  /* --------------------------------------------------------------- takeover */

  let active = null;

  /**
   * Cover the whole page with windows, like the original "virus". Call it from a
   * click or key press so the browser lets the audio play. Esc closes it.
   * Extra options: fullscreen (bool), onclose (fn).
   */
  function takeover(options = {}) {
    if (active) return active;
    const o = { fit: 'stretch', ...clean(options) };
    const host = document.createElement('div');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', o.title || defaults.title);
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:block;width:auto;height:auto;margin:0;aspect-ratio:auto';
    document.body.appendChild(host);
    const root = document.documentElement, overflow = root.style.overflow;
    root.style.overflow = 'hidden';

    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const close = () => {
      if (player.state === 'destroyed') return;
      document.removeEventListener('keydown', onKey, true);
      player.destroy();
      host.remove();
      root.style.overflow = overflow;
      if (document.fullscreenElement === host) document.exitFullscreen().catch(() => {});
      if (active === player) active = null;
      if (typeof o.onclose === 'function') o.onclose();
    };
    const player = new Player(host.attachShadow({ mode: 'open' }), host, { ...o, autoplay: false, onClose: close });
    player.close = close;
    host.addEventListener('ended', () => { if (!o.loop) close(); });
    document.addEventListener('keydown', onKey, true);
    if (o.fullscreen && host.requestFullscreen) host.requestFullscreen().catch(() => {});
    active = player;
    player.play();
    player.stage.focus({ preventScroll: true });
    return player;
  }

  /** Arm the Konami code (↑↑↓↓←→←→BA) to trigger takeover(options). Returns a disarm function. */
  function konami(options) {
    const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let i = 0;
    const onKey = e => {
      const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
      i = k === seq[i] ? i + 1 : k === seq[0] ? 1 : 0;
      if (i === seq.length) { i = 0; takeover(options); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }

  // Options from data-* attributes: data-bad-apple="xp" data-fit="contain" data-fullscreen ...
  function dataOptions(el, themeAttr) {
    const d = el.dataset;
    const theme = d[themeAttr] || d.theme;
    return clean({
      theme: THEMES.includes(theme) ? theme : undefined,
      fit: FITS.includes(d.fit) ? d.fit : undefined,
      backdrop: d.backdrop,
      fullscreen: 'fullscreen' in d,
      muted: 'muted' in d,
    });
  }

  // <button data-bad-apple>…</button> anywhere on the page
  document.addEventListener('click', e => {
    const el = e.target instanceof Element && e.target.closest('[data-bad-apple]');
    if (!el) return;
    e.preventDefault();
    takeover(dataOptions(el, 'badApple'));
  });

  // <script src="bad-apple.js" data-konami="classic">
  if (thisScript && thisScript.hasAttribute('data-konami')) konami(dataOptions(thisScript, 'konami'));

  window.BadApple = {
    Player, takeover, konami, defaults, version: '1.0.0',
    /** the running takeover player, if any */
    get active() { return active; },
  };
})();
