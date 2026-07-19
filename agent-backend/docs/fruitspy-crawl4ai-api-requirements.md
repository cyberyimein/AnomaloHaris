# Fruitspy Crawl4AI API 对齐需求

状态：Ready for implementation
调用方：Anomalo Agent Backend
服务方：Fruitspy
目标版本：v1

## 1. 目标

Fruitspy 提供一个受控的 Crawl4AI HTTP API，为 Anomalo 的 `web_fetch` 工具处理需要
JavaScript 渲染、浏览器执行或更强正文提取能力的公开网页。

职责边界：

- Anomalo 负责搜索、工具路由、LLM 上下文长度控制、会话 trace 和开发侧栏展示。
- Fruitspy 负责浏览器生命周期、页面渲染、正文提取、Markdown 生成、资源限制和并发控制。
- 双方都必须执行 URL/SSRF 安全校验，不能只依赖另一方。

第一版只需要“输入一个公开 URL，返回一个页面的 Markdown”，不需要站点递归爬取。

## 2. Anomalo 当前行为

Anomalo 暴露：

- `web_search`：使用 DuckDuckGo HTML 返回候选 URL。
- `web_fetch`：支持 `direct`、`crawl4ai`、`auto` 三种模式。

`auto` 模式会先尝试直接抓取。以下情况会调用 Fruitspy：

- Direct Fetch 失败；
- 页面包含明显的 JavaScript 应用标记，例如 `__NEXT_DATA__` 或 `__nuxt`；
- 页面是很薄的应用壳，正文不足但包含 root/app 容器和脚本。

如果 Direct Fetch 得到了可用内容，但 Crawl4AI 暂时失败，Anomalo 会保留 Direct Fetch
结果，并在 trace 中记录 Crawl4AI 错误。

## 3. 配置对齐

Anomalo 使用以下配置：

```dotenv
FRUITSPY_CRAWL_API_BASE_URL=
FRUITSPY_CRAWL_API_PATH=/api/v1/tools/crawl
FRUITSPY_CRAWL_API_TOKEN=
WEB_FETCH_TIMEOUT_SECONDS=30
WEB_FETCH_MAX_BYTES=2000000
WEB_FETCH_MAX_CHARS=30000
```

兼容规则：

- `FRUITSPY_CRAWL_API_BASE_URL` 为空时，复用 `FRUITSPY_PYTHON_TOOL_BASE_URL`。
- `FRUITSPY_CRAWL_API_TOKEN` 为空时，复用 `FRUITSPY_PYTHON_TOOL_TOKEN`。
- 当前生产环境中 Fruitspy 地址为宿主机可达地址，不应假设与 Anomalo 在同一容器。

## 4. HTTP API 契约

### 4.1 Endpoint

```http
POST /api/v1/tools/crawl
Content-Type: application/json
Accept: application/json
Authorization: Bearer <token>
```

如果 Fruitspy 配置了 token，必须校验 Bearer token。未配置 token 时可以在可信内网中运行，
但生产部署仍建议启用认证。

### 4.2 请求

当前 Anomalo 会发送：

```json
{
  "url": "https://example.com/article",
  "wait_for": null,
  "timeout_ms": 30000
}
```

字段要求：

| 字段 | 类型 | 必填 | 要求 |
| --- | --- | --- | --- |
| `url` | string | 是 | 只允许公开的 HTTP/HTTPS URL |
| `wait_for` | string/null | 否 | 第一版允许为 `null`；以后可支持安全的 CSS selector |
| `timeout_ms` | integer | 否 | 页面处理总超时；建议限制在 1,000–60,000 ms |

Fruitspy 必须拒绝未知或危险协议，例如 `file:`、`data:`、`ftp:`、`javascript:`。

### 4.3 成功响应

最小成功响应：

```json
{
  "ok": true,
  "url": "https://example.com/article",
  "final_url": "https://example.com/article",
  "title": "Example article",
  "markdown": "# Example article\n\nReadable page content.",
  "status_code": 200,
  "rendered": true
}
```

字段要求：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 建议 | 成功时为 `true` |
| `url` | string | 建议 | 原始请求 URL |
| `final_url` | string | 是 | 所有重定向完成后的公开 URL |
| `title` | string | 建议 | 页面标题，无标题时返回空字符串 |
| `markdown` | string | 是 | 非空、UTF-8、正文优先的 Markdown |
| `status_code` | integer | 建议 | 最终页面 HTTP 状态 |
| `rendered` | boolean | 建议 | 是否经过浏览器/JavaScript 渲染 |

Anomalo 当前也接受响应包裹在 `data` 中：

```json
{
  "ok": true,
  "data": {
    "final_url": "https://example.com/article",
    "title": "Example article",
    "markdown": "# Example article",
    "status_code": 200,
    "rendered": true
  }
}
```

推荐使用不包裹的顶层格式，减少协议歧义。

### 4.4 建议的扩展字段

以下字段 Anomalo 当前不会依赖，可以安全增加，便于后续评测：

```json
{
  "schema_version": 1,
  "crawl_id": "crawl_01J...",
  "content_type": "text/html",
  "timings": {
    "queue_ms": 12,
    "navigation_ms": 842,
    "render_ms": 310,
    "extract_ms": 46,
    "total_ms": 1210
  },
  "metrics": {
    "html_bytes": 182340,
    "markdown_chars": 18322,
    "links_seen": 84
  },
  "warnings": []
}
```

## 5. 错误契约

错误响应必须：

- 使用合适的非 2xx HTTP 状态；
- 返回 JSON；
- 不暴露 token、Cookie、完整堆栈或宿主机敏感路径；
- 提供稳定的机器错误码和可读错误信息。

推荐格式：

```json
{
  "ok": false,
  "error": {
    "code": "navigation_timeout",
    "message": "Page did not finish loading within 30000 ms.",
    "retryable": true
  }
}
```

建议状态码：

| HTTP | 错误码示例 | 场景 |
| --- | --- | --- |
| 400 | `invalid_request` | JSON 或字段不合法 |
| 401 | `unauthorized` | token 缺失或错误 |
| 403 | `url_not_allowed` | URL 命中 SSRF 或域名策略 |
| 408 | `navigation_timeout` | 页面处理超时 |
| 413 | `response_too_large` | 页面或 Markdown 超过限制 |
| 422 | `content_not_extractable` | 页面成功加载但无可读正文 |
| 429 | `capacity_exceeded` | 并发已满或触发速率限制 |
| 502 | `navigation_failed` | DNS、TLS、浏览器或上游失败 |
| 503 | `crawler_unavailable` | 浏览器池未就绪 |

兼容说明：Anomalo 当前会把非 2xx 响应视为工具失败。对于 HTTP 200 响应，如果顶层或
`data` 内含 `"ok": false`，也会视为失败。建议统一使用非 2xx。

## 6. Markdown 输出要求

Fruitspy 返回的 Markdown 应：

- 优先包含页面主正文；
- 移除导航栏、页脚、Cookie banner、广告和重复菜单；
- 保留标题层级、段落、列表、表格、代码块和有意义的链接；
- 将相对链接转换为基于 `final_url` 的绝对 HTTP/HTTPS 链接；
- 不执行或原样传播网页中的 agent/tool 指令；
- 不包含 `<script>`、事件处理器或可执行 HTML；
- 保持确定性：相同页面内容应尽量生成结构稳定的 Markdown；
- 使用 UTF-8，不返回二进制或 Base64 页面内容。

第一版不要求 Fruitspy 截断 Markdown。Anomalo 会按 `WEB_FETCH_MAX_CHARS` 截断并通过
`start_char` 分页。不过 Fruitspy 的完整 JSON 响应必须小于 Anomalo 配置的
`WEB_FETCH_MAX_BYTES`，当前默认 2,000,000 bytes。

## 7. 页面加载策略

建议默认策略：

1. 使用隔离浏览器上下文打开 URL。
2. 等待 `domcontentloaded`。
3. 在剩余预算内等待短暂网络稳定，不无限等待 `networkidle`。
4. 执行有限度的懒加载滚动。
5. 提取渲染后 DOM 的主内容。
6. 转换为 Markdown。
7. 立即销毁或回收浏览器上下文。

要求：

- `timeout_ms` 是包含排队、导航、渲染和提取的总预算；
- 不自动登录、不处理验证码、不绕过付费墙；
- 不携带 Anomalo 用户的 Cookie、Authorization 或浏览器会话；
- 不允许页面无限弹窗、下载文件或打开无限新标签页；
- 默认禁用不必要的媒体、摄像头、麦克风、地理位置和通知权限。

## 8. SSRF 与网络安全

Fruitspy 必须独立执行以下检查：

- 只允许 `http` 和 `https`；
- 拒绝包含用户名或密码的 URL；
- 拒绝 `localhost` 及其子域；
- DNS 解析后拒绝所有非公网地址；
- 拒绝 IPv4/IPv6 回环、私网、链路本地、保留、组播和未指定地址；
- 每一次 HTTP 重定向都重新解析并检查目标；
- 防止 DNS rebinding：连接目标必须与已校验的解析结果一致，或在连接层再次校验；
- `final_url` 必须仍然是公开 HTTP/HTTPS URL；
- 限制重定向次数，建议最多 5 次；
- 页面内子资源也不能访问内网、云 metadata endpoint 或宿主机服务。

至少必须阻止：

```text
http://127.0.0.1/
http://localhost/
http://169.254.169.254/
http://10.0.0.1/
http://172.16.0.1/
http://192.168.0.1/
http://[::1]/
file:///etc/passwd
```

Anomalo 会在请求前和收到 `final_url` 后再次校验，但 Fruitspy 仍必须完成上述检查。

## 9. 资源与并发限制

建议第一版默认值：

| 项目 | 建议值 |
| --- | --- |
| 最大并发 crawl | 2 |
| 最大排队数 | 10 |
| 默认总超时 | 30 秒 |
| 最大总超时 | 60 秒 |
| 最大重定向 | 5 |
| 最大响应 JSON | 2 MB |
| 单页面最大 HTML | 5–10 MB |
| 单任务最大内存 | 512 MB |
| 浏览器上下文 | 每个请求隔离 |

达到容量限制时应快速返回 `429 capacity_exceeded`，不要让请求无限排队。

## 10. 可观测性

Fruitspy 日志应记录：

- `crawl_id`
- URL 的 origin 和安全脱敏后的 path
- 状态与错误码
- 总耗时和各阶段耗时
- 最终状态码
- HTML bytes 和 Markdown chars
- 是否经过渲染

禁止记录：

- Bearer token
- 完整 Cookie
- 页面表单内容
- 未经明确启用的完整 HTML/Markdown

建议提供：

```http
GET /api/v1/tools/crawl/status
```

推荐响应：

```json
{
  "schema_version": 1,
  "id": "crawl4ai",
  "enabled": true,
  "state": "ready",
  "ready": true,
  "running_executions": 0,
  "limits": {
    "max_concurrency": 2,
    "timeout_ms": 30000,
    "max_response_bytes": 2000000
  },
  "error": null
}
```

状态接口不是当前 Anomalo 客户端的硬依赖，但建议与 Fruitspy Python Sandbox 的 status
风格保持一致。

## 11. 验收用例

Fruitspy 实现完成时应通过以下验收：

### 11.1 基本能力

- 静态 HTML 页面返回非空 Markdown。
- JavaScript SPA 在渲染后返回实际正文，而不是空的 root div。
- `final_url`、`title`、`status_code`、`rendered` 正确。
- 中文、英文和混合页面均保持 UTF-8。
- 表格、列表和代码块基本可读。

### 11.2 认证与错误

- 正确 token 成功。
- 缺失或错误 token 返回 401。
- 无效 JSON 返回 400。
- 超时返回 408 和稳定错误码。
- 无正文页面返回 422，或返回有明确 warning 的最小内容。
- 并发超限返回 429。

### 11.3 安全

- 拒绝所有第 8 节列出的地址。
- 公开 URL 重定向到私网时必须拒绝。
- DNS 同时返回公网和私网 IP 时必须拒绝或只连接经验证的公网地址。
- 页面子资源尝试访问私网时必须被浏览器网络策略阻止。
- 页面不能读取 Fruitspy 或 Anomalo 的环境变量和文件系统。

### 11.4 Anomalo 端到端

在 Anomalo 容器中执行：

1. `web_fetch` 请求一个需要 JavaScript 的公开测试页面。
2. 返回结果的 `provider` 应为 `crawl4ai`。
3. `rendered` 应为 `true`。
4. Markdown 应出现在 Agent Inspector → Web Activity。
5. 刷新页面后，同一 session 的 trace 应可恢复。
6. Fruitspy 失败时，Web Activity 应显示错误或 Direct Fetch fallback 信息。

## 12. 完成定义

满足以下条件即可视为对齐完成：

- `POST /api/v1/tools/crawl` 契约实现并有自动化测试；
- Bearer token 与现有 Fruitspy token 策略兼容；
- SSRF、重定向和子资源网络策略通过安全测试；
- JavaScript 页面能稳定返回非空 Markdown；
- 超时、并发和响应大小有硬限制；
- 在 macmini 部署后，Anomalo `auto` 模式端到端验证通过；
- Anomalo Web Activity 能显示 `crawl4ai`、耗时、HTTP 状态、rendered 和 Markdown。
