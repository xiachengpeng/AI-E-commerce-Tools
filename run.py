import subprocess
import sys
import os
import time
import webbrowser
import io

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

def run_app():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.join(root_dir, "backend")
    frontend_dir = os.path.join(root_dir, "frontend")

    print("🚀 正在启动 AI 竞品分析工具...")

    # 1. 启动后端 (Uvicorn) - 竞品分析服务 端口 8000
    backend_process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000",
         "--app-dir", backend_dir],
        cwd=backend_dir,
        env={**os.environ, "PYTHONPATH": backend_dir}
    )
    print("✅ 竞品分析后端已启动: http://localhost:8000")

    # 2. 启动前端 HTTP Server - 端口 8080
    # 使用 python -c 启动一个带 UTF-8 头的简单服务器
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

print("Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...")
with socketserver.TCPServer(("", 8080), MyHandler) as httpd:
    httpd.serve_forever()
"""
    frontend_process = subprocess.Popen(
        [sys.executable, "-c", frontend_script],
        cwd=frontend_dir
    )
    print("✅ 前端服务已启动: http://localhost:8080")

    # 3. 等待启动后打开浏览器
    time.sleep(1.5)
    url = "http://localhost:8080/index.html"
    print(f"🌐 正在打开浏览器: {url}")
    try:
        webbrowser.open(url)
    except:
        pass

    print("\n💡 提示:")
    print("   - 前端页面: http://localhost:8080/index.html")
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
