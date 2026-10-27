import asyncio
import json
import re
from urllib.parse import urlsplit

import httpx2
from fastmcp.exceptions import ToolError
from fastmcp.tools import Tool, ToolResult
from jsonschema import Draft202012Validator, ValidationError
from mcp.types import TextContent
from pydantic import PrivateAttr


class HelixBridge:
    def __init__(self, base_url, token, client_factory=httpx2.AsyncClient):
        '''绑定唯一 Node 业务服务；输入内网地址及独立机器密钥；输出不持有 FlowUs token 的桥接器。'''
        parts = urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
            raise RuntimeError("HELIX_INTERNAL_URL 必须为无路径的 HTTP(S) 基址")
        if len(token) < 32 or any(char.isspace() for char in token):
            raise RuntimeError("HELIX_INTERNAL_TOKEN 至少 32 字符且不得含空白")
        self.base_url, self.token, self.client_factory = base_url.rstrip("/"), token, client_factory

    async def request(self, method, path, body=None, timeout=90):
        '''调用固定内部端点；输入方法、受控路径及 JSON；输出响应，不转发客户端认证头。'''
        async with self.client_factory(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            return await client.request(method, self.base_url + path, headers={"Authorization": f"Bearer {self.token}"}, json=body)

    async def discover(self, attempts=5):
        '''有限重试读取唯一工具清单；输入尝试次数；输出校验过的定义，鉴权或契约失败立即停止。'''
        for attempt in range(attempts):
            try:
                response = await self.request("GET", "/internal/mcp/tools", timeout=10)
                if response.status_code >= 500:
                    raise httpx2.ConnectError("Helix 暂不可用")
                if response.status_code != 200:
                    raise RuntimeError(f"Helix 工具发现被拒绝（HTTP {response.status_code}）")
                definitions = response.json().get("tools")
                if not isinstance(definitions, list) or not definitions:
                    raise RuntimeError("Helix 工具清单为空或格式无效")
                names = set()
                for item in definitions:
                    if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", item["name"]) or item["name"] in names:
                        raise RuntimeError("Helix 工具名无效或重复")
                    if not isinstance(item.get("description"), str) or not isinstance(item.get("inputSchema"), dict) or item["inputSchema"].get("type") != "object":
                        raise RuntimeError("Helix 工具定义缺少描述或对象输入 schema")
                    Draft202012Validator.check_schema(item["inputSchema"])
                    names.add(item["name"])
                return definitions
            except httpx2.HTTPError:
                if attempt + 1 == attempts:
                    raise RuntimeError("Helix 工具发现失败，已达到重试上限") from None
                await asyncio.sleep(attempt + 1)
        raise RuntimeError("Helix 工具发现尝试次数必须为正")

    async def call(self, name, arguments):
        '''转发一次业务调用；输入工具名与参数；输出业务 JSON，超时不重试写入以免重复执行。'''
        try:
            response = await self.request("POST", "/internal/mcp/call", {"name": name, "arguments": arguments})
        except httpx2.HTTPError:
            raise ToolError("Helix 调用中断；写入可能已完成，请先读取核对，勿直接重试") from None
        if response.status_code >= 500:
            raise ToolError("Helix 服务发生错误；请先读取核对写入结果")
        try:
            result = response.json()
        except (ValueError, TypeError):
            raise ToolError("Helix 返回了无效 JSON；请先核对业务结果") from None
        if response.status_code != 200:
            raise ToolError(json.dumps({"status": response.status_code, "details": result}, ensure_ascii=False))
        return result


class HelixTool(Tool):
    _bridge: HelixBridge = PrivateAttr()

    def __init__(self, definition, bridge):
        '''原样注册 Node 工具定义；输入定义和桥接器；输出 MCP 工具，不维护第二份业务 schema。'''
        super().__init__(name=definition["name"], description=definition["description"], parameters=definition["inputSchema"], annotations=definition.get("annotations"))
        self._bridge = bridge

    async def run(self, arguments):
        '''校验输入后转交业务服务；输入 MCP 参数；输出文本及结构化结果，保留对象的原始结构。'''
        try:
            Draft202012Validator(self.parameters).validate(arguments)
        except ValidationError as error:
            raise ToolError(f"工具参数无效：{error.message}") from None
        result = await self._bridge.call(self.name, arguments)
        return ToolResult(content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                          structured_content=result if isinstance(result, dict) else {"result": result})
