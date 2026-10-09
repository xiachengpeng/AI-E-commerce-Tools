"""Exercise the actual launcher script without starting any backend or AI service."""
import ast
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen


def test_idle_browser_connection_cannot_block_frontend_requests(tmp_path):
    source = Path(__file__).resolve().parents[2] / 'run.py'
    parsed = ast.parse(source.read_text())
    value = next(node.value for node in ast.walk(parsed)
                 if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == 'frontend_script' for target in node.targets))
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    script = eval(compile(ast.Expression(value), str(source), 'eval'), {'FRONTEND_PORT': port})
    (tmp_path / 'index.html').write_text('fixture frontend')
    process = subprocess.Popen([sys.executable, '-c', script], cwd=tmp_path,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    idle = None
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                idle = socket.create_connection(('127.0.0.1', port), timeout=.2)
                break
            except OSError:
                assert process.poll() is None, 'frontend process failed to start'
                time.sleep(.02)
        assert idle is not None, 'frontend listener did not start'
        # Browser preconnect: TCP connected, but no HTTP bytes are sent.
        time.sleep(.1)
        with urlopen(f'http://127.0.0.1:{port}/index.html', timeout=1) as response:
            assert response.read() == b'fixture frontend'
            assert response.headers['Cache-Control'] == 'no-store, no-cache, must-revalidate'
    finally:
        if idle:
            idle.close()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
