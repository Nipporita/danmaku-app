# -*- coding: utf-8 -*-
"""开发服务器（Vite 风格）：
1. 所有响应禁用缓存 —— 普通刷新即可拿到最新文件，无需 Ctrl+F5；
2. 监听 .html/.js/.css 文件变更，页面自动整页刷新（无需手动刷新）。

用法: python dev_server.py [端口]   （默认 1919，与 server.bat 一致）
"""
import glob
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 1919
WATCH_EXT = (".html", ".js", ".css")

# 注入到 HTML </body> 前的自动刷新脚本：轮询版本号，变化即整页刷新
INJECT = """<script>
(function () {
    var v = null;
    setInterval(function () {
        fetch('/__livereload?t=' + Date.now())
            .then(function (r) { return r.text(); })
            .then(function (t) {
                if (v === null) { v = t; }
                else if (t !== v) { location.reload(); }
            })
            .catch(function () {});
    }, 1000);
})();
</script>
"""


def snapshot():
    """当前前端源码的版本号 = 所有 html/js/css 的最新修改时间"""
    latest = 0.0
    for ext in WATCH_EXT:
        for p in glob.glob(os.path.join(ROOT, "**", "*" + ext), recursive=True):
            try:
                latest = max(latest, os.path.getmtime(p))
            except OSError:
                pass
    return latest


class DevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/__livereload"):
            body = str(snapshot()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if path.endswith(".html") and os.path.isfile(path):
            with open(path, "rb") as f:
                data = f.read()
            inject = INJECT.encode("utf-8")
            if b"</body>" in data:
                data = data.replace(b"</body>", inject + b"</body>", 1)
            else:
                data += inject
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        super().do_GET()

    def log_message(self, fmt, *args):
        # 静默 /__livereload 轮询日志，其余照常
        if "/__livereload" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)


class ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with ThreadingServer(("", PORT), DevHandler) as httpd:
        print(f"开发服务器: http://localhost:{PORT}/  (禁缓存 + 文件变更自动刷新, Ctrl+C 退出)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
