"""Loopback static UI with a fixed-destination research relay (no retries)."""
import http.client
import http.server
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit


def make_handler(directory, *, backend_port=9503):
    class Handler(http.server.SimpleHTTPRequestHandler):
        timeout = 15

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            super().end_headers()

        def guess_type(self, path):
            value = super().guess_type(path)
            return value + "; charset=utf-8" if value.startswith("text/") or value == "application/javascript" else value

        def reject(self, status):
            body = json.dumps({"detail": "研究请求未完成，请核对状态；写入不会自动重试。"}, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def relay(self):
            parsed = urlsplit(self.path)
            decoded = unquote(parsed.path)
            origins = {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (9502, 9503)}
            hosts = {f"{host}:{self.server.server_port}" for host in ("127.0.0.1", "localhost")}
            if self.headers.get("Host") not in hosts or (self.headers.get("Origin") and self.headers["Origin"] not in origins):
                self.reject(403)
                return
            allowed = decoded.startswith(("/api/research/v1/", "/api/research/workbench/v1/", "/api/settings/integrations/"))
            if parsed.scheme or parsed.netloc or parsed.fragment or decoded != parsed.path or "\\" in decoded or ".." in decoded.split("/") or not allowed:
                self.reject(404)
                return
            if self.headers.get("Transfer-Encoding"):
                self.reject(400)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.reject(400)
                return
            if size < 0 or size > 16 * 1024 * 1024:
                self.reject(413)
                return
            body = self.rfile.read(size) if size else None
            headers = {key: self.headers[key] for key in ("Content-Type", "X-Research-Token", "Origin", "Sec-Fetch-Site", "Last-Event-ID") if key in self.headers}
            connection = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=75)
            started = False
            try:
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()
                # Never follow a redirect, change destination, or replay a mutation.
                if 300 <= response.status < 400:
                    self.reject(502)
                    return
                self.send_response(response.status)
                for key in ("Content-Type", "Content-Disposition", "Content-Length"):
                    if response.getheader(key) is not None:
                        self.send_header(key, response.getheader(key))
                self.end_headers()
                started = True
                while chunk := response.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (OSError, http.client.HTTPException):
                if not started:
                    self.reject(502)
            finally:
                connection.close()
                self.close_connection = True

        def do_GET(self):
            if self.path.startswith("/api/") or urlsplit(self.path).scheme:
                self.relay()
            else:
                super().do_GET()

        do_POST = relay
        do_PATCH = relay
        do_DELETE = relay

    return Handler


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", 9502), make_handler(str(Path(__file__).parent / "frontend"))) as server:
        server.serve_forever()
