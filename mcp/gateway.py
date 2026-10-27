import asyncio
import os

from fastmcp import FastMCP
from starlette.responses import JSONResponse

from bridge import HelixBridge, HelixTool
from common import public_base, secret, state_dir
from frontend_auth import build_auth


async def build_gateway():
    '''装配远程 MCP；读取 Node 单一工具清单及独立前端 OAuth；输出无业务存储的 HTTP 服务。'''
    state_dir()
    bridge = HelixBridge(os.environ.get("HELIX_INTERNAL_URL", "http://helix:3000"), secret("HELIX_INTERNAL_TOKEN"))
    definitions = await bridge.discover()
    gateway = FastMCP(name="Helix", auth=await build_auth(), instructions=(
        "Helix 用 FlowUs 管理项目、阶段、实验、引用与正文。先发现和读取，再做指定范围的增量更新。"
        "所有工具共享服务器已有 FlowUs 授权；OAuth 登录仅验证服务器所有者身份。"
        "先读取 helix_help 获取工作流和更新契约。调用中断时先读回核对，不直接重复写入。"
    ))
    for definition in definitions:
        gateway.add_tool(HelixTool(definition, bridge))

    @gateway.custom_route("/healthz", methods=["GET"])
    async def health(request):
        '''提供不含凭据的进程检查；输入 HTTP 请求；输出已加载的工具数。'''
        return JSONResponse({"service": "helix-mcp", "tools": len(definitions)})

    return gateway


if __name__ == "__main__":
    public_base() # 启动前验证 OAuth 标识，禁止以匿名模式回退。
    gateway = asyncio.run(build_gateway())
    gateway.run(transport="http", host=os.environ.get("HELIX_MCP_BIND_HOST", "0.0.0.0"), port=18771,
                path="/mcp", show_banner=False, uvicorn_config={"access_log": False})
