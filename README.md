# Bad Apple but it's a Windows virus

A high-performance (I've never seen _anything_ like this run in realtime before)
rendition of Bad Apple, using Windows windows as the video surface.

It's not _actually_ a virus, but it is reminiscent of the viruses of old that
were more of a nuisance than anything.

Video demonstration:

[![Flandre Scarlet made out of windows](https://img.youtube.com/vi/EZpZwunMzuE/0.jpg)](https://www.youtube.com/watch?v=EZpZwunMzuE)

## On your website (`web/`)

**Live demo: https://licentiapoetica.github.io/bad_apple_virus/** (published
from `web/` by `.github/workflows/pages.yml` on every push to `master`).

A dependency-free script that plays the same frames with fake desktop windows
in the browser: as an embedded player, or as a full-page "virus" takeover.

1. `python3 web/build.py` regenerates the assets next to `bad-apple.js`:
   `bad-apple.frames.gz`, `bad-apple.frames.js`, `bad-apple.ogg` and, with
   ffmpeg, `bad-apple.mp3`. They are committed already, so this is only needed
   if you change `assets/`.
2. Upload `bad-apple.js` and those files to one folder on your site.
3. Use it:

```html
<script src="/bad-apple/bad-apple.js" defer></script>

<!-- embedded player: 4:3, as wide as its container -->
<bad-apple theme="xp"></bad-apple>

<!-- a button that covers the whole page with windows (Esc closes it) -->
<button data-bad-apple="classic">Don't click</button>

<!-- or: the Konami code (↑↑↓↓←→←→BA) unleashes it -->
<script src="/bad-apple/bad-apple.js" data-konami="breeze" defer></script>
```

`web/index.html` is a demo page; it works opened straight from disk too.
Browsers won't `fetch()` on `file://`, so the player falls back to loading
`bad-apple.frames.js` (the same data as a script) there. On a real web server it
uses the smaller `.gz`.

| `<bad-apple>` attribute | |
| --- | --- |
| `theme` | `win10` (default), `classic`, `xp`, `breeze` |
| `fit` | `contain` (default), `stretch`, `cover` |
| `backdrop` | CSS colour behind the windows (default `#000`; `transparent` shows the page) |
| `autoplay`, `muted`, `loop`, `volume` | as for `<video>`; browsers only autoplay sound after a click, so use `autoplay muted` |
| `windows` | how many windows (default 155, the most any frame needs) |
| `frames`, `audio` | other asset URLs (`audio` is a comma-separated list, or `none`) |
| `window-title` | the text in every title bar |

From JavaScript: `BadApple.takeover({ theme, fit, backdrop, fullscreen, onclose })`,
`BadApple.konami(options)`, and `element.play()` / `.pause()` / `.seek(seconds)`.
Elements fire `play`, `pause`, `ended` and `error` events. Everything renders
inside a shadow root, so your site's CSS can't break it (or the other way round).

## On KDE Plasma (`kde/`)

Real windows, on Plasma 6 (Wayland or X11):

```sh
python3 kde/bad_apple_kde.py --backdrop   # Ctrl+C stops it
python3 kde/bad_apple_kde.py --help       # --screen, --fit contain, --borderless, --mute, ...
```

By default it fills the whole desktop: every monitor, panels included, stretched
to fit like the Windows original. `--screen active` (or an output name from
`--list-screens`) limits it to one monitor, and `--fit contain` keeps the 4:3
picture. `--backdrop` puts black behind the windows instead of your desktop.

Needs PyQt6 or PySide6 (`pacman -S python-pyqt6`) and `pw-play`, `paplay`, `mpv`
or `ffplay` for the sound.

Wayland doesn't let applications position their own windows, so the work is
split in two. The Python program opens plain white windows and plays the music.
It also loads `kde/bad-apple.qml` into KWin over D-Bus. That KWin script runs
inside the compositor and moves and resizes those windows (found by PID) into
every frame, keeps them above everything else, and out of the taskbar and
Alt+Tab. The script is unloaded again when the program exits. Your Plasma theme
draws the title bars, so it looks like your desktop.

Small boxes can't shrink below the width of a title bar's buttons, so fine
details come out a little chunky. `--borderless` gives exact rectangles instead.

## Window matching (both ports)

The Windows version reuses windows largest-box-first every frame, so a window
often jumps across the screen from one frame to the next (see "Could it be
faster?" below). Both ports instead keep a box on the window it already had,
and otherwise give it the nearest free window. Resizing counts double, because
on Wayland it needs a round-trip to the app. Over the whole video, windows
travel 87% less distance.

## About the music

The code is MIT-licensed; the song is not. "Bad Apple!!" is a Touhou Project
arrangement by Alstroemeria Records, and the shadow-art video is by Anira. Check
you're comfortable with that before putting the audio on a public site. The
player works fine without it (`audio="none"`).

## Why is it so performant?

- `DeferWindowPos` - even the most naive of projects can go from 1fps to 15fps
  by using this wonderful batched API instead of `SetWindowPos`.
- `WS_EX_TOOLWINDOW` to remove the taskbar entry
- `SWP_NOREDRAW` when moving/resizing windows
- Optimised code that only shows/hides/moves windows that need
  showing/hiding/moving
- Rust is *blazing fast*, don't you know?

## Could it be faster?

I suspect that choosing which windows to move/resize, such that each is resized
as little as possible, can increase performance - currently, the windows are just
used from largest to smallest, which can result in some location jitter as they
fit into different indexes.

## Future work

All of these I have done already in small tests, but they're both difficult to
make performant (copy dialogs are particularly slow), and difficult to arrange
into a pleasing display.

- Spawning `MessageBoxA` windows and taking their handle (thus avoiding the need
to replicate the layout of `MessageBoxA` for each version of Windows you run
on)
- Spawning Vista file copy dialogs using `IProgressDialog`
- Arranging windows in rolling sine waves, circles, etc

All of these I have not tried yet, but would be great additions:
- Water physics using hundreds of scroll bars
- Basic hard-body physics between windows
- Error noises synced with the audio (could just pre-render...)
- Notification bubbles
- Windows in the taskbar to show text (if the user has large taskbar buttons
  enabled)
- A large variety of error messages to delight the user with

## Building and such

Should be fine to just `cargo build --release`.

Look at `bad apple.py` for the pre-processing to take an input video and turn it
into `boxes.bin`, a space-optimized representation of the window bounds for each
frame. The script is jank, don't come complaining.

Check the PRs for some forks that improve the python script to be easier to run.

## Why's the repo archived?

I simply don't have the bandwidth to respond to questions and merge PRs for this little
project I threw out into the world. Feel free to fork it and make it do cool things!
