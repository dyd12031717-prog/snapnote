#!/usr/bin/env python3
"""Screenshot the mockup HTML files to PNG at 2x for print quality.

Serves the folder over a local HTTP server so @font-face file loading
is not blocked by file:// CORS restrictions.
"""
import http.server
import socketserver
import threading
import pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
PORT = 8731

JOBS = [
    ("mockup_expanded.html", "mockup_expanded.png", 860, 560),
    ("mockup_docked.html", "mockup_docked.png", 860, 560),
    ("mockup_toast.html", "mockup_toast.png", 860, 560),
    ("diagram_arch.html", "diagram_arch.png", 1000, 486),
]


def serve():
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(HERE), **kw)
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        httpd.serve_forever()


def main():
    t = threading.Thread(target=serve, daemon=True)
    t.start()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--font-render-hinting=none"])
        for src, out, w, h in JOBS:
            page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            page.goto(f"http://127.0.0.1:{PORT}/{src}")
            page.wait_for_timeout(400)
            page.evaluate("document.fonts.ready")
            page.wait_for_timeout(250)
            loaded = page.evaluate("document.fonts.status")
            page.screenshot(path=str(HERE / out))
            page.close()
            print(f"OK {out} (fonts: {loaded})")
        browser.close()


if __name__ == "__main__":
    main()
