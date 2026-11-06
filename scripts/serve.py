"""Serve the repository with caching disabled and open one asset page."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import socket
import threading
from urllib.parse import urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


class NoCacheHandler(SimpleHTTPRequestHandler):
    # The repository root has no index.html, so a bare host URL opened on
    # another device would show a directory listing instead of the page.
    def __init__(self, *args, start_page, **kwargs):
        self.start_page = start_page
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if not self.redirect_root():
            super().do_GET()

    def do_HEAD(self):
        if not self.redirect_root():
            super().do_HEAD()

    def redirect_root(self):
        if urlsplit(self.path).path != "/":
            return False
        self.send_response(302)
        self.send_header("Location", "/" + self.start_page)
        self.end_headers()
        return True

    # Without this header browsers reuse an old patterns.js after an edit,
    # which leaves new sidebar entries visible but inert.
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("page", nargs="?", default="assets/extended/index.html")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    if not (ROOT / args.page.split("#", 1)[0]).is_file():
        parser.error(f"{args.page} does not exist under {ROOT}")

    handler = partial(NoCacheHandler, directory=str(ROOT), start_page=args.page)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    wildcard = args.host in ("0.0.0.0", "::", "")
    url = f"http://{'127.0.0.1' if wildcard else args.host}:{args.port}/{args.page}"
    print(f"Serving {ROOT} at {url} (Ctrl+C to stop)", flush=True)
    if wildcard:
        print(f"Other devices: http://{socket.gethostname()}:{args.port}/{args.page}", flush=True)
    if not args.no_open:
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
