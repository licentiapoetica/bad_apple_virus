#!/usr/bin/env python3
"""Build the assets bad-apple.js loads, from the original project's data.

    python3 web/build.py

writes, next to bad-apple.js:
    bad-apple.frames.gz   assets/boxes.bin, gzipped (~640 KB)
    bad-apple.frames.js   the same as a script, so index.html also works from disk
    bad-apple.ogg         the soundtrack (Chrome, Firefox, Edge)
    bad-apple.mp3         the soundtrack again for Safari (needs ffmpeg; skipped otherwise)

Then upload the whole web/ folder (index.html is just a demo page).
"""
import base64
import gzip
import shutil
import subprocess
from pathlib import Path

WEB = Path(__file__).resolve().parent
ASSETS = WEB.parent / "assets"


def main() -> None:
    raw = (ASSETS / "boxes.bin").read_bytes()
    frames = WEB / "bad-apple.frames.gz"
    # mtime=0 keeps the output byte-identical between builds
    frames.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"{frames.name}: {len(raw):,} -> {frames.stat().st_size:,} bytes")

    # The same bytes as a script, for pages opened from disk (file://), where
    # browsers refuse fetch() but still run <script> tags.
    frames_js = WEB / "bad-apple.frames.js"
    b64 = base64.b64encode(frames.read_bytes()).decode()
    frames_js.write_text(f'window.BadAppleFrameData="{b64}";\n')
    print(f"{frames_js.name}: {frames_js.stat().st_size:,} bytes (only used from file://)")

    ogg = WEB / "bad-apple.ogg"
    shutil.copyfile(ASSETS / "bad apple.ogg", ogg)
    print(f"{ogg.name}: {ogg.stat().st_size:,} bytes")

    mp3 = WEB / "bad-apple.mp3"
    if shutil.which("ffmpeg"):
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(ogg), "-codec:a", "libmp3lame", "-q:a", "4", str(mp3)],
            check=True,
        )
        print(f"{mp3.name}: {mp3.stat().st_size:,} bytes")
    else:
        print("ffmpeg not found: skipped bad-apple.mp3 (Safari will play without sound)")


if __name__ == "__main__":
    main()
