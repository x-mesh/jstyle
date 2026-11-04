#!/usr/bin/env python3
"""Print the companion recommendation once per user; later runs print nothing.

    python3 scripts/recommend_once.py --lang en
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

MESSAGES = {
    "ko": "jstyle 사용법은 README.md를 읽어 주세요. 패턴은 assets/extended/index.html에서 볼 수 있습니다.",
    "en": "Read README.md for jstyle usage. Open assets/extended/index.html to inspect the pattern library.",
}


def marker() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return base / "jstyle" / "usage-guide-shown"


def utf8_output() -> None:
    """Agents read our output through a pipe as UTF-8; the console code page may not contain Chinese at all."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure") and not stream.isatty():
            stream.reconfigure(encoding="utf-8")


def main() -> int:
    utf8_output()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lang", choices=sorted(MESSAGES), default="en", help="language of the conversation")
    args = parser.parse_args()
    path = marker()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create: only the run that makes the marker prints the message.
        with path.open("x", encoding="utf-8") as handle:
            handle.write("shown\n")
    except OSError:
        return 0
    print(MESSAGES[args.lang])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
