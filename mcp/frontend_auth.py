import json
import os

import httpx2
from fastmcp.server.auth import AccessToken, OAuthProxy, TokenVerifier

from common import UPSTREAM_RESOURCE, public_base, signing_key, storage


class OwnerVerifier(TokenVerifier):
    def __init__(self, owner_id, workspace_id):
        '''限定单一所有者和工作区；输入可信服务端标识；输出前端身份验证器。'''
        super().__init__(required_scopes=["all"])
        if not owner_id or not workspace_id:
            raise RuntimeError("必须配置 Helix MCP 所有者和工作区")
        self.owner_id, self.workspace_id = owner_id, workspace_id

    async def verify_token(self, token):
        '''仅验证客户端登录身份；输入前端 OAuth token；输出身份，绝不将该 token 交给 Helix 业务层。'''
        try:
            async with httpx2.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.get("https://api.flowus.cn/v2/users/me", headers={"Authorization": f"Bearer {token}"})
            if response.status_code != 200:
                return None
            payload = response.json()
            profile = payload.get("data", payload)
            if profile.get("owner", {}).get("id") != self.owner_id or profile.get("workspace_id") != self.workspace_id:
                return None
            return AccessToken(token=token, client_id=profile["integration_id"], scopes=["all"], subject=self.owner_id,
                               claims={"sub": self.owner_id, "workspace_id": self.workspace_id})
        except (httpx2.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            return None


async def build_auth():
    '''组装成熟 OAuthProxy；输入专用注册和所有者配置；输出持久化认证，不复用业务 OAuth。'''
    base = public_base()
    registration = await storage("registration").get(key="flowus-client", collection="setup")
    if not registration or registration.get("redirect_uris") != [base + "/auth/callback"]:
        raise RuntimeError("请先为当前公网地址运行 register_frontend.py")
    redirects = json.loads(os.environ.get("HELIX_MCP_ALLOWED_REDIRECT_URIS", '[]'))
    if not isinstance(redirects, list) or any(not isinstance(value, str) or not value for value in redirects):
        raise RuntimeError("HELIX_MCP_ALLOWED_REDIRECT_URIS 必须为非空字符串组成的 JSON 数组")
    if not redirects:
        raise RuntimeError("必须显式配置允许的 MCP 客户端回调地址")
    return OAuthProxy(
        upstream_authorization_endpoint="https://api.flowus.cn/oauth/authorize",
        upstream_token_endpoint="https://api.flowus.cn/oauth/token",
        upstream_revocation_endpoint="https://api.flowus.cn/oauth/revoke",
        upstream_client_id=registration["client_id"], token_endpoint_auth_method="none",
        token_verifier=OwnerVerifier(os.environ.get("HELIX_MCP_OWNER_ID"), os.environ.get("HELIX_MCP_WORKSPACE_ID")),
        base_url=base, redirect_path="/auth/callback", valid_scopes=["all"],
        forward_pkce=True, forward_resource=False,
        extra_authorize_params={"resource": UPSTREAM_RESOURCE}, extra_token_params={"resource": UPSTREAM_RESOURCE},
        client_storage=storage("frontend-oauth"), jwt_signing_key=signing_key(),
        allowed_client_redirect_uris=redirects, require_authorization_consent=True, enable_cimd=False,
    )
