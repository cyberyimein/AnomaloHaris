# AnomaloHaris Node.js Preset Model 算力中心开发设计

> 状态：Accepted for implementation
>
> 面向读者：负责实现本方案的 Luna 编码模型，以及后续审查、测试和发布人员
>
> 最终目标：完全使用 Node.js/TypeScript 的类 Pi 架构替换 Python 后端，并把 AnomaloHaris 建设为其他 Agent 服务统一调用的本地 AI 算力中心
>
> 规范词：MUST 表示必须满足，SHOULD 表示默认应满足，MAY 表示可以延后
>
> 取代关系：本文取代 `docs/design/pi-inspired-node-runtime.md` 中“最终保留 Python Worker”和“达到部分 Node 能力即可切换”的目标；旧文档只保留为迁移历史和已实现模块参考

## 1. 给 Luna 的执行摘要

Luna 必须把本文视为最终产品规格，而不是对当前 Node Host 的小修补说明。

目标产品只有一个后端所有者：Node.js/TypeScript。Node Host 必须拥有：

- HTTP、SSE/NDJSON、WebSocket 和静态前端。
- Preset Model 注册、版本、发布、解析和调用。
- Agent loop、上下文构建、工具循环、结构化输出、stop/resume 和 checkpoint。
- Provider 调用与不同工具调用协议的规范化。
- 类 Pi 插件加载、工具注册、生命周期 hook、权限和隔离。
- Session、Run、Usage、Web trace 和审计持久化。
- Web、Browser、MCP、artifact 和管理 API；Buddy、音频、视觉属于可选插件或待废弃能力，不进入 Node Host 核心。
- 对其他本地 Agent 服务提供稳定的 OpenAI-compatible 和 AnomaloHaris-native API。

最终生产运行时不得要求 Python 进程。Python 可以在迁移期作为旧实现和对照测试存在，但不能成为最终架构的 Worker、fallback Host 或隐式依赖。确实需要 Python 生态的外部能力时，AnomaloHaris 只能把它当作独立远程服务，通过公开协议调用；它不属于 AnomaloHaris 后端进程树，也不能拥有 AnomaloHaris Session。

Luna 不得以“Node 服务可启动”“工具出现在 `/api/tools`”“mock 测试通过”作为完成标准。只有真实 Provider、真实工具调用、真实 UI、旧能力矩阵和无 Python 运行时门槛全部通过，才能切换默认后端。

## 2. 核心产品决策

### 2.1 Preset Model 是 AnomaloHaris 的对外产品单位

保留 **Preset Model** 这个名称。

Preset Model 不是 OpenRouter/OpenAI 上的底层 LLM。它是一个固定、可版本化、可直接调用的 Agent 能力包：

```text
Preset Model
  = system prompt / prompt resources
  + 固定的插件及插件配置
  + 底层 Provider Model
  + 工具与 bootstrap policy
  + 上下文、输出、超时和迭代策略
```

外部调用者只需要知道：

```text
name + version
```

规范引用格式：

```text
<name>@<version>

例如：
world-cup-research@1
fomc-brief@3
buddy-companion@2
```

调用者不能覆盖 Preset Model 的 system prompt、插件集合、底层 Provider Model 或工具 allowlist。任何这些内容的变化都必须发布新版本。

**默认 AnomaloHaris Agent 也必须是一个 Preset Model。** 推荐内建名称：

```text
anomalo@1
```

这里的 `Preset` 表示“在调用前已经固定能力组合”，不是“只有特殊 Agent 才使用的可选模式”。系统中不存在绕过 Preset Model Registry 的裸 Agent：

```text
默认聊天  → 当前配置的默认 Preset Model，例如 anomalo@1
指定调用  → 调用方明确提供的 Preset Model，例如 fomc-brief@3
```

因此，默认 AnomaloHaris Agent 和其他 Preset Model 共享同一个 AgentCore、PluginHost、Session、ProviderGateway 和事件协议；差别只在解析出的 Model Ref。

### 2.2 AnomaloHaris 是本地 AI 算力中心

其他 Agent 服务不再分别维护 Provider key、模型选择、工具循环和 Provider 兼容逻辑，而是统一调用 AnomaloHaris。

AnomaloHaris 对外负责：

- 把 `name@version` 解析为不可变 Preset Model 快照。
- 集中管理 Provider credentials 和模型路由。
- 执行固定插件图和工具循环。
- 统一 streaming、错误、usage、cost、trace 和审计。
- 为调用方隐藏 Provider 特有的 tool-call、stream 和错误协议。
- 保证同一 `name@version` 在配置未损坏时具有确定的能力边界。

调用方负责：

- 提供用户消息或消息历史。
- 提供自己的 `client_id`、可选 `session_id` 和幂等键。
- 处理标准响应或订阅 AnomaloHaris 原生事件。
- 不假设底层 Provider、插件实现或 prompt 内容。

### 2.3 最终架构是 Node-only

最终状态必须满足：

- 一个 Node Host 是唯一公开服务进程。
- AgentCore、ProviderGateway、PluginHost、Session 和管理面均为 TypeScript。
- 生产镜像不安装 Python，不复制 Python virtualenv，不启动 Python child process。
- Buddy 不由 Node Host 直接连接；若产品继续保留，由独立的 Node 插件声明并实现 serial/TCP 或外部服务协议。
- Web、MCP、Browser bridge、artifact、管理和数据迁移由 Node 实现。
- STT/TTS/Vision 默认不属于核心产品面；若产品重新启用，只能由独立 Node 插件或外部服务适配，禁止把重型媒体栈和硬件依赖塞进 Node Host，也不得通过内嵌 Python Worker 实现。
- Python Host 只在迁移分支或历史发布中用于回滚，最终发布后删除其启动路径。

## 3. 当前实现的已知事实与失败基线

Luna 开始实现前必须承认当前 Node Host 尚不具备替换资格。

### 3.1 Provider 工具调用并未真正兼容

当前 `OpenAICompatibleAdapter` 只解析 OpenAI streaming 中的 `delta.tool_calls`。真实 OpenRouter + DeepSeek 测试中，模型把工具调用编码为 DSML 文本：

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="web_search">...</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

当前实现把它作为 `message.delta` 和最终文本发送，未产生 `tool.started`、`tool.finished`，也未执行 Web 工具。

因此，以下陈述不成立：

- “工具出现在工具列表，所以工具可用。”
- “模型说它会搜索，所以已经联网。”
- “mock Replay tool-call 测试通过，所以真实 Provider 兼容。”

### 3.2 Node 事件与 UI 投影不一致

当前 Node `llm.request` 事件只提供简化的 `context`，而前端仍按旧 Python 事件中的 request metadata 读取 message、tool 和 model 信息，导致：

```text
0 prompt parts · 0 tools · unknown model
```

Node 事件协议和 UI 必须共同以 `@anomalo/contracts` 为唯一来源，禁止任一方猜测字段。

### 3.3 Node 公共 API 不完整

当前 Node Host 只实现基础 chat、session、tools 和静态资源路由。现有前端还依赖以下能力组：

- Preset Model/旧 preset agent 列表、管理、普通调用和 streaming 调用。
- Prompt、memory、session skills、session MCP 和 search mode。
- Provider model 管理和 OpenRouter credits。
- Buddy、vision、audio、Copilot bridge（当前只保留可选插件边界；是否继续产品化另行决策）。
- Artifact 下载和本地字体。
- Browser Operator 的完整 handshake 和 preset 绑定。

在这些路径获得兼容实现或前端完成原子迁移前，Node 不能成为默认 Host。

### 3.4 当前 Python 仍是行为参考，不是目标依赖

旧 Python 实现仍然是迁移期的行为 oracle：用于冻结事件、API、数据和硬件语义。Luna 必须通过契约测试重现这些行为，但不能通过长期代理请求给 Python 来假装完成 Node 迁移。

## 4. 目标与非目标

### 4.1 目标

- 完整替换 Python 后端，不丢失当前可用功能。
- 把 Preset Model 变成一等、不可变、可版本化的产品对象。
- 让其他本地 Agent 服务用 `name@version` 稳定调用 AnomaloHaris。
- 提供 OpenAI-compatible API，降低其他服务的接入成本。
- 提供 AnomaloHaris-native API，暴露完整 run/tool/context 事件。
- 用类 Pi 插件架构组合固定能力，而不是把所有工具硬编码进 AgentCore。
- 在 Provider Gateway 内解决不同模型的 streaming 和工具调用协议差异。
- 让 UI、外部 API 和内部运行时共享同一套 contracts。
- 记录 usage、cost、延迟、Provider、Preset Model 版本和插件快照，形成统一算力观测面。

### 4.2 非目标

- 不建设互联网多租户 SaaS。
- 不允许运行时自动从网络安装 npm 插件。
- 不承诺安全执行任意不可信插件代码。
- 不让外部调用者动态拼装 prompt、插件或工具。
- 不把 Provider Model 的名称直接当作 Preset Model 身份。
- 不复制 Pi 的 TUI、主题和自定义终端渲染。
- 不在第一版提供模型训练或微调。
- 不用“调用 Python 兼容层”作为最终功能实现。

## 5. 统一术语

| 术语 | 定义 |
| --- | --- |
| Preset Model | AnomaloHaris 发布的固定 Agent 能力包 |
| Preset Model Name | 稳定的小写名称，如 `fomc-brief` |
| Preset Model Version | 每个 name 下单调递增的正整数 |
| Model Ref | `<name>@<version>`，唯一确定一个已发布 Preset Model |
| Provider Model | OpenRouter/OpenAI 等 Provider 的底层模型 ID |
| Model Definition | Preset Model 的声明式配置 |
| Compiled Model | 校验并解析 prompt、插件、Provider 和 policy 后的不可变运行快照 |
| Plugin Binding | Preset Model 对一个固定插件版本和配置的引用 |
| Agent Run | 一次从输入到 finished/stopped/error 的执行 |
| Agent Session | 可选的持久化对话与 checkpoint 容器，固定绑定一个 Model Ref |
| Provider Gateway | 把不同 Provider 协议规范化为 AgentCore 事件的深 Module |
| PluginHost | 加载类 Pi 插件并处理工具与生命周期 hook 的 Module |
| Compute Client | 调用 AnomaloHaris 的外部 Agent 服务 |

文档和代码中禁止使用模糊的 `model` 指代两种对象。变量和字段应明确命名为 `presetModelRef` 或 `providerModel`。

## 6. Preset Model 领域模型

### 6.1 身份规则

```ts
type PresetModelName = string;   // ^[a-z][a-z0-9-]{1,62}$
type PresetModelVersion = number; // positive safe integer
type PresetModelRef = `${PresetModelName}@${PresetModelVersion}`;
```

规则：

1. name 按 ASCII 小写保存，大小写不敏感地唯一。
2. version 是每个 name 下单调递增的正整数，从 `1` 开始。
3. `name@version` 一旦发布永不改变。
4. 修改 prompt、插件、插件配置、Provider Model、temperature、工具策略、输出策略或安全策略必须创建新版本。
5. 已发布版本不能删除，只能标记 `retired`；已有 Session 和审计记录仍可解析。
6. `/v1` 和新的 Native Preset Model API 必须显式提供 version，不支持含义漂移的 `latest`；旧默认 chat API 是唯一允许省略 Model Ref 的便捷入口。
7. 管理 UI MAY 提供“基于最新版创建草稿”，但调用协议仍保存具体版本。
8. Host 配置 `ANOMALO_DEFAULT_PRESET_MODEL` MUST 保存明确的 `name@version`，默认建议为 `anomalo@1`。
9. 修改默认 Model Ref 只影响新 Session；已存在 Session 继续绑定创建时解析出的明确版本。

### 6.2 Definition Schema

规范类型放入 `@anomalo/contracts`，运行时使用 TypeBox/Ajv 校验。

```ts
type PresetModelDefinition = {
  api_version: "anomalo.dev/v1";
  kind: "PresetModel";
  metadata: {
    name: PresetModelName;
    version: PresetModelVersion;
    description: string;
    status: "draft" | "published" | "retired";
  };
  spec: {
    provider: {
      adapter: string;
      model: string;
      credential_ref: string;
      tool_protocol: "openai" | "dsml" | "auto" | "none";
      parameters?: {
        temperature?: number;
        max_tokens?: number;
      };
    };
    prompt: {
      system: string;
      resources?: Array<{
        path: string;
        required: boolean;
      }>;
    };
    plugins: Array<{
      id: string;
      package: string;
      version: string;
      config: Record<string, unknown>;
      required: boolean;
      permissions: string[];
    }>;
    policy: {
      max_tool_iterations: number;
      run_timeout_ms: number;
      tool_timeout_ms: number;
      tool_execution: "sequential";
      response_format?: "text" | "json_object" | "json_schema";
      json_schema?: Record<string, unknown>;
    };
  };
};
```

`credential_ref` 只引用 Host secret store 中的名称，Definition 不得保存真实 API key。

### 6.3 示例

```yaml
api_version: anomalo.dev/v1
kind: PresetModel
metadata:
  name: world-cup-research
  version: 1
  description: 使用官方来源回答足球赛事问题
  status: published
spec:
  provider:
    adapter: openrouter
    model: deepseek/deepseek-v4-flash-0731
    credential_ref: openrouter-primary
    tool_protocol: dsml
    parameters:
      temperature: 0.2
  prompt:
    system: |
      你是体育研究 Agent。涉及赛果和当前信息时必须先联网检索，
      优先使用赛事组织方的官方来源，并明确区分事实与推断。
  plugins:
    - id: web
      package: "@anomalo/plugin-web"
      version: "1.0.0"
      required: true
      permissions:
        - network.public-http
        - tools.register
      config:
        allowed_domains: []
        max_results: 8
  policy:
    max_tool_iterations: 8
    run_timeout_ms: 120000
    tool_timeout_ms: 30000
    tool_execution: sequential
    response_format: text
```

外部服务只发送：

```json
{
  "model": "world-cup-research@1",
  "messages": [
    { "role": "user", "content": "2026 年世界杯冠军是谁？" }
  ]
}
```

### 6.4 发布与编译

Preset Model 生命周期：

```text
draft
  → validate
  → compile
  → real-provider smoke test
  → publish
  → invoke
  → retire
```

发布前 `ModelCompiler` MUST：

- 校验 Definition schema。
- 校验 name/version 唯一和版本单调递增。
- 解析全部 prompt resources 并计算 `prompt_hash`。
- 解析并锁定每个插件的 package version、entry、manifest 和 config hash。
- 检查插件权限与 Host allowlist。
- 合并工具定义并检查重名与 schema。
- 检查 Provider capability 是否满足插件需求。
- 如果 plugins 非空而 Provider `tool_protocol=none`，拒绝发布。
- 执行 fixture compile test；配置要求时执行真实 Provider smoke test。
- 生成不可变 `compiled_snapshot_json` 和 `compiled_hash`。

每次 Run 必须记录 `model_ref` 和 `compiled_hash`。运行期间不得重新读取草稿或接受配置热变更。

## 7. 目标架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Compute Clients                                              │
│ Other agents · CLI · OpenAI SDK · AnomaloHaris Web UI            │
└───────────────────────┬──────────────────────────────────────┘
                        │ HTTP/SSE/NDJSON/WebSocket
┌───────────────────────▼──────────────────────────────────────┐
│ Node.js Host                                                 │
│ Auth · Validation · Compatibility Routes · Static Web        │
│                                                              │
│  ┌──────────────────┐      ┌───────────────────────────────┐ │
│  │ PresetModel API  │─────▶│ Registry + Compiler           │ │
│  └──────────────────┘      └───────────────┬───────────────┘ │
│                                            │ Compiled Model   │
│  ┌──────────────────┐      ┌───────────────▼───────────────┐ │
│  │ RunController    │─────▶│ AgentCore                     │ │
│  └────────┬─────────┘      │ loop · finalizer · checkpoint │ │
│           │                └──────┬──────────────┬─────────┘ │
│  ┌────────▼─────────┐             │              │           │
│  │ Session/Run DB   │    ┌────────▼──────┐ ┌────▼─────────┐ │
│  │ Usage/Audit DB   │    │ ToolRuntime   │ │ ContextBuilder│ │
│  └──────────────────┘    └────────┬──────┘ └───────────────┘ │
│                                   │                           │
│                          ┌────────▼─────────────────────────┐ │
│                          │ Pi-like PluginHost               │ │
│                          │ Web · MCP · Browser · Buddy ...  │ │
│                          └──────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ProviderGateway                                        │ │
│  │ OpenAI protocol · DSML · errors · usage · retry        │ │
│  └─────────────────────────────────────────────────────────┘ │
└────────────────────────────┬─────────────────────────────────┘
                             │ Provider HTTP APIs
                    ┌────────▼────────┐
                    │ OpenRouter etc. │
                    └─────────────────┘
```

依赖方向：

```text
Host → Application Services → AgentCore
AgentCore → Context / Tool / Session / Provider interfaces
PresetModelCompiler → PluginCatalog / ProviderCapabilities
PluginHost → ToolRuntime registration and lifecycle events
Adapters → external SDK, network, SQLite, serial/TCP, filesystem
```

禁止：

- AgentCore import Fastify、SQLite driver、Provider SDK、Vue 或具体插件。
- Route handler 自己拼 prompt、选插件或执行工具循环。
- Plugin 直接访问 Session 数据库、Fastify 或原始 `process.env`。
- UI 维护一套与 contracts 不同的事件定义。

## 8. 推荐仓库布局

迁移应逐步深化现有 workspace，不要求一次性移动全部文件。

```text
AnomaloHaris/
├── apps/
│   ├── node-host/                    # 迁移期保留路径，最终可改名 host
│   └── web/                          # 可在稳定后由 frontend/ 迁移
├── packages/
│   ├── contracts/                    # 唯一网络/事件/schema 来源
│   ├── preset-models/                # Registry、Compiler、版本规则
│   ├── agent-core/                   # Agent loop 深 Module
│   ├── provider-gateway/             # Provider 协议规范化
│   ├── plugin-host/                  # Pi-like 插件运行时
│   ├── tools/                        # ToolRuntime
│   ├── context/                      # ContextBuilder
│   ├── session/                      # Session/Run repositories
│   ├── usage/                        # usage、cost、配额和审计
│   └── plugins/
│       ├── core/
│       ├── web/
│       ├── mcp/
│       ├── browser/
│       ├── buddy/
│       ├── audio/
│       ├── vision/
│       └── artifacts/
├── frontend/                         # 迁移期继续使用
├── config/
│   ├── preset-models/
│   └── plugins.yaml
└── docs/
```

在 Module interface 稳定前，Luna SHOULD 在现有 `apps/node-host` 内提取模块，避免同时进行目录搬迁和行为修改。

## 9. 核心 Module 规格

### 9.1 PresetModelRegistry

```ts
interface PresetModelRegistry {
  createDraft(input: NewPresetModelDraft): Promise<PresetModelDefinition>;
  updateDraft(ref: PresetModelRef, patch: DraftPatch): Promise<PresetModelDefinition>;
  validate(ref: PresetModelRef): Promise<ModelValidationReport>;
  publish(ref: PresetModelRef): Promise<CompiledPresetModel>;
  retire(ref: PresetModelRef): Promise<void>;
  resolve(ref: PresetModelRef): Promise<CompiledPresetModel>;
  list(query: PresetModelQuery): Promise<PresetModelSummary[]>;
}
```

不变量：

- `resolve` 只返回 published 或允许历史 Session 读取的 retired 版本。
- published definition 和 compiled snapshot 不可修改。
- 所有写操作事务化。
- public list 不返回 system prompt、credential ref、插件 secret config。

### 9.2 ModelCompiler

```ts
interface ModelCompiler {
  compile(definition: PresetModelDefinition): Promise<CompiledPresetModel>;
}
```

Compiler 是深 Module。Route、UI 和 AgentCore 不得分别解析插件和 prompt。

`CompiledPresetModel` 至少包含：

- `ref`
- `providerAdapter`
- `providerModel`
- `providerToolProtocol`
- 已解析 system/context resources
- 排序并锁定的 plugin bindings
- 合并后的 tool catalog
- policy
- `promptHash`
- `pluginLockHash`
- `compiledHash`

### 9.3 RunService

所有调用入口必须汇入同一个 application service：

```ts
interface RunService {
  start(request: StartPresetModelRun): AsyncIterable<AgentEvent>;
  stop(runId: RunId, reason: StopReason): Promise<StopResult>;
  resume(request: ResumePresetModelRun): AsyncIterable<AgentEvent>;
}
```

`RunService.start` 顺序固定：

```text
authenticate client
  → validate request
  → resolve exact name@version
  → bind/check session model ref
  → snapshot compiled model
  → begin run + usage record
  → call AgentCore
  → persist terminal state and usage
  → serialize events for selected transport
```

UI、旧 `/api/chat`、Preset Model API 和 `/v1/chat/completions` 不能各自创建独立 Agent loop。

旧 chat 路由未提供 Model Ref 时，`RunService` 在创建新 Session 前把它解析为 `ANOMALO_DEFAULT_PRESET_MODEL`，并把解析后的明确版本写入 Session。后续请求不能因为默认配置变化而漂移到另一个版本。

### 9.4 AgentCore

AgentCore 继续使用小 Interface：

```ts
interface AgentCore {
  execute(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
```

输入必须携带 Compiled Model，不得只传可变字符串配置。

AgentCore 负责：

- 上下文构建和每次模型请求。
- Provider 标准事件消费。
- 工具循环和迭代限制。
- tool allowlist 二次校验。
- stop、timeout、checkpoint、resume。
- 结构化输出 finalizer。
- plugin lifecycle hook。
- terminal event 恰好一次。

### 9.5 ProviderGateway

```ts
interface ProviderAdapter {
  readonly id: string;
  capabilities(model: string): Promise<ProviderCapabilities>;
  stream(request: NormalizedModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  complete(request: NormalizedModelRequest, signal: AbortSignal): Promise<ModelCompletion>;
}

type ModelStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.calls"; calls: ToolCall[] }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; finishReason: string };
```

Provider SDK 和 wire payload 不得越过该 Seam。

### 9.6 ToolRuntime

```ts
interface ToolRuntime {
  list(model: CompiledPresetModel, context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, model: CompiledPresetModel, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(model: CompiledPresetModel): Promise<ToolAdapterStatus[]>;
}
```

`list` 的结果只能来自 Compiled Model 固定插件图。调用方、Session 和模型本身不能激活定义外的插件。

### 9.7 Session、Run 和 Usage

```ts
interface SessionRepository {
  open(sessionId: SessionId): Promise<SessionSnapshot>;
  bindModel(sessionId: SessionId, ref: PresetModelRef): Promise<void>;
  append(entries: NewSessionEntry[]): Promise<void>;
  checkpoint(record: RunCheckpoint): Promise<void>;
  resume(runId: RunId): Promise<ResumableRun>;
}

interface UsageRepository {
  begin(record: UsageStart): Promise<void>;
  add(record: UsageDelta): Promise<void>;
  finish(record: UsageFinish): Promise<void>;
  summarize(query: UsageQuery): Promise<UsageSummary>;
}
```

Session 一旦有第一条消息，就固定绑定 `model_ref`。继续会话时请求中的 Model Ref 必须相同，否则返回 `session_model_mismatch`。

## 10. Provider 协议兼容与真实工具调用

### 10.1 规范化责任

Provider Adapter 必须处理：

- OpenAI `delta.content`。
- OpenAI `delta.tool_calls` 的分片 id/name/arguments。
- DSML 工具调用文本的跨 chunk 增量解析。
- Provider usage 和 finish reason。
- 空文本 delta、reasoning delta 和未知字段。
- stream 中断时的部分文本和部分 tool calls。
- 非 streaming structured finalizer。
- HTTP、Provider、协议和内容过滤错误的规范化。

### 10.2 DSML 规则

DSML Adapter MUST 使用有状态 parser，而不是单个正则表达式。

要求：

- 标记可能跨任意 chunk 边界。
- 工具名、参数名和参数文本必须经过 schema 校验。
- 工具 markup 不得作为普通文本发送到 UI。
- 完整 DSML block 转换为一个 `tool.calls` 事件。
- 同一个 block 中多个 invoke 保持原顺序。
- malformed DSML 返回 `provider_protocol_error`，不得静默完成 run。
- 未闭合 DSML 在 stop 时进入 checkpoint，resume 后不能重复执行已确认的调用。
- 如果 text 和 tool calls 混合，只有用户可见文本进入 assistant draft。

### 10.3 Provider capability gate

发布 Preset Model 时必须记录：

```ts
type ProviderCapabilities = {
  streaming: boolean;
  tools: "native" | "encoded" | "none";
  structuredOutput: "native" | "prompted" | "none";
  vision: boolean;
  maxContextTokens?: number;
};
```

插件提供工具但 Provider 不支持可靠工具调用时，发布失败。`auto` 只能在 capability probe 和 recorded fixture 均存在时使用。

### 10.4 真实环境验收

至少维护两个 Provider conformance profile：

1. 标准 OpenAI structured tool calls。
2. 当前实际使用的 OpenRouter + DeepSeek DSML/encoded tool calls。

每个 profile 必须拥有：

- recorded SSE fixture。
- chunk boundary fuzz test。
- 单工具、多工具、Unicode 参数、invalid JSON、stop 中断测试。
- 一次受环境变量保护的真实 API smoke test。

真实测试必须让模型查询训练截止后才能知道的信息，并断言：

- 发生 `tool.started` 和 `tool.finished`。
- Web Adapter 确实发出请求并记录 trace。
- 最终回答来自工具结果。
- 最终文本不含 DSML 或其他 Provider markup。

## 11. 类 Pi PluginHost

### 11.1 兼容范围

第一版最终目标：

| 等级 | 能力 | 要求 |
| --- | --- | --- |
| L1 | prompt/resource/package metadata | MUST |
| L2 | `registerTool`、JSON Schema、tool call/result | MUST |
| L3 | session/run/context/tool lifecycle hooks | MUST |
| L4 | branch/fork/compaction/custom entries | SHOULD |
| L5 | TUI、主题、自定义终端 UI | 非目标 |

### 11.2 插件 manifest

```ts
type PluginManifest = {
  id: string;
  package: string;
  version: string;
  entry: string;
  piCompatibility: "L1" | "L2" | "L3" | "L4";
  permissions: string[];
  capabilities: {
    tools?: string[];
    hooks?: string[];
    resources?: string[];
  };
};
```

Preset Model binding 必须锁定 package version 和 manifest hash。相同 `name@version` 不得因为本地 npm package 被替换而改变能力；启动时 hash 不一致必须拒绝加载并标记模型不可用。

### 11.3 生命周期顺序

```text
Host security policy
  → Preset Model policy
  → plugins in definition order
  → AgentCore operation
  → plugins in reverse order for terminal hooks
```

首批 hook：

- `session_start`
- `before_agent_start`
- `context`
- `before_model_request`
- `tool_call`
- `tool_result`
- `turn_end`
- `agent_end`

安全 policy 拥有最终否决权。插件只能缩减能力，不能恢复被 Host 禁止的工具、网络或文件系统权限。

### 11.4 固定组合

Preset Model 的插件组合是发布内容，不是 Session 状态。

- 调用方不得传 `plugins` 或 `tools` 覆盖。
- UI 不提供对已发布版本的动态插件开关。
- session skills/MCP 的旧动态开关只能在兼容模式使用；迁移后应转化为新 Preset Model 版本。
- MCP server 可由一个固定配置的 MCP 插件 binding 提供。
- Bootstrap tool 由插件 manifest 声明，Compiler 检查其安全级别。

### 11.5 隔离与权限

- 插件必须显式安装并进入 allowlist。
- 运行时不得执行 `npm install`。
- 默认在独立 Node child process 或 Worker Thread 中运行；涉及原生模块时优先 child process。
- 每个插件获得最小环境，默认没有 Provider key、admin token 和全部 `process.env`。
- 文件、网络、serial、camera、microphone 等能力需要 manifest permission 和 Host policy 同时允许。
- 每个 hook/tool 有 timeout、AbortSignal、失败计数和熔断。
- required 插件不可用时该 Preset Model 不可调用；optional 插件不可用时必须在模型状态和 run event 中明确降级。

## 12. 上下文与时间语义

ContextBuilder 输入必须是 Compiled Model 快照和 run/session 状态。

固定顺序：

1. Host 安全和协议约束。
2. 当前时间、时区和 runtime metadata。
3. Preset Model system prompt。
4. Preset Model prompt resources。
5. 固定插件 instructions。
6. bootstrap results。
7. Session history 或外部调用消息历史。
8. 当前用户消息。
9. 当前 run 的 tool-loop messages。

要求：

- 每个 run 开始时冻结 1–6 的静态快照。
- 当前时间由 Host 注入，禁止依赖 Provider 训练时间判断“现在”。
- ContextBuilder 产生 segment metadata 和 count，但 public event 默认不暴露 prompt 内容。
- 插件 context hook 的输出重新经过 schema、tool allowlist 和 token budget 校验。
- 同一 run 不能因为磁盘文件变化而更换 prompt 或插件版本。

## 13. 对外 Compute API

### 13.1 OpenAI-compatible API

首批必须支持：

```text
GET  /v1/models
POST /v1/chat/completions
```

`GET /v1/models` 返回已发布且可调用的 Preset Model，`id` 使用 `name@version`：

```json
{
  "object": "list",
  "data": [
    {
      "id": "world-cup-research@1",
      "object": "model",
      "owned_by": "anomalo",
      "metadata": {
        "name": "world-cup-research",
        "version": 1,
        "description": "使用官方来源回答足球赛事问题"
      }
    }
  ]
}
```

`POST /v1/chat/completions` 支持：

- `model`：必须为明确 `name@version`。
- `messages`：允许 user/assistant 历史和 tool-free client context。
- `stream`：false 返回标准 JSON；true 返回标准 SSE chunks。
- `response_format`：只能缩窄为 Preset Model 允许的输出类型，不能放宽。
- `metadata.client_id`：可选调用方标识。
- `metadata.session_id`：可选持久化 Session。

禁止或忽略前必须明确报错的字段：

- 调用方 `tools`
- 调用方 `tool_choice`
- 调用方 system/developer message
- 调用方 Provider Model override
- 调用方 prompt/plugin override

标准 API 对外只流最终 assistant 内容和 usage。内部工具细节通过 AnomaloHaris-native API 获取，避免破坏 OpenAI SDK 兼容性。

### 13.2 AnomaloHaris-native API

```text
GET  /api/preset-models
GET  /api/preset-models/{name}/versions/{version}
POST /api/preset-models/{name}/versions/{version}/runs
POST /api/runs/{run_id}/stop
POST /api/runs/{run_id}/resume
GET  /api/runs/{run_id}
GET  /api/runs/{run_id}/events
WS   /ws/runs/{run_id}
```

Native streaming 使用共享 `AgentEvent`。它暴露 tool timeline、Web trace、checkpoint 和 context diagnostics，但仍不泄露 secret 或 private prompt。

### 13.3 默认聊天与旧 API 的长期价值

以下现有入口 SHOULD 长期保留为本地 UI、脚本和简单客户端的便捷 API，而不仅是短期迁移代码：

```text
POST /api/chat
POST /api/chat/stream
WS   /ws/chat/{session_id}
```

语义：

- 请求没有 `preset_model` 时，使用 `ANOMALO_DEFAULT_PRESET_MODEL`。
- 请求 MAY 显式提供完整 `preset_model: "name@version"`；不接受只有 name 的模糊引用。
- 新 Session 在第一次 Run 时固定绑定解析后的 Model Ref。
- 响应和 `run.started` 必须返回实际 `model_ref`。
- 路由只做兼容 request/transport 转换，然后调用统一 RunService。
- 禁止保留一套“默认 AgentRuntime”和另一套“Preset Model Runtime”。

入口解析规则：

| 入口 | Model Ref | 用途 |
| --- | --- | --- |
| `/api/chat*`、旧 Chat WebSocket | 可省略；省略时解析默认值 | 通用 AnomaloHaris Agent、本地 UI、简单远程客户端 |
| `/api/chat*`、旧 Chat WebSocket | 可显式传 `name@version` | 兼容期统一 transport |
| `/v1/chat/completions` | 必须显式传 `model=name@version` | OpenAI SDK 和其他 Agent 服务 |
| Native Preset Model Run API | 路径中必须包含 name/version | 富事件、调试和管理客户端 |

因此，“不使用 Preset Model”在内部并不存在；调用者只是选择不显式指定，Host 随即解析并固定绑定默认 Preset Model。

旧 `/api/agents` 和 `/api/agents/{ref}/chat*` 只在迁移设计中保留为历史记录，最终 Node Host 不再注册这些兼容别名；客户端应使用 `/api/preset-models` 或 `/v1/chat/completions`。

### 13.4 管理 API

```text
GET    /api/manage/preset-models
POST   /api/manage/preset-models
PATCH  /api/manage/preset-models/{name}/versions/{version}
POST   /api/manage/preset-models/{name}/versions/{version}/validate
POST   /api/manage/preset-models/{name}/versions/{version}/publish
POST   /api/manage/preset-models/{name}/versions/{version}/retire
GET    /api/manage/plugins
POST   /api/manage/plugins/validate
GET    /api/manage/providers
GET    /api/manage/usage
```

只有 draft 可 PATCH。publish 后修改返回 `immutable_model_version`。

### 13.5 幂等、并发与错误

- 支持 `Idempotency-Key`，同一 client、Model Ref 和 key 返回同一 Run。
- 同一 Session 默认只允许一个 active Run。
- 客户端断开不自动取消非 streaming Run；streaming 可通过策略决定 stop 或继续。
- 错误包含稳定 `code`、message、run_id 和可重试标记。

首批错误码：

```text
preset_model_not_found
preset_model_unpublished
preset_model_unavailable
immutable_model_version
session_model_mismatch
provider_unavailable
provider_protocol_error
provider_tool_unsupported
plugin_unavailable
plugin_permission_denied
tool_not_allowed
run_already_active
run_timeout
checkpoint_not_found
invalid_request
unauthorized
rate_limited
```

## 14. Event 与 UI 契约

### 14.1 `llm.request` 的规范数据

```ts
type LlmRequestEventData = {
  model_ref: PresetModelRef;
  provider_model: string;
  iteration: number;
  request: {
    message_count: number;
    tool_count: number;
    response_format: string;
  };
  context: {
    segment_counts: Record<string, number>;
    total_message_count: number;
    tool_count: number;
    compiled_hash: string;
  };
};
```

前端必须从这些显式 count 字段渲染，不得通过可选 message/tool 数组推断。管理调试视图如需完整 prompt，必须调用受 admin token 保护的独立 debug API。

### 14.2 UI 必须展示

- `Preset Model Name @ Version`
- Provider Model
- prompt parts/context segments
- 当前可用工具数量和固定插件列表
- `tool.started`、`tool.finished`、`tool.error`
- Web search/fetch trace 和来源 URL
- run id、状态、stop/resume
- usage、延迟和可用时的 cost
- provider/plugin degraded 状态

UI 不得把 404、schema mismatch 或缺失字段静默显示为 `0`、空列表或 `unknown model`。加载失败必须显示结构化错误和失败 API。

### 14.3 单一契约来源

- 所有 event、API request/response、Definition 和错误码在 `@anomalo/contracts` 定义。
- Fastify 使用导出的 JSON Schema 验证。
- 前端通过 contracts parser 消费。
- fixture 同时运行于 Host test 和 frontend projection test。
- breaking change 提升 schema version，并保留一个发布周期的兼容 parser。

## 15. 数据设计

建议新增表：

```text
preset_models
preset_model_versions
preset_model_plugin_locks
installed_plugins
provider_configs
agent_sessions
session_entries
runs
run_events
run_checkpoints
tool_calls
web_traces
usage_records
service_clients
idempotency_records
```

关键字段：

```text
preset_models:
  name, description, created_at, updated_at

preset_model_versions:
  name, version, status, definition_json,
  compiled_snapshot_json, prompt_hash, plugin_lock_hash,
  compiled_hash, created_at, published_at, retired_at

runs:
  run_id, session_id, client_id,
  preset_model_name, preset_model_version, compiled_hash,
  provider_adapter, provider_model,
  status, error_code, started_at, ended_at

usage_records:
  run_id, provider_request_id,
  input_tokens, output_tokens, cached_tokens,
  estimated_cost, currency, latency_ms
```

约束：

- `(name, version)` 是 Preset Model version 主键。
- published row 的 definition 和 compiled fields 由数据库 trigger 或 Repository invariant 禁止更新。
- Session 保存明确 name/version，不保存 `latest`。
- run 保存 compiled hash，便于审计本地插件文件是否发生漂移。
- secret 不进入数据库定义 JSON；只保存 credential reference。

## 16. 安全与本地部署

“本地服务”不等于“无需安全边界”。AnomaloHaris 集中持有 Provider key、浏览器、文件、设备和插件执行能力。

要求：

- 默认只绑定 loopback。
- LAN/public bind 必须显式确认并启用 bearer token。
- service client token 与 admin token 分离。
- service token 可限制允许调用的 Preset Model names/versions、并发和预算。
- public model list 不返回 prompt、plugin config、credential ref。
- 所有 URL fetch 保持 SSRF、DNS rebinding、redirect 和响应大小防护。
- Browser/Buddy/文件写入等有副作用工具支持审批策略和幂等键。
- 插件 child process 使用最小 env 和明确权限。
- 日志默认不记录 prompt 全文、API key、Authorization header 或用户上传二进制。
- 管理写操作写入 audit log。

## 17. 完整 Node 能力迁移矩阵

Luna 必须建立机器可读 parity manifest，不能靠手工记忆判断是否迁完。

| 能力组 | Python 参考能力 | Node 最终实现 | 切换 Gate |
| --- | --- | --- | --- |
| Chat | REST、NDJSON、WS | RunService + transports | contract + E2E |
| Preset Model | list/manage/invoke/stream | Registry + Compiler + APIs | migration + E2E |
| Session | history/delete/search mode/checkpoint | Session Module | fixture parity |
| Context | prompt/memory/skills/MCP | fixed model compiler + debug API | UI parity |
| Tools | core/web/browser/MCP | Node plugins | real tool runs |
| Provider | model config/credits/stream/tools | ProviderGateway | conformance profiles |
| Browser | handshake/tool bridge | Node WebSocket plugin | browser E2E |
| Buddy | connect/state/events/actions | optional external Node plugin; Host core has no Buddy routes | plugin/hardware Gate only if retained |
| Audio | STT/TTS/voice chat | deprecated by default; optional external plugin | product decision + sample parity |
| Vision | status/frame/analyze/follow | deprecated by default; optional external plugin | product decision + camera Gate |
| Artifacts | secure download | optional Node plugin | plugin path/security tests |
| Management | model/plugin/provider/usage | Node admin APIs | admin UI E2E |
| Static Web | assets/fonts/SPA fallback | Fastify static | production build smoke |

每项 manifest 包含：

```ts
type ParityEntry = {
  id: string;
  legacyRoutes: string[];
  nodeRoutes: string[];
  contractTests: string[];
  frontendTests: string[];
  realEnvironmentGate?: string;
  status: "missing" | "partial" | "parity";
};
```

存在 `missing` 或 `partial` 时，默认 runtime 不得改为 Node。

## 18. Python 移除策略

### 18.1 Preset agent 数据迁移

旧 Python preset agent 映射到 Preset Model version 1：

| 旧字段 | 新字段 |
| --- | --- |
| `name` | `metadata.name` |
| `description` | `metadata.description` |
| `system_prompt` | `spec.prompt.system` |
| `model` | `spec.provider.model` |
| `temperature` | `spec.provider.parameters.temperature` |
| `tool_names` | 对应固定 plugin bindings + tool policy |
| `bootstrap_tools` | plugin bootstrap declarations |
| `search_mode` | Web plugin config |
| response format | model policy |

迁移 CLI 必须支持 dry-run、hash、逐行错误、幂等和备份。迁移后旧 preset agent 表只读一个发布周期。

现有默认 AnomaloHaris Agent 的 prompt profile、默认 Provider Model、Core/Web 工具和运行 policy 必须先生成内建 `anomalo@1`。旧 `/api/chat` 的行为契约以该版本作为迁移基线，而不是继续保留一个 Registry 之外的特殊默认 runtime。

### 18.2 动态 Skill/MCP 迁移

旧 session 动态激活的 Skill/MCP 不能继续成为已发布 Preset Model 的可变能力。

- 常用组合迁移为独立 Preset Model version。
- Skill 转为 resource/plugin。
- MCP server 转为固定 MCP plugin binding。
- 旧 Python Session 不迁移，也不作为 Node 运行时的回放输入；Node 部署以新的 Session 数据库开始。新建的 Node Session 仍必须固定绑定 Model Ref。

### 18.3 Python-only 能力

对每项能力只能选择以下最终路径之一：

1. TypeScript/Node 原生实现。
2. 调用稳定的本地原生可执行文件协议。
3. 调用独立部署的外部服务 API。
4. 明确移除产品能力，并得到产品决策；不能静默丢失。

禁止最终路径：

- Node Host 自动启动 `python -m ...`。
- Node 插件 import Python 应用代码。
- 通过 loopback Python Worker 保留主要功能。
- 出错后把整个 run 转交旧 Python Host。

### 18.4 最终删除

完成切换后：

- 删除 Python Host 启动器和 runtime switch。
- 生产 Dockerfile 移除 Python runtime、uv、pyproject 和 Python app COPY。
- 删除 Node 对 Python Worker 的默认 Adapter 和环境变量。
- 保留必要的数据迁移脚本快照，但不进入生产运行路径。
- 回滚方式变为回滚到上一版 Node 镜像和数据库备份，而不是切回 Python。

## 19. 分阶段实施计划

### Phase 0：重新冻结替换标准

编码内容：

- 新增本文和取代旧架构的 ADR。
- 生成 Python 全路由/能力 parity manifest。
- 记录当前 Node 真实失败 fixtures：DSML 未执行、UI unknown model、缺失 API。
- 为旧 Python 的关键前端流程建立 Playwright/E2E baseline。

退出条件：

- parity manifest 覆盖所有 Python router 和前端 fetch 路径。
- 失败 fixture 能稳定重现，测试当前先红。
- 团队不再把“Node 可启动”视为迁移完成。

### Phase 1：修复共享契约和 Provider Gateway

编码内容：

- 提取 `provider-gateway` Module。
- 实现 OpenAI structured 和 DSML incremental parser。
- 规范 usage、finish reason、reasoning 和错误。
- 修复 `llm.request` contract 和前端投影。
- UI 对缺失字段和 404 显示错误。

退出条件：

- recorded fixture 和 chunk fuzz tests 全绿。
- 真实 OpenRouter + DeepSeek 可以调用 `web_search`。
- UI 显示正确 Provider Model、prompt/tool counts 和工具 timeline。
- 最终回答不包含 DSML markup。

### Phase 2：Preset Model Registry 和 Compiler

编码内容：

- Definition contracts、SQLite schema 和 repositories。
- draft/validate/publish/retire 生命周期。
- prompt/plugin/provider/policy 编译与 hash。
- `name@version` 解析和 Session binding。
- 从现有默认 Agent 配置生成内建 `anomalo@1`，并实现 `ANOMALO_DEFAULT_PRESET_MODEL`。
- 旧 preset agent migration dry-run。

退出条件：

- published version 不可变。
- Definition 任一运行字段变化都要求新版本。
- 相同 `name@version` 重启后 compiled hash 一致。
- 旧 `/api/chat` 和显式调用 `anomalo@1` 产生相同规范事件序列。
- migration fixture 无数据丢失且幂等。

### Phase 3：固定组合的 Pi-like PluginHost

编码内容：

- 插件 manifest、catalog、allowlist 和 package hash。
- L1–L3 lifecycle。
- child-process runner、权限、timeout、熔断。
- 把 Core、Web、MCP、Browser 迁为 Node plugins。
- ModelCompiler 固定插件图并生成 tool catalog。

退出条件：

- 至少两个真实插件 package 通过完整调用，而非内存 fixture。
- 调用方无法添加未绑定工具。
- package/hash 漂移会阻止模型调用。
- required 插件失败时模型明确 unavailable。

### Phase 4：算力中心 API

编码内容：

- `/v1/models`、`/v1/chat/completions` 和 SSE。
- Native Preset Model/run APIs。
- service client auth、scope、idempotency、concurrency。
- usage/cost/audit repositories 和管理查询。

退出条件：

- 官方 OpenAI Node SDK 可以通过 AnomaloHaris base URL 调用 Preset Model。
- 两个独立 fixture Agent 服务使用不同 service token 调用。
- stream/non-stream 输出一致。
- usage 与 Provider response 对账。

### Phase 5：完整 Node API 和硬件能力等价

编码内容：

- 完成 parity manifest 中仍属于核心产品范围的 API。
- 为可选能力增加版本化 Plugin Manifest、capability metadata 和隔离边界；Buddy 的 serial/TCP 实现放在独立插件，不进入 Node Host。
- 音频、视觉和重型 artifact 能力默认不内置；保留外部插件接入协议，已废弃能力不为兼容而重新实现。
- 完整 Browser Operator handshake。
- Provider credits、管理、prompt debug 和静态资源。

退出条件：

- 核心 parity manifest 全部为 `parity`；可选/废弃能力必须明确标记为 `optional-plugin` 或 `deprecated`，不能伪装成 Host 已完成。
- 如果启用 Buddy、audio 或 vision，再由对应插件单独通过人工 Gate；Node Host 本身不因这些硬件/媒体能力阻塞发布。
- Node-only 生产构建完成全部旧前端流程。
- 无请求代理到 Python。

### Phase 6：前端迁移到 Preset Model

编码内容：

- Preset Agents UI 改名并迁移为 Preset Models。
- 版本列表、草稿、校验、发布、retire 和 diff UI。
- 测试控制台调用明确 `name@version`。
- 工具、plugin、context、usage 和错误状态可视化。
- 移除前端对旧 `/api/agents` 和动态 Skill/MCP 的依赖。

退出条件：

- 浏览器网络面板无意外 404/500。
- UI 不出现无来源的 `unknown model` 或错误的 `0 tools`。
- 当前信息检索 E2E 显示真实工具调用与来源。
- 所有 UI 请求通过共享 contracts 验证。

### Phase 7：Node-only 切换与 Python 退役

编码内容：

- Node 生产镜像不包含 Python。
- 通过显式 CLI 迁移旧 Preset Agent 为 Preset Model；旧 Session 数据不迁移，Node Session 数据库以空 schema 初始化。
- 执行备份、dry-run、Node smoke、观察和回滚演练。
- 删除 Python Host/Worker 启动路径和 runtime switch。
- 更新 README、部署脚本、ADR 和运维手册。

退出条件：

- 生产进程树无 Python。
- 无旧 Host 独占能力。
- Node 连续通过目标观察期。
- 回滚到上一版 Node 镜像演练通过。
- 完成定义第 23 节全部满足。

## 20. 建议 PR 切片

每个 PR 必须可独立审查和回滚，禁止把 Provider 协议修复、数据迁移、硬件重写和默认切换放进同一个 PR。

1. `docs: define node-only preset model compute center`
2. `test: add runtime parity manifest and failing node acceptance fixtures`
3. `refactor: extract provider gateway interface`
4. `fix: normalize dsml and structured tool call streams`
5. `fix: align llm request events with frontend contracts`
6. `feat: add preset model definition contracts and storage`
7. `feat: compile immutable preset model versions`
8. `feat: migrate legacy preset agents to preset models`
9. `feat: add version-locked pi plugin catalog`
10. `feat: run preset model plugins in isolated node children`
11. `refactor: package core web mcp and browser as node plugins`
12. `feat: expose openai-compatible preset model api`
13. `feat: add service client auth idempotency and usage tracking`
14. `feat: complete node compatibility routes`
15. `feat: migrate buddy audio vision and artifact capabilities to node`
16. `feat: migrate web ui to versioned preset models`
17. `test: add node-only real environment acceptance suite`
18. `chore: remove python runtime from production image`
19. `chore: make node host the only runtime`

每个 PR 描述必须包含：

- 修改的 Module interface 和不变量。
- 对 parity manifest 的影响。
- fixture、unit、integration、E2E 和 real-environment 测试。
- schema/data 变化和回滚方式。
- 是否触及 Provider cost、硬件或外部 service token。

## 21. 测试策略

### 21.1 单元和契约

- Definition 和所有 API schema 的 valid/invalid fixtures。
- ModelCompiler determinism、hash、duplicate tools、permission failures。
- Provider streaming chunk fuzz。
- Plugin hook 顺序、timeout、Abort、熔断。
- AgentCore stop/resume/finalizer。
- Session model binding 和幂等。
- usage aggregation 和 cost precision。

### 21.2 集成

- Fastify inject 覆盖每个 route。
- SQLite 与 InMemory Adapter 运行同一 repository suite。
- Plugin child IPC 断连和重启。
- Browser WebSocket handshake 和 tool result correlation。
- OpenAI SDK against local Host。

### 21.3 前端 E2E

必须覆盖：

1. 创建 draft Preset Model。
2. 选择 prompt、Provider 和 plugins。
3. validate、真实 smoke、publish。
4. 新会话选择明确版本。
5. 发送需要联网的问题。
6. UI 显示正确 model、prompt/tool counts。
7. UI 展示 web tool started/finished 和来源。
8. stop/resume。
9. 查看 usage。
10. retire 后已有 Node Session 可继续读取，新 Session 不可创建。

### 21.4 真实环境 Gate

真实测试使用 `.env`，但不得输出 secret。至少包括：

- OpenRouter 当前默认 Provider Model。
- 一个标准 structured tool-call model。
- Web search/fetch。
- Browser bridge。
- Buddy/audio/vision 在有硬件环境下的人工 Gate。
- 生产构建静态前端。

真实测试必须最小化费用，并通过显式环境开关执行：

```text
ANOMALO_REAL_PROVIDER_TESTS=true
ANOMALO_HARDWARE_TESTS=true
```

CI 默认使用 recorded fixtures；发布前必须保存真实 Gate 的时间、Provider Model、Model Ref、run id 和结果摘要。

## 22. 发布与回滚

### 22.1 切换前

1. parity manifest 全绿。
2. 备份 Session 和 Preset Model 数据库。
3. 运行迁移 dry-run 并保存 hash report。
4. 构建无 Python 的生产镜像。
5. 用真实 `name@version` 完成 API、UI、tool 和 hardware smoke。
6. 用两个 fixture Compute Clients 完成调用。
7. 执行数据库恢复和上一版 Node 镜像回滚演练。

### 22.2 切换

- 停止旧 Host 接收新 Run。
- 等待 active Run 完成或保存 checkpoint。
- 迁移并校验数据。
- 启动 Node-only Host。
- 验证 `/health`、`/v1/models`、真实 chat、真实 tool、UI 和 usage。
- 观察 error、latency、provider protocol、plugin fuse 和 hardware metrics。

### 22.3 回滚

最终回滚目标是上一版稳定 Node 镜像。迁移窗口内 MAY 临时保留 Python 发布镜像，但不能继续写入完成最终迁移后的新 schema。回滚前必须停止 active Run 并恢复匹配版本的数据库备份，禁止通过删除新表或强制修改 schema 回滚。

## 23. 完成定义

只有同时满足以下条件，才能宣布“完全使用 Node.js 类 Pi 架构替换 Python 后端”：

- Node Host 是唯一 HTTP、SSE/NDJSON、WebSocket 和 Agent Run 所有者。
- Preset Model 以不可变 `name@version` 发布和调用。
- 默认 AnomaloHaris Agent 作为明确版本的内建 Preset Model 运行；不存在 Registry 外的特殊 Agent runtime。
- 外部 Agent 服务可通过 OpenAI SDK 和 Native API 调用。
- Provider Gateway 支持真实生产 Provider 的工具调用协议。
- 当前信息问题会实际调用 Web 工具，而不是输出工具 markup 或凭记忆回答。
- UI 显示正确 Preset Model、Provider Model、prompt、tool 和 run metadata。
- 核心 parity manifest 没有 `missing` 或 `partial`；可选插件/废弃项使用明确的 `optional-plugin`/`deprecated` 状态。
- Chat、Preset Model、Session、Browser、MCP、artifact（若启用）和管理能力均在 Node 实现；Buddy、audio、vision 不得被误称为 Node Host 内置能力。
- production image 和 process tree 不含 Python。
- 没有 Node-to-Python Host/Worker fallback。
- 旧 Preset Agent 到 Preset Model 的迁移幂等、可审计；旧 Session 数据明确不迁移，不能作为完成条件。
- Plugin package/version/hash 固定，权限和失败可观测。
- usage、cost、latency 和错误按 client、Model Ref、Provider 聚合。
- 真实 Provider、浏览器、外部 Compute Client 和硬件 Gate 已通过。
- Node-to-Node 回滚演练通过。
- README、ADR、部署和运维文档与实际默认行为一致。

## 24. Luna 禁止采用的捷径

- 不得因为 `/health` 返回 `runtime=node` 就宣称替换完成。
- 不得因为 `/api/tools` 能列出工具就宣称工具调用完成。
- 不得只支持 `delta.tool_calls` 而忽略实际 Provider 的 encoded protocol。
- 不得把 DSML/XML/JSON tool markup 作为 assistant 文本发送。
- 不得让 UI 把 contract 错误降级成 `0 tools` 或 `unknown model`。
- 不得用 Node route 代理旧 Python route 来通过 parity Gate。
- 不得让外部调用者改变已发布 Preset Model 的 prompt 或插件。
- 不得允许 published version 原地更新。
- 不得在运行时自动安装插件或使用未锁定 package。
- 不得把 Python Worker 改名后保留为最终架构。
- 不得在没有真实 Provider 和真实 UI 验证时切换默认 Host。

本文的优先级高于旧 Node/Python Worker 迁移设计。旧代码可以复用，但所有复用都必须满足本文的 Node-only、Preset Model 不可变版本和真实替换 Gate。
