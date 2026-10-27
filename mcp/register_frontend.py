import asyncio

import httpx2

from common import public_base, storage


async def main():
    '''注册 Helix MCP 专用 PKCE 客户端；输入公网配置；输出加密注册，不创建业务数据或导出 token。'''
    callback = public_base() + "/auth/callback"
    store = storage("registration")
    existing = await store.get(key="flowus-client", collection="setup")
    if existing:
        if existing.get("redirect_uris") != [callback]:
            raise RuntimeError("已有注册回调不同，停止覆盖；请使用独立状态卷")
        print("helix_mcp_oauth_registration_exists")
        return
    async with httpx2.AsyncClient(timeout=25, follow_redirects=False) as client:
        response = await client.get("https://mcp.flowus.cn/.well-known/oauth-authorization-server")
        response.raise_for_status()
        if response.json().get("registration_endpoint") != "https://api.flowus.cn/register":
            raise RuntimeError("官方注册端点发生变化，停止注册")
        response = await client.post("https://api.flowus.cn/register", json={
            "client_name": "Ethan Helix MCP", "redirect_uris": [callback],
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
            "token_endpoint_auth_method": "none", "scope": "all",
        })
        response.raise_for_status()
        registration = response.json()
    if not registration.get("client_id") or registration.get("redirect_uris") != [callback]:
        raise RuntimeError("官方注册响应缺少必要字段")
    await store.put(key="flowus-client", collection="setup", value=registration)
    print("helix_mcp_oauth_registration_created_and_encrypted")


if __name__ == "__main__":
    asyncio.run(main())
