#!/usr/bin/env python3
"""限定 Helix 目录和镜像仓库的发布、健康检查与三版本保留。"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

REPOSITORY = 'flowus-helix'
LABEL = 'io.helix.application=flowus-helix-project-canvas'


def run(*args, cwd=None, capture=False, env=None):
    '''执行明确参数的命令；失败立即停止，输出可选捕获。'''
    return subprocess.run(args, cwd=cwd, env=env, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def image_retention(images, active):
    '''按创建时间保留当前与最近两版；只处理本项目明确的发布标签。'''
    owned = [i for i in images if i['repo'] == REPOSITORY and
             (i['tag'] == 'local' or re.fullmatch(r'(?:release-|before-)[A-Za-z0-9_.-]+', i['tag']))]
    keep = [active]
    for i in sorted(owned, key=lambda i: i['created'], reverse=True):
        if i['id'] not in keep and len(keep) < 3:
            keep.append(i['id'])
    return [f"{i['repo']}:{i['tag']}" for i in owned if i['id'] not in keep]


def trim_assets(dist):
    '''删除 index 及其递归引用之外的哈希资源；只检查本次发布的 assets 目录。'''
    assets = dist / 'assets'
    if not assets.is_dir(): return
    files = [p for p in assets.iterdir() if p.is_file() and not p.is_symlink()]
    content = (dist / 'index.html').read_text()
    keep = set()
    while True:
        found = [p for p in files if p.name not in keep and p.name in content]
        if not found: break
        for p in found:
            keep.add(p.name)
            if p.suffix in ['.js', '.css']: content += p.read_text()
    if not any(name.endswith('.js') for name in keep):
        raise RuntimeError('无法确认主脚本，停止清理资源')
    for p in files:
        if p.name not in keep: p.unlink()


def main():
    '''从独立上传目录替换发布文件；健康后清理，仅保留三版资源和镜像。'''
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--candidate', required=True)
    args = parser.parse_args()
    root, candidate = Path(args.root).resolve(), Path(args.candidate).resolve()
    if candidate.parent != root / '.incoming' or not re.fullmatch(r'[0-9TZ-]+', candidate.name):
        raise SystemExit('拒绝非 Helix 独立上传目录')
    for name in ['server', 'dist', 'Dockerfile']:
        if not (candidate / name).exists():
            raise SystemExit(f'候选发布缺少 {name}')
    releases = root / '.releases'
    releases.mkdir(exist_ok=True)
    revision = candidate.name
    old = run('docker', 'image', 'inspect', f'{REPOSITORY}:local', '--format', '{{.Id}}', capture=True).strip()
    run('docker', 'tag', old, f'{REPOSITORY}:before-{revision}')
    backup = releases / f'{revision}-previous'
    backup.mkdir()
    # 旧目录完整移动，避免新哈希资源与历史文件继续混存。
    for name in ['dist', 'server', 'Dockerfile']:
        shutil.move(str(root / name), str(backup / name))
        if (candidate / name).is_dir(): shutil.copytree(candidate / name, root / name)
        else: shutil.copy2(candidate / name, root / name)
    try:
        # 经典构建不写入共享 BuildKit 缓存；项目标签用于定向清理悬空镜像。
        # 独立构建上下文只含公开运行文件，不遍历 secrets/OAuth 私有目录。
        if 'bin/flowus' in (candidate / 'Dockerfile').read_text():
            (candidate / 'bin').mkdir(exist_ok=True)
            shutil.copy2(root / 'bin/flowus', candidate / 'bin/flowus')
        env = dict(os.environ, DOCKER_BUILDKIT='0')
        run('docker', 'build', '--no-cache', '--rm', '--label', LABEL,
            '-t', f'{REPOSITORY}:local', '-t', f'{REPOSITORY}:release-{revision}', '.', cwd=candidate, env=env)
        run('docker', 'compose', 'up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '90', 'helix', cwd=root)
    except subprocess.CalledProcessError:
        run('docker', 'tag', old, f'{REPOSITORY}:local')
        for name in ['dist', 'server', 'Dockerfile']:
            if (root / name).is_dir(): shutil.rmtree(root / name)
            else: (root / name).unlink()
            shutil.move(str(backup / name), str(root / name))
        backup.rmdir()
        run('docker', 'compose', 'up', '-d', '--no-build', '--no-deps', 'helix', cwd=root)
        raise
    trim_assets(backup / 'dist')
    trim_assets(root / 'dist')
    # 当前目录即当前版，备份目录最多保留最近两版。
    snapshots = sorted([p for p in releases.iterdir() if p.is_dir() and not p.is_symlink()
                        and re.fullmatch(r'[0-9TZ-]+-previous', p.name)], reverse=True)
    for path in snapshots[2:]: shutil.rmtree(path)
    images = []
    lines = run('docker', 'image', 'ls', REPOSITORY, '--format', '{{.Repository}} {{.Tag}} {{.ID}}', capture=True).splitlines()
    for line in lines:
        repo, tag, image = line.split()
        data = json.loads(run('docker', 'image', 'inspect', image, capture=True))[0]
        images.append({'repo': repo, 'tag': tag, 'id': data['Id'], 'created': data['Created']})
    active = run('docker', 'image', 'inspect', f'{REPOSITORY}:local', '--format', '{{.Id}}', capture=True).strip()
    for tag in image_retention(images, active): run('docker', 'image', 'rm', tag)
    run('docker', 'image', 'prune', '-f', '--filter', f'label={LABEL}')
    shutil.rmtree(candidate)
    print('Helix 发布成功：当前资源加两版备份；镜像保留当前及最近两版。')


if __name__ == '__main__':
    main()
