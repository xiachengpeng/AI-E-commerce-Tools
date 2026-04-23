import subprocess
import sys
import os
import time
import webbrowser

# Windows 终端强制 UTF-8 输出，避免 emoji 编码报错
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

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
    frontend_process = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8080"],
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
