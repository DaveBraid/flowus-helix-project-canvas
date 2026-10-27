# Helix MCP 所用 FlowUs 契约

核查日期：2026-10-27。核查范围：官方公开文档、当前 CLI 0.3.13 的离线 help/docs/spec。本核查没有读取凭据或写入业务数据。真实写入验收另记。

## 发现面与真实接口

[官方概览](https://flowus.cn/developer-api/v2/zh/getting-started/overview)及 [OpenAPI 说明](https://flowus.cn/developer-api/v2/zh/reference/openapi)明确说明：软删除是受支持的 HTTP 能力，为避免 MCP/CLI 自动发现破坏性工具，故意不进入机器可读 OpenAPI。CLI 拒绝 DELETE、工具列表缺少删除，均不能证明服务端不支持。

API 基址为 `https://api.flowus.cn`，认证为 Bearer token；需要空间计划、资源授权与对应 scope。不得把 token 放入参数、日志或工具结果。[认证与权限](https://flowus.cn/developer-api/v2/zh/getting-started/authentication-and-scopes)、[Scope 对照](https://flowus.cn/developer-api/v2/zh/reference/scopes)。

## 软删除与恢复

| 资源 | HTTP 方法与路径 | Scope | 成功结果 |
| --- | --- | --- | --- |
| 页面 | `DELETE /v2/pages/:page_id` | `pages.write` | `{"object":"page","id":"…","in_trash":true}` |
| 正文块 | `DELETE /v2/blocks/:block_id` | `blocks.write` | `{"object":"block","id":"…","in_trash":true}` |
| 数据库 | `DELETE /v2/databases/:database_id` | `databases.write` | `{"object":"database","id":"…","in_trash":true}` |

三个 DELETE 都没有请求体。官方描述：仅目标根节点进入归档状态；后代随根不可见，但后代不会分别标记删除。重复删除已经在回收站中的对象仍成功。接口不提供永久删除。块删除还保留原父级中的位置，恢复目标块可原位恢复完整子树。数据库恢复根节点即可恢复记录。上述重复删除和恢复仍受资源权限检查约束，不能省略下面的实测边界。

来源：[删除页面](https://flowus.cn/developer-api/v2/zh/write/delete-page)、[删除块](https://flowus.cn/developer-api/v2/zh/write/delete-block)、[删除数据库](https://flowus.cn/developer-api/v2/zh/write/delete-database)。

恢复分别使用 `PATCH /v2/pages/:page_id`、`PATCH /v2/blocks/:block_id`、`PATCH /v2/databases/:database_id`，请求体为 `{"in_trash":false}`，scope 与对应 DELETE 相同。块另兼容 `archived`，新代码优先使用 `in_trash`。这几个字段由公开文字文档承诺；CLI 内嵌非破坏性 OpenAPI 未列出，不能据此否定恢复。

来源：[更新页面](https://flowus.cn/developer-api/v2/zh/write/update-page)、[更新块](https://flowus.cn/developer-api/v2/zh/write/update-block)、[更新数据库](https://flowus.cn/developer-api/v2/zh/write/update-database)。

版本限制：页面 PATCH 明确支持 `If-Match` 弱 ETag，不匹配返回 `409 conflict`；三个 DELETE、块 PATCH 与数据库 PATCH 的对应文档没有承诺 `If-Match`。不能把删除前读取校验当作服务端原子版本锁。页面/块/数据库 DELETE 也没有文档化的 `Idempotency-Key`；不要把权限检查返回的 `403` 当作重复删除成功。来源：[通用约定](https://flowus.cn/developer-api/v2/zh/reference/conventions)。

错误：无效 token `401 unauthorized`；scope 或目标权限不足 `403 forbidden`；对象不存在 `404 not_found`；数据库 DELETE 的目标类型错误为 `400 validation_error`。错误不等于成功，不应统一吞为已删除。

补充：[删除数据库视图](https://flowus.cn/developer-api/v2/zh/write/delete-database-view)是单独契约：`DELETE /v2/databases/:database_id/views/:view_id`，`databases.write`，无 body，返回 `database_view/id/in_trash:true`。可选 `If-Match` 在事务内锁行比对，失配 `409`；禁止删除最后一个有效视图（`400`）。软删除与数据库视图数组移除在同一事务完成；该页未承诺重复删除或恢复方法。

### 页面授权模式的实际边界

2026-10-27，根代理在测试项目报告现场结果：专用普通子页与专用实验记录的首次 DELETE 均返回 `in_trash:true`。删除后的 GET、再次 DELETE、PATCH `in_trash:false` 均返回 `403`，原始 message 为“机器人没有访问指定页面的权限”。当时服务端官方 CLI OAuth 为页面授权模式，`pages.write` 已开启。本文件作者未独立重复写入测试。

因此当前验收状态是：**首次软删除已实测，删除后读取、重复删除与 API 恢复未通过**；不能交付“页面授权模式下可完整撤销删除”的承诺。可能涉及回收站对象的资源授权检查，但原因未确认。官方文档没有披露普通 Integration token 禁删、企业开关、二次确认参数或额外删除请求头；也没有承诺页面授权模式下的回收站可访问性。改为全空间授权后的行为仍待测试，底层凭据扩权必须由用户决定；Helix 工具的项目范围限制应始终保留。

错误解释依据：[错误码](https://flowus.cn/developer-api/v2/zh/reference/error-codes)说明 `403 forbidden` 可能是 scope 不足，也可能是 bot 无权访问资源，应保留原始错误语义，不把 `whoami` 的写能力等同于目标资源权限。

## 页面创建与幂等窗口

[创建页面](https://flowus.cn/developer-api/v2/zh/write/create-page)允许 `parent.page_id` 或 `parent.database_id` 二选一；省略时创建在当前工作区根目录。普通页面父级没有额外公开限制；需要 `pages.write` 与父级写权限。在数据库父级下创建记录必须按实际数据库 schema 提供标题属性。

[通用约定](https://flowus.cn/developer-api/v2/zh/reference/conventions)只承诺同一 token、同一路由、同一 `Idempotency-Key` 与同一请求体返回相同结果；同 key 不同 body 返回 `409 idempotency_conflict`，建议使用 UUID v4。当前文档未规定保存时间、最大长度、是否跨 OAuth 刷新 token 延续；CLI spec 的 key schema 仅为 string，示例 `page-create-001`，UUID 不是公开的强制校验要求。

根代理曾报告同一测试 key 的两次页面创建返回不同 ID；未在本核查中确认两次 token、路由、完整请求体及实际发出的 header 是否完全相同，不能据此断言服务端幂等失效，也不能承诺相同 key 永久去重。创建返回后必须读回目标、核对父级与结构；未知结果应保留操作记录，先核实后续跑。

## 文件上传

`POST /v2/files/upload-url` 需要 `pages.write`；body 必须包含 `filename`、白名单 `content_type`、`content_length`、可写 `parent.page_id`。CLI spec 精确范围为 `1..104857600` 字节；文档称 100 MB，且先检查空间剩余容量。

响应为 `file_upload`，含 `upload_url`、`oss_name`、`size`、`method:PUT`、`headers`、`expiry_time`。上传 URL 有效 30 分钟。按响应 method/headers 向对象存储发送原始字节，HTTP 客户端计算 Content-Length；只有存储 PUT 返回 2xx 才算上传成功。创建 FlowUs 内部媒体块必须同时使用 `oss_name` 与 `size`，不得把兼容 `file_url` 填成外链；追加媒体块还需 `blocks.write`。

来源：[文件上传](https://flowus.cn/developer-api/v2/zh/advanced/file-upload)、CLI `flowus api --docs/--spec /v2/files/upload-url -X POST`。CLI `flowus file upload --parent-page … <file>` 已封装申请上传地址、传字节及返回元数据。

当前 `helix-content.mjs` 的上传请求和内部块结构已对照 CLI spec：`{type:"file",file:{type:"file",file:{oss_name,size,content_type}}}` 合法。`parent.type:"page_id"` 可选，当前只传 `parent.page_id` 合法。MIME 清单与 104857600 字节上限一致。

2026-10-27，根代理报告真实小文件 PUT 返回 `200`，官方返回的兼容 `file_url` 为 `https://cdn2.flowus.cn/…` 无签名地址，匿名 HEAD 与 Range GET 均为 `403`。因此兼容 CDN 地址不能用于本次前置字节核验；不尝试绕过 CDN 权限，也不把这个 403 认定为上传失败。

当前附件流程与官方 CLI 的“PUT 成功后追加内部文件”一致：客户端必须从实际 PUT 响应取得状态，在 `helix_file_attach` 必填 `uploadStatus`（整数 `200`、`201` 或 `204`）；服务端仅接受本进程 `prepare` 保存的同项目、同页面交易，`oss_name`、`size`、`content_type` 全部取服务器记录，不接受客户端替换这些字段。追加后通过官方 `GET /v2/blocks/:block_id` 回读，核对内部文件 `oss_name` 与 `size`；响应包含 `content_type` 时也比对 MIME。成功返回 `verification: "client-put-receipt-and-flowus-block-readback"`。未知追加结果或回读失败均保留原交易结果，重复 attach 不再次追加；需先核对实际页面。

根代理现场回读测试附件：`file` 包含 `caption:[]`、`type:"file"` 与 `file:{oss_name:"oss/…/example-upload.txt",size:67}`，没有 `content_type`。这是允许的响应投影，不能因 MIME 缺省而认定追加失败。缺省时返回 `mimeSource:"upload-request"`，只说明 MIME 取自原上传请求；返回且匹配时为 `mimeSource:"flowus-block-readback"`。已经追加的附件保留，不为这次兼容修正重发追加。

验证限度：`uploadStatus` 是客户端实际 PUT 响应的报告，服务端不能凭这个整数独立证明远端文件真实字节；FlowUs 块回读只证明内部引用元数据与申请交易一致。接口不会声称已独立验证对象字节或哈希。调用方不得在未完成 PUT 或 PUT 失败时伪报成功状态。上传和去重交易只在当前进程内有效，重启或过期后不承诺续接。2026-10-27 已完成远端“PUT→attach→GET block”验收；MIME 缺省时按 `mimeSource:"upload-request"` 标记。未独立验证存储对象字节或哈希。

## 复制与重设父级

CLI 0.3.13 `flowus page duplicate <page_id> [--parent-id <parent_id>] [--title <title>]` 的 help 承诺复制页面及其全部后代；省略 parent 保留原父级，省略 title 保留原生复制默认名称。本次没有找到公开文档或嵌入 OpenAPI 中的稳定 HTTP 复制端点、复制请求体、响应、scope、幂等或并发条件，不能从命令名称杜撰 REST 路由或承诺无损迁移所有对象。

重新设父级使用 `PATCH /v2/pages/:page_id/move`（`pages.write`）。body 的 `parent` 必须且只能选 `{"workspace":true}`、`{"page_id":"…"}`、`{"database_id":"…"}` 之一；可选 `before` 或 `after`，两者互斥且必须指向新父级的直接子节点。源和目标必须同 bot 空间，双方都需写权限。支持页面、数据库、思维导图、文件夹；不支持普通正文块移动。不能移入自己或后代；不传位置追加至末尾。移动到数据库仅改变父级，不填写或校验记录属性，应另行写入并回读。

响应为 `{"object":"move_result","id":"…","object_type":"page|database|mind_map|folder","parent":{…},"after":null,"before":null}`；有定位参数时相应字段返回定位 ID。该移动接口没有文档化的 `If-Match`/幂等请求头。

来源：[移动页面](https://flowus.cn/developer-api/v2/zh/write/move-page)、CLI `flowus help page duplicate`、`flowus api --docs/--spec '/v2/pages/{page_id}/move' -X PATCH`。

## 验收状态与剩余边界

- 2026-10-27，页面、实验、专用普通块与空表的首次软删除均已实测成功；普通块与空表已从有效子块列表移除。当前页面范围授权下恢复仍返回 `403`，不承诺可撤销删除；非空子树、内部文件保持和原位置恢复仍待独立验收。
- 核对 CLI 原生复制返回结构、父级、后代、关系属性和内部文件；不要假定复制会自动重写跨页面 relation。
- 未文档化的并发条件、删除后读取结果和视图恢复行为，保持未知；不要依赖探索发现的私有字段。
