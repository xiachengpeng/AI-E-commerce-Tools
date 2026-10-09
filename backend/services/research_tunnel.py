"""Optional private SSH transport; owns only its own subprocess, never a worker."""
import re
import signal
import socket
import subprocess
import threading

from services.research_client import load_research_config


def ssh_command(config):
    if config.get('enabled') is not True:
        return None
    target = config.get('ssh_target')
    if config.get('base_url') != 'http://127.0.0.1:19503' or not isinstance(target, str) or not re.fullmatch(
            r'[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9_][A-Za-z0-9_.-]*', target):
        raise ValueError('研究隧道配置无效')
    return ['ssh', '-N', '-L', '127.0.0.1:19503:127.0.0.1:8000',
            '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', target]


def main():
    try:
        command = ssh_command(load_research_config())
    except ValueError:
        print('研究隧道配置无效；主工具继续运行。', flush=True)
        return
    if command is None:
        return
    with socket.socket() as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(('127.0.0.1', 19503)) == 0:
            print('研究隧道端口已有监听；不启动第二个隧道。', flush=True)
            return
    stopping = threading.Event()
    def stop(_signal, _frame):
        stopping.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping.is_set():
        process = None
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL)
            while process.poll() is None and not stopping.wait(0.5):
                pass
        except OSError:
            print('研究安全连接不可用；主工具继续运行。', flush=True)
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if not stopping.is_set():
            print('研究安全连接中断，5秒后重新连接。', flush=True)
            stopping.wait(5)


if __name__ == '__main__':
    main()
