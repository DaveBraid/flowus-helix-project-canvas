#!/usr/bin/env python3
"""在部署目录隐藏输入密码，保存哈希并自动重启已运行的 Compose 服务。"""
import argparse
import getpass
import hashlib
import secrets
import subprocess
from pathlib import Path


def main():
    '''生成认证文件；初始化时可输入 FlowUs token，修改密码后重启已运行服务。'''
    parser = argparse.ArgumentParser()
    parser.add_argument('--init', action='store_true', help='首次初始化，同时隐藏输入 FlowUs token；不重启')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    directory = root / 'secrets'
    password = getpass.getpass('Helix 个人密码（至少 9 位）：')
    if len(password) < 9 or len(password) > 1024:
        raise SystemExit('密码需要 9–1024 位，未写入。')
    if password != getpass.getpass('再次输入：'):
        raise SystemExit('两次密码不一致，未写入。')
    payload = {}
    if args.init:
        token = getpass.getpass('FlowUs API token（隐藏输入）：').strip()
        if not token or any(c.isspace() for c in token):
            raise SystemExit('Token 格式无效，未写入。')
        payload['flowus-token'] = token
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
    payload.update({'password-hash': f'scrypt:{salt}:{digest}', 'session-secret': secrets.token_urlsafe(48)})
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    for name, value in payload.items():
        path = directory / name
        # 创建前收紧进程权限，避免文件短暂出现宽松权限。
        import os
        old_mask = os.umask(0o077)
        try:
            path.write_text(value)
            path.chmod(0o600)
        finally:
            os.umask(old_mask)
    print('认证文件已保存；未保存明文密码。')
    if not args.init:
        try:
            subprocess.run(['docker', 'compose', 'restart', 'helix'], cwd=root, check=True)
        except (OSError, subprocess.CalledProcessError):
            raise SystemExit('密码已保存，自动重启失败。请在部署目录执行 docker compose restart helix。')
        print('Helix 已重启，旧登录会话失效。')


if __name__ == '__main__':
    main()
