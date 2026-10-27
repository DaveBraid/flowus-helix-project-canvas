import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx2
from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError

from bridge import HelixBridge, HelixTool
from common import secret, storage
from frontend_auth import OwnerVerifier, build_auth

DEFINITION = {"name": "helix_test", "description": "测试读取", "inputSchema": {
    "type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False,
}, "annotations": {"readOnlyHint": True, "destructiveHint": False}}


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def bridge(self, handler):
        '''构造隔离内部服务；输入响应器；输出使用真实 HTTP 客户端的受测桥接器。'''
        return HelixBridge("http://helix:3000", "x" * 32, lambda **kwargs: httpx2.AsyncClient(transport=httpx2.MockTransport(handler), **kwargs))

    async def test_manifest_and_call_use_server_contract_and_machine_token(self):
        '''验证定义保持一致及调用仅携带机器凭据；输入模拟服务；输出请求断言。'''
        requests = []

        def handler(request):
            '''模拟唯一 Node 服务；输入内部请求；输出 manifest 或业务 JSON。'''
            requests.append(request)
            self.assertEqual(request.headers["authorization"], "Bearer " + "x" * 32)
            if request.url.path.endswith("tools"):
                return httpx2.Response(200, json={"tools": [DEFINITION]})
            self.assertEqual(json.loads(request.content), {"name": "helix_test", "arguments": {"id": "project"}})
            return httpx2.Response(200, json={"id": "project", "ok": True})

        bridge = self.bridge(handler)
        manifest = await bridge.discover()
        gateway = FastMCP("test")
        gateway.add_tool(HelixTool(manifest[0], bridge))
        async with Client(gateway) as client:
            tools = await client.list_tools()
            self.assertEqual(tools[0].input_schema, DEFINITION["inputSchema"])
            self.assertTrue(tools[0].annotations.read_only_hint)
            result = await client.call_tool("helix_test", {"id": "project"})
            self.assertEqual(result.structured_content, {"id": "project", "ok": True})
        self.assertEqual(len(requests), 2)

    async def test_invalid_arguments_do_not_call_service(self):
        '''验证越界参数在网络前拒绝；输入未知属性；输出零请求断言。'''
        handler = unittest.mock.Mock()
        tool = HelixTool(DEFINITION, self.bridge(handler))
        with self.assertRaises(ToolError):
            await tool.run({"id": "project", "unknown": "x"})
        handler.assert_not_called()

    async def test_business_error_and_network_error_never_retry_mutation(self):
        '''验证业务失败及连接中断不重复写入；输入失败响应；输出单次请求断言。'''
        for response in (httpx2.Response(409, json={"error": "冲突", "current": 2}), httpx2.ReadTimeout("secret-free")):
            calls = []

            def handler(request):
                '''返回一种受控失败；输入请求；输出冲突或连接超时。'''
                calls.append(request)
                if isinstance(response, Exception):
                    raise response
                return response

            with self.assertRaises(ToolError) as error:
                await self.bridge(handler).call("helix_test", {"id": "x"})
            self.assertEqual(len(calls), 1)
            self.assertNotIn("x" * 32, str(error.exception))

    async def test_discovery_retries_server_errors_but_not_auth_errors(self):
        '''验证发现的重试边界；输入临时故障及鉴权失败；输出有限重试断言。'''
        calls = []

        def handler(request):
            '''首次失败后返回清单；输入请求；输出确定响应。'''
            calls.append(request)
            return httpx2.Response(503 if len(calls) == 1 else 200, json={"tools": [DEFINITION]})

        with patch("bridge.asyncio.sleep", new=AsyncMock()):
            self.assertEqual(await self.bridge(handler).discover(attempts=2), [DEFINITION])
        self.assertEqual(len(calls), 2)
        calls.clear()

        def forbidden(request):
            '''拒绝错误机器凭据；输入请求；输出401。'''
            calls.append(request)
            return httpx2.Response(401, json={"error": "拒绝"})

        with self.assertRaisesRegex(RuntimeError, "401"):
            await self.bridge(forbidden).discover(attempts=5)
        self.assertEqual(len(calls), 1)

    async def test_duplicate_or_empty_manifest_fails_closed(self):
        '''验证启动契约错误直接停止；输入空或重复定义；输出失败断言。'''
        for definitions in ([], [DEFINITION, DEFINITION]):
            with self.assertRaises(RuntimeError):
                await self.bridge(lambda request: httpx2.Response(200, json={"tools": definitions})).discover()


class AuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_owner_and_workspace_must_both_match(self):
        '''验证单所有者身份边界；输入三种身份；输出只有精确匹配时接受。'''
        verifier = OwnerVerifier("owner", "workspace")
        real_client = httpx2.AsyncClient
        for owner, workspace, accepted in (("owner", "workspace", True), ("other", "workspace", False), ("owner", "other", False)):
            client = real_client(transport=httpx2.MockTransport(lambda request: httpx2.Response(200, json={
                "owner": {"id": owner}, "workspace_id": workspace, "integration_id": "frontend-integration",
            })))
            with patch("frontend_auth.httpx2.AsyncClient", return_value=client):
                token = await verifier.verify_token("frontend-only")
            self.assertEqual(token is not None, accepted)

    async def test_users_me_data_envelope_matches_verified_gateway_contract(self):
        '''验证已验收的官方API包装；输入data.owner及workspace/integration；输出正确身份，畸形响应拒绝。'''
        verifier = OwnerVerifier("owner", "workspace")
        real_client = httpx2.AsyncClient
        payloads = [(True, {"data": {"owner": {"id": "owner"}, "workspace_id": "workspace", "integration_id": "frontend-integration"}}),
                    (False, {"data": {"owner": {"id": "owner"}, "workspace_id": "workspace"}}), (False, {"data": None})]
        for accepted, payload in payloads:
            client = real_client(transport=httpx2.MockTransport(lambda request: httpx2.Response(200, json=payload)))
            with patch("frontend_auth.httpx2.AsyncClient", return_value=client):
                result = await verifier.verify_token("frontend-only")
            self.assertEqual(result is not None, accepted)
            if result:
                self.assertEqual(result.client_id, "frontend-integration")
                self.assertEqual(result.subject, "owner")

    async def test_persistent_encrypted_storage_and_oauth_challenge(self):
        '''验证加密持久化和公网默认拒绝；输入临时配置；输出匿名401及发现元数据断言。'''
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "HELIX_MCP_STATE_DIR": directory, "HELIX_MCP_PUBLIC_BASE_URL": "https://helix-mcp.example.com",
            "HELIX_MCP_OWNER_ID": "owner", "HELIX_MCP_WORKSPACE_ID": "workspace",
            "HELIX_MCP_ALLOWED_REDIRECT_URIS": '["http://127.0.0.1:*"]',
        }):
            registration = {"client_id": "example-client", "redirect_uris": ["https://helix-mcp.example.com/auth/callback"]}
            await storage("registration").put(key="flowus-client", collection="setup", value=registration)
            self.assertEqual(await storage("registration").get(key="flowus-client", collection="setup"), registration)
            self.assertFalse(any(b"example-client" in path.read_bytes() for path in Path(directory).rglob("*") if path.is_file()))
            auth = await build_auth()
            gateway = FastMCP("test", auth=auth)
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=gateway.http_app(path="/mcp")), base_url="https://helix-mcp.example.com") as client:
                response = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
                self.assertEqual(response.status_code, 401)
                self.assertIn("resource_metadata=", response.headers["www-authenticate"])
                response = await client.get("/.well-known/oauth-authorization-server")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["issuer"].rstrip("/"), "https://helix-mcp.example.com")
                response = await client.post("/mcp", headers={"Authorization": "Bearer invalid"}, json={})
                self.assertEqual(response.status_code, 401)
                response = await client.post("/register", json={
                    "client_name": "untrusted", "redirect_uris": ["https://untrusted.example.com/callback"],
                    "grant_types": ["authorization_code"], "response_types": ["code"], "token_endpoint_auth_method": "none",
                })
                self.assertEqual(response.status_code, 400)

    async def test_no_anonymous_fallback_without_registration(self):
        '''验证未配置OAuth时拒绝启动；输入空状态；输出显式错误。'''
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HELIX_MCP_STATE_DIR": directory, "HELIX_MCP_PUBLIC_BASE_URL": "https://helix-mcp.example.com"}):
            with self.assertRaisesRegex(RuntimeError, "register_frontend"):
                await build_auth()


if __name__ == "__main__":
    unittest.main()
