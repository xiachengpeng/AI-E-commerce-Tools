"""Archived SSH argument compatibility; executable entry is permanently inert."""
import re


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
    """Archived compatibility entry point; local consolidation never starts SSH."""
    return None


if __name__ == '__main__':
    main()
