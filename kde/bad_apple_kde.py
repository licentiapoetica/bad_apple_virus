#!/usr/bin/env python3
"""Bad Apple!! played with real KDE Plasma windows (Plasma 6, Wayland or X11).

    python3 kde/bad_apple_kde.py              # the whole thing
    python3 kde/bad_apple_kde.py --help

How it works: this program opens up to 155 plain white windows and plays the
music. Wayland doesn't let an app place its own windows, so it also loads a
KWin script (bad-apple.qml) over D-Bus; that runs inside the compositor and
moves/resizes our windows into every frame of the video. When we exit, the
script is unloaded again.

Needs PyQt6 or PySide6, and pw-play, paplay, mpv or ffplay for sound.
Stop it any time with Ctrl+C.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    from PyQt6 import QtCore, QtDBus, QtGui, QtWidgets
except ImportError:
    try:
        from PySide6 import QtCore, QtDBus, QtGui, QtWidgets
    except ImportError:
        sys.exit("bad_apple_kde needs PyQt6 or PySide6 (Arch: pacman -S python-pyqt6)")

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FPS = 30
SCRIPT_NAME = "bad-apple"
BACKDROP_TITLE = "Bad Apple!! backdrop"
Qt = QtCore.Qt


def frame_count(data: bytes) -> int:
    return sum(1 for i in range(2, len(data), 4) if data[i] == 0)


class AppleWindow(QtWidgets.QWidget):
    """One plain white window; KWin decides where it goes."""

    def __init__(self, title: str, icon: QtGui.QIcon, on_close) -> None:
        super().__init__(None, Qt.WindowType.Window | Qt.WindowType.WindowDoesNotAcceptFocus)
        self._on_close = on_close
        self.setWindowTitle(title)
        self.setWindowIcon(icon)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAutoFillBackground(True)
        pal = self.palette()
        pal.setColor(QtGui.QPalette.ColorRole.Window, QtGui.QColor("white"))
        self.setPalette(pal)
        self.setMinimumSize(1, 1)
        self.resize(160, 90)

    def closeEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        super().closeEvent(event)
        self._on_close()


class KWinScript:
    """Load/unload a declarative KWin script through org.kde.KWin /Scripting."""

    def __init__(self) -> None:
        self.iface = QtDBus.QDBusInterface(
            "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", QtDBus.QDBusConnection.sessionBus()
        )
        self.loaded = False

    def available(self) -> bool:
        return self.iface.isValid()

    def _call(self, method: str, *args):
        reply = self.iface.call(method, *args)
        if reply.type() == QtDBus.QDBusMessage.MessageType.ErrorMessage:
            raise RuntimeError(f"KWin {method}: {reply.errorMessage()}")
        return reply.arguments()

    def load(self, qml: Path) -> None:
        self.unload()  # a leftover from a run that crashed
        (script_id,) = self._call("loadDeclarativeScript", str(qml), SCRIPT_NAME)
        if script_id < 0:
            raise RuntimeError("KWin refused to load the script")
        self._call("start")
        self.loaded = True

    def unload(self) -> None:
        try:
            self._call("unloadScript", SCRIPT_NAME)
        except RuntimeError:
            pass
        self.loaded = False


def find_player(path: Path, start: float) -> list[str] | None:
    """Pick a command-line audio player. Only mpv/ffplay can start mid-song."""
    candidates = [
        ["pw-play", str(path)],
        ["paplay", str(path)],
        ["mpv", "--no-video", "--really-quiet", f"--start={start}", str(path)],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-ss", str(start), str(path)],
    ]
    if start > 0:
        candidates = candidates[2:]
    for cmd in candidates:
        if shutil.which(cmd[0]):
            return cmd
    return None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Bad Apple!! played with KDE Plasma windows.")
    p.add_argument("--screen", default="all",
                   help="'all' spans the whole desktop, every monitor (default); 'active' is the focused monitor; "
                        "or an output name like DP-1 (see --list-screens)")
    p.add_argument("--fit", choices=["stretch", "contain"], default="stretch",
                   help="stretch fills the whole area like the Windows original (default); contain keeps the 4:3 picture")
    p.add_argument("--windows", type=int, default=155, help="number of windows, 1-255 (155 shows every frame in full)")
    p.add_argument("--backdrop", action="store_true", help="put a black window behind the picture instead of letting the desktop show through")
    p.add_argument("--borderless", action="store_true", help="no title bars: pixel-exact white rectangles")
    p.add_argument("--mute", action="store_true", help="no sound")
    p.add_argument("--start", type=float, default=0.0, metavar="SEC", help="start this many seconds into the song")
    p.add_argument("--duration", type=float, default=None, metavar="SEC", help="stop after this many seconds")
    p.add_argument("--av-offset", type=int, default=0, metavar="MS",
                   help="delay the picture by this many ms if it runs ahead of your audio output")
    p.add_argument("--title", default="Bad Apple!!", help="window title")
    p.add_argument("--stats", action="store_true",
                   help="log how many window moves lagged behind (journalctl --user -g bad-apple)")
    p.add_argument("--list-screens", action="store_true", help="print output names and exit")
    p.add_argument("--frames", type=Path, default=REPO / "assets" / "boxes.bin", help=argparse.SUPPRESS)
    p.add_argument("--audio", type=Path, default=REPO / "assets" / "bad apple.ogg", help=argparse.SUPPRESS)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.windows <= 255:
        sys.exit("--windows must be between 1 and 255")

    app = QtWidgets.QApplication(sys.argv[:1])
    app.setApplicationName("Bad Apple!!")
    app.setQuitOnLastWindowClosed(False)

    if args.list_screens:
        for s in app.screens():
            g = s.geometry()
            print(f"{s.name()}: {g.width()}x{g.height()} at {g.x()},{g.y()}")
        return 0

    names = [s.name() for s in app.screens()]
    if args.screen not in ("all", "active") and args.screen not in names:
        sys.exit(f"unknown screen {args.screen!r}; have: {', '.join(names)}")

    kwin = KWinScript()
    if not kwin.available():
        sys.exit("KWin's D-Bus scripting interface isn't reachable. This needs a KDE Plasma 6 session.")

    frames = args.frames.read_bytes()
    total = frame_count(frames)
    start_frame = max(0, min(total - 1, round(args.start * FPS)))
    end_frame = total if args.duration is None else min(total, start_frame + round(args.duration * FPS))

    # Everything the KWin script needs, in a fresh directory (KWin caches QML by path).
    workdir = Path(tempfile.mkdtemp(prefix="bad-apple-kde-"))
    shutil.copyfile(HERE / "bad-apple.qml", workdir / "main.qml")
    lead_ms = 2000 + args.windows * 6  # time to open the windows before the music starts
    start_at = int(time.time() * 1000) + lead_ms
    config = {
        "pid": os.getpid(),
        "startAt": start_at + args.av_offset,
        "startFrame": start_frame,
        "endFrame": end_frame,
        "screen": args.screen,
        "fit": args.fit,
        "borderless": args.borderless,
        "backdropTitle": BACKDROP_TITLE,
        "measure": args.stats,
    }
    with open(workdir / "config.js", "w") as f:
        f.write(".pragma library\n")
        for k, v in config.items():
            f.write(f"var {k} = {json.dumps(v)};\n")
        f.write(f'var frames = "{base64.b64encode(frames).decode()}";\n')

    audio: subprocess.Popen | None = None
    cleaned = False

    def cleanup() -> None:
        nonlocal cleaned
        if cleaned:
            return
        cleaned = True
        if audio and audio.poll() is None:
            audio.terminate()
        kwin.unload()
        shutil.rmtree(workdir, ignore_errors=True)

    app.aboutToQuit.connect(cleanup)

    try:
        kwin.load(workdir / "main.qml")
    except RuntimeError as e:
        cleanup()
        sys.exit(str(e))

    # Ctrl+C: Python only sees signals when it gets control, so poke it regularly.
    signal.signal(signal.SIGINT, lambda *_: app.quit())
    signal.signal(signal.SIGTERM, lambda *_: app.quit())
    poke = QtCore.QTimer()
    poke.timeout.connect(lambda: None)
    poke.start(200)

    icon = QtGui.QIcon(str(REPO / "apple.ico"))
    windows: list[AppleWindow] = []

    def window_closed() -> None:
        if not any(w.isVisible() for w in windows):
            app.quit()  # the user closed every last one

    if args.backdrop:  # opened first so it stacks below the others
        backdrop = AppleWindow(BACKDROP_TITLE, icon, lambda: None)
        pal = backdrop.palette()
        pal.setColor(QtGui.QPalette.ColorRole.Window, QtGui.QColor("black"))
        backdrop.setPalette(pal)
        backdrop.show()

    for _ in range(args.windows):
        w = AppleWindow(args.title, icon, window_closed)
        w.show()
        windows.append(w)

    def start_audio() -> None:
        nonlocal audio
        if args.mute:
            return
        cmd = find_player(args.audio, args.start)
        if not cmd:
            print("no audio player found (pw-play, paplay, mpv, ffplay); playing silently", file=sys.stderr)
            return
        audio = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def single_shot(at_ms: int, fn) -> QtCore.QTimer:
        t = QtCore.QTimer(app)
        t.setSingleShot(True)
        t.setTimerType(Qt.TimerType.PreciseTimer)
        t.timeout.connect(fn)
        t.start(max(0, at_ms - int(time.time() * 1000)))
        return t

    single_shot(start_at, start_audio)
    length_ms = (end_frame - start_frame) * 1000 // FPS
    single_shot(start_at + args.av_offset + length_ms + 500, app.quit)

    print(f"Bad Apple!! with {args.windows} windows, {length_ms / 1000:.1f}s. Ctrl+C to stop.")
    try:
        return app.exec()
    finally:
        cleanup()


if __name__ == "__main__":
    sys.exit(main())
