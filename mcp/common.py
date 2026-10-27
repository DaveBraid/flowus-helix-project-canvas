import logging
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from key_value.aio.stores.filetree.store import FileTreeStore, FileTreeV1CollectionSanitizationStrategy, FileTreeV1KeySanitizationStrategy
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper

UPSTREAM_RESOURCE = "https://mcp.flowus.cn/message"


def secret(name):
    '''读取容器密钥；优先使用只读文件；输入变量名；输出非空密钥，不打印内容。'''
    value = Path(os.environ[name + "_FILE"]).read_text().strip() if os.environ.get(name + "_FILE") else os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"缺少 {name}")
    return value


def public_base():
    '''校验公网 OAuth 标识；输入环境变量；输出不带末尾斜杠的 HTTPS 基址。'''
    base = os.environ["HELIX_MCP_PUBLIC_BASE_URL"].rstrip("/")
    parts = urlsplit(base)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path:
        raise RuntimeError("HELIX_MCP_PUBLIC_BASE_URL 必须是无路径的 HTTPS 基址")
    return base


def state_dir():
    '''建立专用状态目录；输入环境路径；输出受限目录，不读取其他服务状态。'''
    os.umask(0o077)
    path = Path(os.environ.get("HELIX_MCP_STATE_DIR", "/state"))
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("httpx", "httpx2", "mcp", "uvicorn.access"):
        logging.getLogger(name).setLevel(logging.CRITICAL) # 授权回调参数与内部认证头不进入日志。
    return path


def stored_key(name, factory):
    '''持久化框架密钥；输入固定文件名和生成器；输出原有或新建密钥，重启后继续有效。'''
    path = state_dir() / name
    try:
        with path.open("xb") as stream:
            stream.write(factory())
    except FileExistsError:
        pass
    return path.read_bytes()


def storage(name):
    '''创建加密命名空间；输入固定名称；输出框架存储，不读取其他服务凭据。'''
    directory = state_dir() / name
    directory.mkdir(mode=0o700, exist_ok=True)
    return FernetEncryptionWrapper(key_value=FileTreeStore(
        data_directory=directory,
        key_sanitization_strategy=FileTreeV1KeySanitizationStrategy(directory),
        collection_sanitization_strategy=FileTreeV1CollectionSanitizationStrategy(directory),
    ), fernet=Fernet(stored_key("oauth-encryption.key", Fernet.generate_key)))


def signing_key():
    '''取得专用 JWT 签名密钥；无外部输入；输出持久化随机密钥。'''
    return stored_key("frontend-jwt.key", lambda: secrets.token_bytes(32))
