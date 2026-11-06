"""Check that the preview server sends the bare root to the requested page."""

from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import serve  # noqa: E402


class ServeTests(unittest.TestCase):
    def start(self, page):
        handler = partial(serve.NoCacheHandler, directory=str(ROOT), start_page=page)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def request(self, port, method, path):
        connection = HTTPConnection("127.0.0.1", port, timeout=5)
        self.addCleanup(connection.close)
        connection.request(method, path)
        response = connection.getresponse()
        response.read()
        return response

    def test_root_redirects_to_start_page(self):
        for page in ("assets/kit/index.html", "assets/extended/index.html#effects"):
            port = self.start(page)
            for method in ("GET", "HEAD"):
                for path in ("/", "/?from=phone"):
                    with self.subTest(page=page, method=method, path=path):
                        response = self.request(port, method, path)
                        self.assertEqual(response.status, 302)
                        self.assertEqual(response.getheader("Location"), "/" + page)

    def test_other_paths_are_served_as_files(self):
        port = self.start("assets/kit/index.html")
        response = self.request(port, "GET", "/assets/style-explorer.html")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertEqual(self.request(port, "GET", "/assets/").status, 200)


if __name__ == "__main__":
    unittest.main()
