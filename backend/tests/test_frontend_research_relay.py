"""The local UI relay forwards once and retains the research security boundary."""
import http.client
import http.server
import importlib.util
from pathlib import Path
import threading

import pytest


@pytest.fixture
def relay(tmp_path):
    spec = importlib.util.spec_from_file_location("frontend_server", Path(__file__).resolve().parents[2] / "frontend_server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    seen = []

    class Backend(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            seen.append((self.path, dict(self.headers), body))
            self.send_response(401 if not self.headers.get("X-Research-Token") else 200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"saved":true}')

        do_GET = do_POST

        def log_message(self, *_):
            pass

    backend = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), module.make_handler(str(tmp_path), backend_port=backend.server_port))
    for item in (backend, server):
        threading.Thread(target=item.serve_forever, daemon=True).start()
    yield server.server_port, seen
    for item in (server, backend):
        item.shutdown()
        item.server_close()


def request(port, path, *, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port)
    conn.request("POST" if body is not None else "GET", path, body=body, headers=headers or {})
    result = conn.getresponse()
    value = (result.status, result.read())
    conn.close()
    return value


def test_relay_forwards_exact_body_token_and_origin_once(relay):
    port, seen = relay
    payload = b'{"command_id":"stable","title":"fixture"}'
    status, _ = request(port, "/api/research/workbench/v1/projects", headers={"X-Research-Token": "fixture", "Origin": "http://127.0.0.1:9502", "Content-Type": "application/json"}, body=payload)
    assert status == 200
    assert len(seen) == 1
    assert seen[0][2] == payload
    assert seen[0][1]["X-Research-Token"] == "fixture"
    assert seen[0][1]["Origin"] == "http://127.0.0.1:9502"


def test_relay_preserves_auth_failure_and_blocks_foreign_origin_host_and_paths(relay):
    port, seen = relay
    assert request(port, "/api/research/workbench/v1/projects")[0] == 401
    for path, headers in [
        ("/api/research/workbench/v1/projects", {"Origin": "https://outside.example"}),
        ("/api/research/workbench/v1/projects", {"Host": "outside.example"}),
        ("/api/research/../settings/ai/providers", {}),
        ("/api/research/%2e%2e/settings", {}),
        ("/api/settings/ai/providers", {}),
        ("http://outside.example/api/research/v1/session", {}),
    ]:
        assert request(port, path, headers=headers)[0] in (400, 403, 404)
    assert len(seen) == 1
