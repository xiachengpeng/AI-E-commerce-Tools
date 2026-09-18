import subprocess
import sys
import os
import time
import webbrowser
import io
import socket

# 强制设置控制台输出为 UTF-8，防止 Windows 环境下的乱码
if sys.platform == "win32":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    else:
        # 兼容旧版 Python 3
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
    else:
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

FRONTEND_PORT = 9502
BACKEND_PORT = 9503


def is_port_available(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) != 0


def run_app():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.join(root_dir, "backend")
    frontend_dir = os.path.join(root_dir, "frontend")

    print("🚀 正在启动 AI 竞品分析工具...")

    dist_css = os.path.join(frontend_dir, "dist", "output.css")
    if not os.path.exists(dist_css):
        print("🎨 检测到缺少 Tailwind CSS 文件，正在自动编译...")
        try:
            subprocess.run(["npm", "run", "build:css"], cwd=frontend_dir, check=True)
            print("✅ Tailwind CSS 编译成功")
        except Exception as e:
            print(f"⚠️ 自动编译 CSS 失败 ({e})，请在 frontend/ 目录下手动执行 npm run build:css")

    if not is_port_available("127.0.0.1", BACKEND_PORT):
        print(f"❌ 后端端口 {BACKEND_PORT} 已被占用。请先关闭旧的后端服务后再运行 python run.py。")
        return
    if not is_port_available("127.0.0.1", FRONTEND_PORT):
        print(f"❌ 前端端口 {FRONTEND_PORT} 已被占用。请先关闭旧的前端服务后再运行 python run.py。")
        return

    # 1. 启动后端 (Uvicorn) - 端口 9503
    backend_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(BACKEND_PORT),
         "--app-dir", backend_dir],
        cwd=backend_dir,
        env={**os.environ, "PYTHONPATH": backend_dir}
    )
    print(f"✅ 竞品分析后端已启动: http://localhost:{BACKEND_PORT}")

    # 2. 启动前端 HTTP Server - 端口 9502
    frontend_script = f"""
import http.server
import socketserver

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()
    
    def send_response(self, *args, **kwargs):
        super().send_response(*args, **kwargs)

    def guess_type(self, path):
        base_type = super().guess_type(path)
        if base_type.startswith('text/') or base_type == 'application/javascript':
            return base_type + '; charset=utf-8'
        return base_type

print("Serving HTTP on 127.0.0.1 port {FRONTEND_PORT} (http://127.0.0.1:{FRONTEND_PORT}/) ...")
with socketserver.TCPServer(("127.0.0.1", {FRONTEND_PORT}), MyHandler) as httpd:
    httpd.serve_forever()
"""
    frontend_process = subprocess.Popen(
        [sys.executable, "-c", frontend_script],
        cwd=frontend_dir
    )
    print(f"✅ 前端服务已启动: http://localhost:{FRONTEND_PORT}")

    # 3. 等待启动后打开浏览器
    time.sleep(1.5)
    url = f"http://localhost:{FRONTEND_PORT}/index.html"
    print(f"🌐 正在打开浏览器: {url}")
    try:
        webbrowser.open(url)
    except:
        pass

    print("\n💡 提示:")
    print(f"   - 前端页面: http://localhost:{FRONTEND_PORT}/index.html")
    print(f"   - 后端服务: http://localhost:{BACKEND_PORT}")
    print("   - 按 Ctrl+C 同时停止所有服务\n")

    try:
        while True:
            time.sleep(1)
            if backend_process.poll() is not None:
                print("⚠️ 后端服务已停止")
                break
            if frontend_process.poll() is not None:
                print("⚠️ 前端服务已停止")
                break
    except KeyboardInterrupt:
        print("\n🛑 正在停止服务...")
    finally:
        backend_process.terminate()
        frontend_process.terminate()
        print("👋 已安全退出。")

if __name__ == "__main__":
    run_app()
