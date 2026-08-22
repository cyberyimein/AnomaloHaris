# Preset Model 核心闭环修复计划

- Status: Proposed
- Date: 2026-08-23
- Target branch: `codex/preset-model-phase5-7`
- Based on: `docs/design/node-preset-model-compute-center.md`
- Audience: Luna、Anomalo runtime/frontend maintainers、reviewers

## 1. 目标

本计划用于完成 Anomalo Node.js Preset Model 的核心运行语义，使 Anomalo 可以作为其他 Agent 服务的本地 AI 算力中心。

完成后必须满足：

1. 外部调用者只用明确的 `name@version` 选择 Preset Model。
2. 同一个 Model Ref 始终解析为固定的 prompt、Provider、工具协议、插件图和运行策略。
3. 所有入口都通过同一个 Node AgentCore 和 RunController 执行，不存在 Registry 外的特殊 Agent runtime。
4. 真实 Provider 能执行 Web 工具调用，UI 能显示正确的模型、prompt、tool 和 run metadata。
5. Python Host/Worker 不再属于生产运行路径，也不作为修复方案重新引入。

“部分插件还不能使用”可以接受，但必须满足以下边界：

- 不可用插件不得被默认 Preset Model 绑定为 required。
- optional 插件必须显式显示 unavailable/degraded，不能静默消失。
- Buddy、Audio、Vision 保持外部插件或 deprecated，不进入 Node Host 核心。
- `host-core` 和 `web` 是本轮核心验收插件；当前信息检索必须真实调用 Web 工具。
- Browser、MCP、artifact 如果暂不作为发布 Gate，必须在 parity manifest 中明确标记为 `optional-plugin`，不能保留 `partial` 后宣称完成。

## 2. 非目标

本轮不做以下工作：

- 恢复或保留 Python 后端兼容运行时。
- 在 Node Host 内实现 Buddy serial/TCP、STT/TTS 或 Vision 重型媒体栈。
- 支持运行时从网络安装 npm 插件。
- 允许调用方动态拼装 prompt、Provider、plugins 或 tools。
- 一次性完成所有第三方插件的迁移。
- 通过修改已发布版本来修复配置；配置变化必须发布新版本。

## 3. 当前基线

当前实现已经具备：

- Preset Model Definition、SQLite Registry 和 draft/publish/retire 生命周期。
- `name@version`、compiled snapshot、prompt/plugin/compiled hashes。
- Node AgentCore、Session、Run、checkpoint、streaming 和工具循环。
- OpenAI structured 与 DSML parser。
- OpenAI-compatible API、Native API、service auth、idempotency 和 usage 基础设施。
- Pi-like PluginHost、child process、timeout、熔断和插件 catalog。
- Preset Model 管理 UI。
- Node Host 单元和集成测试基线。

当前不能宣布核心完成，原因是运行时仍存在以下断点：

1. 全局 Provider Adapter 使用默认 Preset Model 的协议和凭据，非默认模型的 Provider binding 没有生效。
2. 编译后的 temperature、response format 和运行 policy 没有成为不可变 RunSpec，调用方仍可改变部分固定行为。
3. PluginHost lifecycle hook 会触达所有全局已加载插件，没有严格限定为当前模型的固定插件图。
4. 已有 Session 没有优先使用自身绑定的 Model Ref；默认版本切换和 retire 会破坏历史 Session。
5. 真实 Provider、Web、OpenAI SDK、UI E2E 和回滚证据尚未形成可重复 Gate。
6. `docs/migration/node-parity-manifest.json` 的核心能力仍标记为 `partial`。

## 4. 必须冻结的不变量

以下不变量先写入测试，再实施代码：

### 4.1 Model identity

- 对新调用，Model Ref 必须是显式 `name@version`；旧 chat API 仅允许为新 Session 使用配置中的明确默认 Ref。
- published Definition 和 compiled snapshot 不可原地更新。
- prompt、Provider binding、credential reference、tool protocol、plugin locks、tool allowlist 和 policy 任一变化都产生新版本。
- `compiled_hash` 覆盖全部影响运行行为的字段；真实 secret 值不进入 hash、数据库、事件或日志。

### 4.2 Run snapshot

- Route 不直接拼装模型运行策略，而是从 Registry 获取一个不可变 `CompiledRunSpec`。
- Run 开始后不重新读取 draft、插件配置或默认模型配置。
- checkpoint 保存 `model_ref`、`compiled_hash` 和恢复所需的静态运行参数。
- resume 使用原 RunSpec；不能因默认模型、secret、插件目录或配置文件变化而漂移。

### 4.3 Provider binding

- 每个 Run 按其 Preset Model 选择 Provider adapter、base URL、model、credential reference 和 tool protocol。
- `credential_ref` 只通过 Host SecretStore 解析；API key 永不交给插件。
- `tool_protocol=none` 时不得向模型暴露工具。
- Provider capability 与固定工具图不兼容时，模型在 publish 或 invoke 前明确 unavailable。

### 4.4 Plugin isolation

- `tools`、`callTool` 和所有 lifecycle hooks 只能访问当前 Model Ref 锁定的插件集合。
- 插件不能恢复被 Host policy 或 tool allowlist 禁止的工具。
- 插件返回的 messages、tools、call 和 result 必须重新经过 schema 与 allowlist 校验。
- required 插件不匹配 lock/hash 或不可启动时，Preset Model 不可调用。
- optional 插件不可用时产生结构化 degraded event，并进入模型状态和管理 UI。

### 4.5 Session lifecycle

- 新 Session：显式 Model Ref优先，否则使用配置中的明确默认 Ref，然后原子写入 Session binding。
- 已有 Session：自身 `preset_model_ref` 优先；省略 Model Ref 时不得重新选择当前默认值。
- 已有 Session 显式请求其他 Ref 时返回 `session_model_mismatch`。
- retired 版本拒绝创建新 Session，但允许已经绑定的 Session 继续、resume 和读取审计记录。
- 当前默认模型不得直接 retire；必须先切换到另一个 published Ref。

## 5. 目标接口调整

### 5.1 Compiled model

新增或收敛为一个不可变运行对象：

```ts
type CompiledRunSpec = Readonly<{
  modelRef: PresetModelRef;
  compiledHash: string;
  provider: Readonly<{
    adapter: string;
    model: string;
    credentialRef?: string;
    toolProtocol: "openai" | "dsml" | "auto" | "none";
    parameters: Readonly<{
      temperature?: number;
      maxTokens?: number;
    }>;
  }>;
  prompt: Readonly<{
    profile: string;
    system: string;
    hash: string;
  }>;
  plugins: readonly PluginLock[];
  toolCatalog: readonly ToolDefinition[];
  allowedToolNames: ReadonlySet<string>;
  policy: Readonly<{
    maxToolIterations: number;
    runTimeoutMs: number;
    toolTimeoutMs: number;
    toolExecution: "sequential";
    responseFormat?: ResponseFormat;
  }>;
}>;
```

要求：

- 只有 ModelCompiler 构造此对象。
- Route、Compute API、legacy API 和 UI 不分别解释 Definition。
- 对外序列化时隐藏 system prompt、credential reference 和 secret-bearing plugin config。

### 5.2 SecretStore

新增最小接口：

```ts
interface SecretStore {
  resolveCredential(ref: string): Promise<Readonly<{
    baseUrl: string;
    apiKey: string;
    provider?: string;
  }>>;
}
```

第一版可以由环境变量实现，但必须通过 reference 映射，例如：

```text
openrouter-primary -> OPENROUTER_BASE_URL + OPENROUTER_API_KEY
```

禁止行为：

- 把整个 `process.env` 传给插件 child。
- 在 management API 返回 reference 对应的值。
- 在错误、usage 或 debug event 中记录 API key。

### 5.3 ProviderGateway

将当前单例 ModelAdapter 改为 ProviderGateway：

```ts
interface ProviderGateway {
  stream(spec: CompiledRunSpec, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  complete(spec: CompiledRunSpec, request: ModelRequest, signal: AbortSignal): Promise<string>;
}
```

Adapter cache 可以使用以下 key：

```text
adapter + base_url + credential_ref + tool_protocol
```

缓存不得使用明文 API key 作为可日志化 key。secret rotation 后允许重建 Adapter，不改变 Model Ref；审计记录 secret reference 和可选的非敏感 rotation id。

### 5.4 Scoped PluginHost

所有插件操作增加明确 scope：

```ts
type PluginExecutionScope = Readonly<{
  modelRef: PresetModelRef;
  compiledHash: string;
  locks: readonly PluginLock[];
  allowedToolNames: ReadonlySet<string>;
}>;
```

以下方法必须接收相同 scope：

- `tools(scope, context)`
- `callTool(scope, call, context, signal)`
- `dispatch(scope, event)`

不得只在 ContextBuilder 过滤 tool definitions，因为 lifecycle hook 和直接 tool call 同样需要隔离。

### 5.5 Registry resolution modes

拆分含义不同的解析入口：

```ts
resolveForNewSession(ref): CompiledRunSpec
resolveForBoundSession(ref): CompiledRunSpec
resolveForManagement(ref, options): CompiledPresetModel
```

- `resolveForNewSession`：只允许 published。
- `resolveForBoundSession`：允许 published 或 retired，但必须由已持久化 Session binding 触发。
- `resolveForManagement`：按权限显示 draft/published/retired。

禁止通过一个 `allowDraft` 布尔值承载全部生命周期语义。

## 6. 单批次、七切片实施计划

本次按一个开发批次推进七个切片；切片是代码边界和验收边界，不再按轮次拆分。每个切片仍应保持独立提交、独立测试、可单独回滚，后续切片不得掩盖前序测试失败。

#### Slice 1：补齐 contracts 与编译快照

建议提交：

```text
fix: compile complete preset model run specifications
```

工作内容：

- 为 Provider binding、typed policy、PluginExecutionScope 和 CompiledRunSpec 增加内部类型。
- 收紧 `PresetModelDefinitionSchema` 中已知的 provider parameters 和 policy 字段。
- 将 `credential_ref`、adapter、Provider parameters、response policy、plugin config/lock hash 纳入 compiled snapshot。
- 保证 hash canonicalization，不受对象 key 顺序影响。
- publish 前检查版本单调递增、tool protocol 与工具图兼容性。
- 保留旧数据库读取兼容；如 compiled snapshot schema 变化，增加 schema version 和离线重编译 dry-run，不原地静默改写 published 记录。

测试：

- 每个运行字段变化都会改变 `compiled_hash`。
- metadata、状态时间等非运行字段不影响 hash。
- secret 值不进入 snapshot/hash fixture。
- 相同 Definition 在重启后得到相同 hash。
- 旧 snapshot 读取、拒绝或迁移行为明确。

退出条件：

- Route 不再自行从 `definition.policy` 提取零散字段。
- Registry 能返回完整、只读的 CompiledRunSpec。

#### Slice 2：按 Preset Model 路由 Provider

建议提交：

```text
fix: route provider execution through compiled preset bindings
```

工作内容：

- 引入 SecretStore 和 ProviderGateway。
- 移除使用默认 Preset Model tool protocol 创建全局 Adapter 的路径。
- 每次 Run 使用 CompiledRunSpec 中的 adapter/model/credential/tool protocol。
- 分离 structured、DSML、auto 和 none 的 parser 状态。
- `auto` 只在有 capability/fixture 依据时启用；否则 publish/validate 失败。
- Provider error 统一带 `model_ref`、provider model 和非敏感 error code。

测试：

- 同一 Host 中两个 Preset Model 分别使用 `openai` 与 `dsml`，不会交叉解析。
- 两个 credential references 被正确路由，测试日志不包含 key。
- `tool_protocol=none` 不发送 tools，也不解析工具 markup。
- Adapter cache 不导致 protocol 或 credential 串用。
- Abort、timeout、retry 保持 per-run 隔离。

退出条件：

- 非默认 Preset Model 的 Provider 配置真实生效。
- 默认 Anomalo Agent 也通过同一 Gateway，没有特殊 runtime。

#### Slice 3：强制不可变 policy

建议提交：

```text
fix: enforce immutable preset model runtime policies
```

工作内容：

- AgentCore 从 CompiledRunSpec 获取 temperature、最大工具轮数、run/tool timeout 和 response format。
- OpenAI-compatible API 仅接受 messages、model ref、stream 和安全 metadata 等调用字段。
- 调用方传入受 Preset Model 控制的 temperature、response format、tools、tool choice、provider、prompt 或 plugins 时返回稳定的 `preset_model_override_forbidden`。
- 如未来需要调用方参数，必须在 Definition 中声明明确 override policy；本轮不开放。
- checkpoint 保存静态 policy snapshot，resume 不读取新默认值。

测试：

- UI 设置的 temperature 到达 Provider request。
- 相同 Model Ref 的 request 无法改变 temperature/response format/tool limits。
- legacy API、Native API、OpenAI API 对同一 Model Ref 生成相同核心 RunSpec。
- pause/resume 前后 policy 不漂移。

退出条件：

- 同一 `name@version` 的行为不再受调用入口或 Host 默认参数影响。

#### Slice 4：修复 Session binding、retire 和默认版本生命周期

建议提交：

```text
fix: preserve preset model bindings across session lifecycle
```

工作内容：

- 在解析默认模型之前读取已有 Session metadata。
- 为新 Session 和已绑定 Session 使用不同 Registry resolution mode。
- 只在 Session 尚未绑定时使用 `ANOMALO_DEFAULT_PRESET_MODEL`。
- Session binding 与首个 Run record 在事务或等价原子边界中完成。
- retired 版本只允许已有绑定 Session 调用和 resume。
- management retire 拒绝当前默认 Ref，并返回可行动错误。
- `ensureBuiltinDefault` 不得尝试重新 publish retired `anomalo@1`；启动时对无效默认值快速失败并给出明确运维提示。

测试矩阵：

| 场景 | 预期 |
| --- | --- |
| 新 Session 未指定 Ref | 绑定当前明确默认 Ref |
| 旧 Session 未指定 Ref，默认值已变化 | 继续使用原绑定 Ref |
| 旧 Session 指定其他 Ref | `409 session_model_mismatch` |
| retire 后创建新 Session | `404/410 preset_model_not_available` |
| retire 前已绑定 Session | 可继续和 resume |
| retire 当前默认 Ref | management 请求失败 |
| 重启后恢复 paused Run | model ref/hash/policy 不变化 |

退出条件：

- 默认版本切换不会破坏任何已有 Session。
- retire 行为符合“阻止新绑定、保留历史运行”的定义。

#### Slice 5：按编译插件图隔离执行

建议提交：

```text
fix: scope plugin execution to compiled model locks
```

工作内容：

- 将 PluginExecutionScope 从 CompiledRunSpec 传入 AgentCore 和 PluginHost。
- `tools`、`callTool`、context hook、before/after model、before/after tool 和 terminal hooks 全部按 lock ID 过滤。
- 验证运行时 package/manifest hash 与 lock 一致。
- hook 输出重新经过消息 schema、tool schema、allowed tool set 和 Host policy。
- required 插件 unavailable 时在调用前失败；optional 插件产生 degraded event。
- 修正同名 tool priority：只允许在当前 scope 内决议，不得由未绑定插件抢占。
- 默认 `anomalo@1` 只绑定当前真实可工作的核心插件。

测试：

- 加载插件 A/B，但模型只绑定 A 时，B 的 tools 和所有 hooks 均不执行。
- 未绑定高优先级插件不能抢占绑定插件的同名 tool。
- 插件伪造未允许 tool call 时被 Host 拒绝。
- package/hash 漂移使模型 unavailable。
- required/optional failure 产生不同且稳定的状态和事件。
- 至少 `host-core` 与 `web` 两个真实插件 package 通过 child-process 完整调用。

退出条件：

- Preset Model 固定插件图同时约束工具列表、工具执行和 lifecycle hooks。
- 插件适配不完整不会污染其他模型。

#### Slice 6：统一 UI、事件和管理状态

建议提交：

```text
fix: project compiled preset runtime state in the web ui
```

工作内容：

- UI 只从规范事件读取 Model Ref、Provider Model、prompt/tool counts、compiled hash 和 plugin status。
- 删除 `unknown model`、`0 tools` 等掩盖 contract 错误的 fallback；缺失必填字段显示明确错误。
- Preset Model 编辑页区分 Definition、Compiled snapshot 和 runtime availability。
- 显示 required unavailable、optional degraded、Provider unavailable 和 protocol mismatch。
- retire 当前默认模型时禁用按钮并展示切换默认版本的操作提示。
- 工具 timeline 显示 started/finished/error、来源插件和 Web sources。
- 所有 UI API 响应通过共享 contracts 校验。

E2E：

- 创建 draft、validate、publish 新版本。
- 用明确版本创建 Session 并发送普通问题。
- 发送当前信息问题，观察真实 `web_search`/`web_fetch` timeline 和来源。
- 切换默认版本后继续旧 Session。
- retire 非默认旧版本后继续其已绑定 Session，且新 Session 不能使用它。
- Provider 或 required 插件不可用时 UI 显示结构化错误。

退出条件：

- UI 不再显示无来源的 `unknown model` 或错误 `0 tools`。
- UI 与 OpenAI/Native API 对同一次 Run 展示一致身份。

#### Slice 7：真实环境 Gate、parity 与 Node-only 发布证据

建议提交：

```text
test: close node preset model production acceptance gates
```

工作内容：

- 增加受 `ANOMALO_REAL_PROVIDER_TESTS=true` 控制的真实 smoke runner。
- 使用一个 structured tool-call Preset Model 和一个 DSML Preset Model。
- 使用 OpenAI Node SDK 调用 `/v1/chat/completions` 的 stream/non-stream。
- 运行 Web 当前信息检索，确认工具执行而非输出 markup 或凭记忆作答。
- 执行 production image、静态前端和 Node process-tree smoke。
- 执行 Session/legacy preset migration dry-run、幂等检查和摘要报告。
- 执行数据库备份恢复与上一版 Node 镜像回滚演练。
- 更新 parity manifest：只有有测试证据的能力可改为 `parity`；其余必须明确归类 `optional-plugin` 或 `deprecated`。
- 更新 README、ADR、部署和运维文档。

真实 Gate 记录不得包含 secret，至少保存：

```text
timestamp
git_commit
image_tag
model_ref
compiled_hash
provider_model
tool_protocol
run_id
tools_started
tools_finished
source_count
stream_result
non_stream_result
ui_e2e_result
migration_result
rollback_result
```

退出条件：

- 核心 parity manifest 无 `missing` 或 `partial`。
- `host-core` 和 `web` 为 `parity`。
- 暂未完成的 Browser/MCP/Buddy/Audio/Vision/artifact 已做明确产品归类。
- 真实 Provider + Web + UI E2E 通过。
- production image/process tree 无 Python Host/Worker。
- Node-to-Node 回滚演练通过。

## 7. 测试层级

### 7.1 每个切片必须运行

```bash
npm test --workspace @anomalo/contracts
npm test --workspace @anomalo/node-host
npm test --workspace anomalo-frontend
npm run build --workspaces --if-present
git diff --check
```

### 7.2 Provider fixtures

必须保留以下 recorded fixtures：

- OpenAI `delta.tool_calls` 分片、并行 call、arguments 跨 chunk。
- DSML tag 任意 chunk 边界、多个 calls、文本与 call 混合。
- malformed tool call、未知 tool、tool protocol none。
- usage/finish reason/reasoning 的 Provider 差异。
- Provider 在 tool result 后继续生成最终回答。

### 7.3 真实测试费用控制

- 使用最短 prompt、最多一次 search 和一次 fetch。
- 默认 CI 不执行真实 Provider 测试。
- 发布前显式开启 Gate，并限制最大 token、工具轮数和超时。
- 失败重试不得无限执行；每个模型最多一次自动重试。

## 8. 数据与兼容策略

- published 记录禁止原地重编译后覆盖旧 hash。
- 如果 CompiledRunSpec schema 升级，旧记录使用明确 schema version。
- migration 首先 dry-run，输出 created/skipped/error 统计和非敏感 hash。
- migration 必须幂等；重复执行不得创建新版本或改变已发布 hash。
- 历史 Session 保留原 `preset_model_ref` 和 `compiled_hash`。
- legacy `/api/chat` 继续有价值，但只是默认 Preset Model 的便利入口。
- `/api/agents` 等兼容 alias 不得拥有独立存储或运行语义。

## 9. 可观测性要求

每个 Run 至少记录：

- client id
- session id / run id
- model ref / compiled hash
- provider adapter / provider model / tool protocol
- plugin lock hash 和 degraded plugin IDs
- prompt part count / tool count
- latency、input/output tokens、cost（可获得时）
- tool started/finished/error
- finish reason 和规范 error code

禁止记录：

- Provider API key
- management/service token
- secret-bearing plugin config
- 完整 system prompt（除非显式本地 debug 且有管理权限）

## 10. Review checklist

每个 PR reviewer 必须回答：

- 是否让调用方获得了新的 prompt/plugin/provider override 路径？
- 是否有 Route 绕过 CompiledRunSpec 或 AgentCore？
- 是否有全局单例状态跨 Model Ref 泄漏 protocol、credential、policy 或插件？
- 是否改变 published hash、Session binding 或 checkpoint 恢复语义？
- required/optional 插件失败是否可观察？
- 是否新增 Python runtime、Worker、代理 route 或生产依赖？
- 是否更新测试、parity manifest 和回滚说明？

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Compiled snapshot schema 变化 | 旧 published 版本无法读取 | schema version、只读兼容、migration dry-run |
| Provider Adapter cache 串用 | 模型使用错误协议或 credential | 使用完整非敏感 binding key、交叉模型测试 |
| retire/default 竞态 | 新 Session 绑定不可用版本 | transaction、default guard、并发集成测试 |
| 插件 hook 越权 | 未绑定插件修改 Run | scope 强制、输出重校验、负面测试 |
| 真实 Provider 行为漂移 | fixture 通过但生产失败 | fixture + 发布前最小真实 Gate |
| UI fallback 隐藏 contract 错误 | 用户误以为没有工具 | fail-visible、共享 contract、E2E |
| 插件迁移拖延核心 | 无法明确发布边界 | required core 与 optional/deprecated 分类 |

## 12. 最终完成判定

### 12.1 可以宣布“Preset Model 核心完成”

必须全部满足：

- Slice 1–6 全部完成。
- Provider、policy、Session 和插件图四类核心不变量均有负面测试。
- `anomalo@1` 和至少一个非默认 Model Ref 使用各自 Provider binding 正常运行。
- `host-core` 与 `web` 完整执行。
- OpenAI API、Native API、legacy chat 对相同 Model Ref 使用相同 RunSpec。
- UI 正确显示模型和工具调用，不再出现错误的 `unknown model`/`0 tools`。
- 真实 Provider + Web + UI E2E 已通过并留下非敏感结果摘要。

### 12.2 可以宣布“Phase 5–7 和 Node-only 替换完成”

除 12.1 外，还必须满足：

- Slice 7 完成。
- 核心 parity manifest 全部为 `parity`。
- 未完成能力已明确标记 `optional-plugin` 或 `deprecated`。
- production image/process tree 没有 Python Host/Worker。
- 数据迁移、备份恢复和 Node-to-Node 回滚演练通过。
- README、ADR、部署和运维文档与实际行为一致。

任何单独的 health check、工具列表、mock 测试或 Node 进程启动成功，都不能替代上述完成判定。
