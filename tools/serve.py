#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py - 零依赖本地静态服务器（Python 兜底方案）

没装 Node 的机器用这个：
    python tools/serve.py            # 默认 8899，自动开浏览器
    python tools/serve.py 9000
    python tools/serve.py 9000 --no-open

作用与 serve.mjs 完全一致：用 http:// 打开页面，绕开 file:// 的 CORS 限制。
"""
import os
import sys
import socket
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app")
ROOT = os.path.normpath(ROOT)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *a):  # 安静一点
        pass


def free_port(start: int) -> int:
    for p in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return start


def main() -> int:
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        print("[Music Hub] 找不到 app/index.html，请确认目录结构完整。")
        return 1

    args = sys.argv[1:]
    want = next((int(a) for a in args if a.isdigit()), 8899)
    no_open = "--no-open" in args
    port = free_port(want)

    httpd = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=ROOT))
    url = "http://127.0.0.1:%d/index.html" % port
    print("\n  Music Hub 已启动\n  %s\n\n  按 Ctrl+C 停止服务\n" % url)

    if not no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
