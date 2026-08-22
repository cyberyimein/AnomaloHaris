# Anomalo Node.js 驱动与 Pi 兼容运行时开发设计

> 状态：Superseded by `docs/design/node-preset-model-compute-center.md`
>
> 面向读者：负责后续编码、测试、迁移和部署的实现模型
>
> 设计目标：在保持 Anomalo 现有产品行为的前提下，以 Node.js/TypeScript 作为 Host，深化 Agent 循环 Module，并逐步兼容 Pi 扩展生态
>
> 本文中的 MUST、SHOULD、MAY 分别表示必须满足、默认应满足、可以延后实现

> [!IMPORTANT]
> 本文保留为阶段迁移历史和已实现 Seam 的参考。最终产品目标已由
> `docs/design/node-preset-model-compute-center.md` 取代：生产架构必须是
> Node-only，Preset Model 使用不可变的 `name@version`，Python Worker 不再是
> 完成态组件。

## 1. 决策摘要

Anomalo 的目标架构采用“Node.js/TypeScript Host + 深 Agent Module + Python Worker + Pi 兼容 Adapter”。

三项核心决策如下：

1. Node.js/TypeScript 负责主要 Host：HTTP、WebSocket、Agent 编排、Session、工具调度、插件加载和前端静态资源。
2. 先深化 Agent 循环 Module，再迁移语言。禁止把当前 Python `AgentRuntime` 逐行翻译成 TypeScript。
3. Pi 兼容分级实现。第一目标是资源、工具和生命周期兼容，不以完整复制 Pi TUI、主题和交互 UI 为目标。

Python 不会立即退出系统。STT、TTS、视觉、硬件依赖和 FruitSpy 集成继续运行在 Python Worker 中，通过明确的 Interface 与 Node Host 协作。

推荐迁移顺序：

```text
冻结行为契约
    ↓
在 Python 内深化 Agent Module
    ↓
建立共享 JSON/TypeScript 契约
    ↓
实现 TypeScript AgentCore 和 Session Module
    ↓
Node Host 接管 HTTP/WebSocket
    ↓
迁移 Buddy/MCP/Web 等 Adapter
    ↓
分级启用 Pi PluginHost
    ↓
移除旧 Python Host
```

## 2. 背景与现状约束

当前系统具有以下不可忽略的事实：

- Vue 前端依赖 `run.*`、`message.*`、`tool.*` 事件驱动投影。
- Python `AgentRuntime` 同时包含上下文组装、模型循环、工具调用、暂停恢复、结构化 finalizer、超时和错误处理。
- Session 当前以 SQLite 单行 JSON 数组保存消息、激活资源、Web trace 和单个 checkpoint。
- `ToolProvider` 已经形成真实 Seam：Core、Web、Browser、Buddy、Python、Skill、MCP 等多个 Adapter 使用它。
- Buddy 的领域定位是“具身桌面 Interface”，主 Agent 运行时属于 Host；固件只负责显示、动画、舵机、触摸和 Call Buddy 协议。
- 音频、视觉和部分硬件依赖明显偏向 Python 生态。
- 当前远程部署没有完整的终端用户认证，插件和 MCP 又可能执行本地代码。

迁移期间必须保持以下产品能力：

- `POST /api/chat`
- `POST /api/chat/stream`
- `WS /ws/chat/{session_id}`
- 普通会话与 preset agent 会话
- Browser Operator 握手和浏览器工具桥
- Stop/Resume 和 checkpoint
- `text`、`json_object`、`json_schema` 输出
- Skill、MCP、Web、Buddy、Python sandbox 工具
- Dashboard、音频、视觉和 Buddy 相关 HTTP Interface
- `/data` 持久化目录语义

## 3. 目标与非目标

### 3.1 目标

- 用 TypeScript 统一 Host 与前端的核心类型和构建工具链。
- 让 Agent 循环成为 Deep Module：调用者通过很小的 Interface 获得完整运行、工具、恢复和事件能力。
- 让 Session、模型、工具、插件和 Python Worker 在明确 Seam 上变化。
- 保持现有前端无需一次性重写。
- 为 Pi 扩展建立可测试、可声明、可降级的兼容层。
- 支持逐阶段上线、数据迁移和一键回退到旧 Python Host。
- 保持 Buddy 领域职责：Host 拥有智能和运行生命周期，设备只投影状态并提供输入输出。

### 3.2 非目标

- 第一阶段不重写 STT、TTS、视觉模型或 FruitSpy。
- 第一阶段不复制 Pi 的 TUI、主题、自定义渲染和 `ctx.ui`。
- 第一阶段不提供“不可信 Node 插件安全沙箱”的承诺。
- 第一阶段不改变现有工具顺序、最大迭代次数、恢复语义或结构化输出语义。
- 不允许 Python Host 与 Node Host 同时执行同一个真实 run。
- 不为了形式上的微包化而创建大量 Shallow Module。

## 4. 统一术语

### 4.1 领域术语

| 术语 | 定义 |
| --- | --- |
| Host | 拥有 HTTP/WebSocket、Agent 编排、LLM、工具、审批和 Session 生命周期的主进程 |
| Agent Run | 一次从用户输入或 resume 开始，到 finished、stopped 或 error 结束的执行 |
| Agent Session | 持久化的消息树、资源激活状态、run 记录和当前活动叶节点 |
| Tool | 模型可选择调用的能力 |
| Bootstrap Tool | 首次模型请求前由 Host 主动执行并注入权威上下文的受限工具 |
| Plugin | 在受信任配置下注册工具、命令或生命周期 hook 的 TypeScript 扩展 |
| Python Worker | 提供 Python 生态能力的独立进程，不拥有主 Session 生命周期 |
| Buddy Adapter | 把 Host 状态和动作映射到 Call Buddy 协议的 Adapter |

### 4.2 架构术语

- **Module**：有 Interface 和 Implementation 的代码单元。
- **Interface**：调用者正确使用 Module 必须知道的全部内容，包括类型、顺序、不变量和错误模式。
- **Implementation**：Module 内部代码。
- **Depth**：一个小 Interface 隐藏多少行为并提供多少 Leverage。
- **Seam**：允许替换行为而不编辑调用方的位置。
- **Adapter**：满足某个 Seam 上 Interface 的具体实现。
- **Leverage**：调用者从 Deep Module 获得的能力。
- **Locality**：变化、错误和验证集中在一个位置的程度。

## 5. 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Vue Web                                                     │
│  - 使用 @anomalo/contracts                                 │
│  - 保持现有事件投影                                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP / NDJSON / WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│ Node.js / TypeScript Host                                   │
│  Fastify · Auth · Routes · Static Assets · Preset Agents    │
│                                                             │
│  ┌───────────────┐       ┌───────────────────────────────┐  │
│  │ RunController │──────▶│ AgentCore                     │  │
│  └───────┬───────┘       │ loop · finalizer · checkpoint │  │
│          │               └──────┬──────────┬─────────────┘  │
│          │                      │          │                │
│  ┌───────▼────────┐   ┌────────▼─────┐ ┌──▼─────────────┐  │
│  │ Session Module │   │ ToolRuntime   │ │ ContextBuilder │  │
│  └───────┬────────┘   └────────┬─────┘ └──┬─────────────┘  │
│          │                     │           │                │
│  ┌───────▼────────┐   ┌────────▼───────────▼─────────────┐  │
│  │ SQLite Adapter │   │ PluginHost / Pi Compatibility    │  │
│  └────────────────┘   └──────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ Internal HTTP / IPC
┌──────────────────────────▼──────────────────────────────────┐
│ Python Worker                                               │
│ STT · TTS · Vision · Buddy transitional bridge · FruitSpy   │
└─────────────────────────────────────────────────────────────┘
```

依赖方向必须保持单向：

```text
Host → RunController → AgentCore
AgentCore → Model Interface / ToolRuntime / ContextBuilder / Session Interface
PluginHost → ToolRuntime 注册入口和生命周期 hook
Adapter → 外部 SDK、SQLite、MCP、Buddy、Python Worker
```

禁止 `AgentCore` import Fastify、Vue、SQLite driver、OpenAI SDK、Buddy 或 Python Worker 实现。

## 6. 推荐仓库布局

采用 npm workspaces，保留现有根目录 Python `pyproject.toml`，迁移完成前形成双工具链仓库。

```text
Anomalo/
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── apps/
│   ├── host/                       # Node Host 入口、Fastify、生命周期
│   └── web/                        # 从 frontend/ 迁移而来，迁移期可保持原路径
├── packages/
│   ├── contracts/                  # JSON Schema、TypeBox 类型、事件与错误码
│   ├── agent-core/                 # AgentCore 与 internal state machine
│   ├── run-controller/             # 并发、AbortSignal、stop、timeout
│   ├── session/                    # Session 深 Module
│   ├── context/                    # ContextBuilder 深 Module
│   ├── tools/                      # ToolRuntime 与 Tool Interface
│   ├── plugin-host/                # Anomalo plugin lifecycle
│   ├── pi-compat/                  # Pi Extension/Package Adapter
│   ├── preset-agents/              # preset 定义、绑定和 bootstrap policy
│   └── adapters/
│       ├── openai-compatible/
│       ├── sqlite/
│       ├── mcp/
│       ├── browser/
│       ├── buddy/
│       └── python-worker/
├── python-workers/                 # 从现有 Python Host 逐步迁移出的能力
├── agent-backend/                  # 迁移期旧 Host；最终只保留必要 Worker 代码
├── buddy-backend/
├── frontend/                       # 迁移期保留
└── docs/
```

约束：

- `packages/contracts` MUST 不依赖任何 Host 或 Adapter。
- `packages/agent-core` MUST 不依赖 Fastify 和具体存储。
- `packages/adapters/*` MAY 依赖外部 SDK，但其他 Module 不得绕过 Seam 直接 import SDK。
- 同一个概念只允许一个规范类型来源，禁止 Host、前端和测试分别定义事件类型。
- 在迁移完成前，不强制移动 `frontend/`；先让它消费共享 contracts，再决定目录调整。

## 7. 技术栈默认选择

| 领域 | 默认选择 | 原因 |
| --- | --- | --- |
| Node | Node.js 22 LTS 或项目部署时更新的 LTS | 与现有前端构建兼容 |
| 包管理 | npm workspaces | 复用现有 npm 使用方式和 lockfile 习惯 |
| 语言 | TypeScript strict mode | 共享 Host/前端/插件类型 |
| HTTP Host | Fastify | 生命周期清晰、吞吐稳定、Schema 集成成熟 |
| Schema | TypeBox + Ajv | 与 Pi 扩展工具 schema 方向相近，可产生 JSON Schema |
| LLM | 官方 `openai` npm package | 继续支持 OpenAI-compatible base URL 和 OpenRouter |
| SQLite | `better-sqlite3`，隐藏在 SQLite Adapter 后 | 事务和迁移简单；调用者不感知 driver |
| 测试 | Vitest | 与前端统一，支持 TypeScript 和 fake timers |
| 日志 | Pino | Fastify 原生日志生态和结构化字段 |

如果实现模型替换某个库，MUST 保持本文定义的 Interface、不变量、错误码和迁移能力。

## 8. 核心 Module 设计

### 8.1 `@anomalo/contracts`

这是所有进程和前端共享的规范 Interface。它提供：

- 标识符品牌类型：`SessionId`、`RunId`、`ToolCallId`、`EntryId`。
- `AgentEvent` discriminated union。
- WebSocket 客户端消息类型。
- Tool schema、Tool call、Tool result。
- Run request、response format、错误码。
- Python Worker JSON 消息 schema。
- Session snapshot 和迁移 schema version。

所有网络输入 MUST 在 Host 入口通过 Ajv 验证。TypeScript 类型不能替代运行时验证。

建议事件信封：

```ts
type AgentEvent<TType extends string, TData> = {
  schema_version: 1;
  type: TType;
  session_id: SessionId;
  run_id: RunId;
  data: TData;
  timestamp: string;
};
```

迁移兼容要求：

- 前端 MUST 接受没有 `schema_version` 的旧 Python 事件。
- Node Host MUST 发送 `schema_version: 1`。
- 现有 `type`、`session_id`、`run_id`、`data`、`timestamp` 字段语义不得改变。
- 新增字段只能是向后兼容的可选字段，破坏性变化必须提升 `schema_version`。

### 8.2 `RunController` Module

Host 只通过 `RunController` 控制 Agent Run。推荐 Interface：

```ts
interface RunController {
  start(request: StartRunRequest): AsyncIterable<AgentEvent>;
  stop(sessionId: SessionId, reason: StopReason): Promise<StopResult>;
  status(sessionId: SessionId): RunStatus;
  hasCheckpoint(sessionId: SessionId): Promise<boolean>;
}
```

Interface 不变量：

- 每个 Session 同时最多一个 active run。
- `start` 在接受请求后首先产生 `run.started`，验证失败除外。
- 每个已开始 run 恰好产生一个终止事件：`run.finished`、`run.stopped` 或 `run.error`。
- `stop` 必须幂等；重复 stop 不得制造第二个终止事件。
- WebSocket 断开使用 `reason=disconnect`，用户停止使用 `reason=user_stop`。
- timeout 通过同一个 AbortSignal 路径中断模型、工具和插件 hook。
- active run 只保存在进程内；可恢复状态必须先持久化再发送 `can_resume=true`。

错误模式：

- active run 冲突：`run_already_active`
- 空消息：`message_required`
- 无 checkpoint resume：`checkpoint_not_found`
- paused session 接收新消息：`checkpoint_resume_required`
- stop 时没有 active run：Host 返回 `client.error/no_active_run`

### 8.3 `AgentCore` Module

`AgentCore` 隐藏模型循环、工具轮次、消息修复、finalizer 和 checkpoint 决策。它不拥有 WebSocket，也不直接管理多个并发 Session。

推荐内部 Interface：

```ts
interface AgentCore {
  execute(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
```

构造依赖：

```ts
type AgentCoreDependencies = {
  model: ModelAdapter;
  tools: ToolRuntime;
  sessions: SessionRepository;
  context: ContextBuilder;
  plugins: PluginHost;
  ids: IdFactory;
  clock: Clock;
  policy: AgentPolicy;
};
```

`AgentPolicy` 至少包含：

```ts
type AgentPolicy = {
  maxToolIterations: number;
  runTimeoutMs: number;
  bootstrapToolTimeoutMs: number;
  structuredOutputRetryCount: 1;
  toolExecution: "sequential";
};
```

第一版 MUST 使用顺序工具执行，与当前 Python 行为一致。Bootstrap tools 保持并行执行，但每个调用有独立 timeout，结果按定义顺序写入上下文。

### 8.4 Agent Run 状态机

```text
validating
    ├─ invalid ───────────────────────────────▶ error
    ▼
preparing
    ├─ abort ────────────────────────────────▶ checkpointing ▶ stopped
    ▼
streaming_model ◀────────────────────────────────────┐
    ├─ text complete ─▶ finalizing? ─▶ persisting ─▶ finished
    ├─ tool calls ────▶ executing_tools ─────────────┘
    ├─ timeout ───────▶ checkpointing ──────────────▶ error(can_resume)
    ├─ abort ─────────▶ checkpointing ──────────────▶ stopped
    └─ failure ───────▶ checkpointing when safe ────▶ error
```

状态机不变量：

- `iteration` 在每次模型请求前加一。
- 最大工具轮次语义与当前测试一致：达到上限后产生 `Maximum tool iterations reached.` 对应的稳定错误码。
- 模型返回 tool calls 时，先持久化 assistant tool-call message，再执行工具。
- 工具调用开始后必须最终得到对应 tool result；被 stop/timeout 打断时写入带 `[recovery]` 标记的合成结果。
- 只有 `run.finished` 才把 run 标记为 completed 并清理 resume checkpoint。
- resume 失败时原 checkpoint 仍可再次使用。
- resume 不得改变保存的 `response_format`。

### 8.5 `ContextBuilder` Module

`ContextBuilder` 是一个 Deep Module，而不是一组公开的小函数。调用者只提供 `ContextRequest`，Implementation 负责稳定排序、资源加载、过滤和诊断元数据。

推荐 Interface：

```ts
interface ContextBuilder {
  build(request: ContextRequest): Promise<BuiltContext>;
}

type BuiltContext = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  diagnostics: {
    segmentCounts: Record<string, number>;
    totalMessageCount: number;
    toolCount: number;
  };
};
```

消息顺序 MUST 固定为：

1. prompt profile 或 preset system prompt
2. search mode instruction
3. bootstrap context
4. AGENTS.md memory
5. Skill catalog
6. active Skill instructions
7. MCP catalog
8. active MCP instructions
9. Session history
10. 当前 user/resume message
11. 当前 run 的 loop messages

插件生命周期允许在明确阶段修改上下文，但修改后必须再次通过 schema 验证和 tool-name 去重。

`ContextBuilder` MUST 产生可调试的 segment metadata，但默认日志不得记录敏感 prompt 全文。

### 8.6 `ModelAdapter` Seam

推荐 Interface：

```ts
interface ModelAdapter {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelCompletion>;
}
```

第一批 Adapter：

- `OpenAICompatibleAdapter`：OpenRouter、OpenAI-compatible endpoint。
- `ReplayModelAdapter`：契约测试和 Python/Node 行为重放。

模型流事件规范化为：

```ts
type ModelStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.calls"; calls: ToolCall[] }
  | { type: "done" };
```

SDK 特有对象不得越过该 Seam。Abort 后如 SDK 已产生部分文本或 tool calls，Adapter 必须通过标准化的 `ModelInterruptedError` 携带它们，供 AgentCore 保存 checkpoint。

### 8.7 `ToolRuntime` Module

保留并深化当前 `ToolProvider` 思路。推荐 Interface：

```ts
interface ToolRuntime {
  list(context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(context: ToolContext): Promise<ToolAdapterStatus[]>;
}
```

工具规则：

- 工具名满足 `^[a-zA-Z0-9_-]{1,64}$`。
- 重名按显式优先级处理；禁止依赖注册顺序静默覆盖。
- 默认优先级建议：Host core > preset override > trusted plugin > Skill > MCP。
- 重名且优先级相同视为启动错误。
- `ToolResult` 始终包含 `name`、`ok`、`content`、`data`。
- Adapter 抛出的异常在 ToolRuntime 集中转换为 `ok=false`，AgentCore 不理解 SDK 异常。
- `allowed_tool_names` 在 ContextBuilder 输出工具列表前过滤，在调用时再次校验，防止插件绕过。
- tool call 通过 `tool_call_id` 幂等关联；外部有副作用的 Adapter SHOULD 支持幂等键。

首批 TypeScript Adapter：

- Core time/tool utilities
- Web search/fetch
- Browser bridge
- MCP
- Buddy Gateway，或先通过 Python Worker 转接
- Skill tool Adapter
- Pi extension tool Adapter
- Python sandbox Adapter

### 8.8 `Session` Module

Session Module 的 Interface 必须隐藏 SQLite 表和 JSON 序列化细节。

推荐 Interface：

```ts
interface SessionRepository {
  open(sessionId: SessionId): Promise<SessionSnapshot>;
  append(entries: NewSessionEntry[]): Promise<void>;
  setActiveLeaf(sessionId: SessionId, entryId: EntryId): Promise<void>;
  beginRun(record: NewRunRecord): Promise<void>;
  checkpoint(record: RunCheckpoint): Promise<void>;
  finishRun(record: FinishedRunRecord): Promise<void>;
  failRun(record: FailedRunRecord): Promise<void>;
  resume(runId: RunId): Promise<ResumableRun>;
  list(query: SessionListQuery): Promise<SessionSummary[]>;
}
```

第一批 Adapter：

- `SqliteSessionAdapter`
- `InMemorySessionAdapter`，仅用于测试

Session Module 提供以下 Leverage：

- 事务化 append/checkpoint/terminal 状态。
- 从活动叶节点重建模型消息链。
- 为未来 branch/fork/compaction 保留树结构。
- 旧数据懒迁移。
- 统一 title、message count、resume status 计算。

### 8.9 结构化 Finalizer

结构化输出是 `AgentCore` 的内部能力，不单独暴露给 Host。

保持以下语义：

- 工具循环仍以普通 streamed 模型请求运行。
- finalizer 使用无工具的非流式请求。
- finalizer 输入只包含 finalizer system prompt、原始用户目标、研究草稿和格式要求，不包含原始 tool messages。
- JSON Schema 在 Host 入口验证一次，在 finalizer 输出后验证一次。
- 第一次验证失败后重试一次。
- finalizer SDK 失败保存 `reason=finalizer_error` 的可恢复 checkpoint。
- 最终只向客户端流出验证通过的结构化文本。

## 9. 事件契约

### 9.1 必须支持的 Agent 事件

| 事件 | 必需数据 | 顺序约束 |
| --- | --- | --- |
| `run.started` | `resumed`, `search_mode`, `model` | 每个成功启动的 run 第一个事件 |
| `llm.request` | `profile`, `iteration`, `phase`, `context` | 每次模型请求前；完整 request 仅 debug 模式提供 |
| `message.delta` | `content` | 零到多个 |
| `message.done` | 无 | 普通完成时位于最后一个 delta 之后 |
| `tool.started` | `tool_call_id`, `tool`, `arguments`, optional `phase` | 每个工具调用一次 |
| `tool.finished` | `tool_call_id`, `tool`, `ok=true`, `content`, `data` | 与 started 一一对应 |
| `tool.error` | `tool_call_id`, `tool`, `ok=false`, `content`, `data` | 与 started 一一对应 |
| `run.finished` | `final_text`, optional `output`, `output_format` | 唯一终止事件 |
| `run.stopped` | `reason`, `checkpointed`, `can_resume` | 唯一终止事件 |
| `run.error` | `error`, `error_code`, `can_resume` | 唯一终止事件 |

Browser bridge 的 `browser.tool.call` 和 `browser.tool.result` 保持 Host 级协议，不进入通用模型事件联合类型，避免 AgentCore 依赖浏览器实现。

### 9.2 错误码

实现时建立枚举，禁止依赖英文错误文本判断逻辑。至少包括：

```text
message_required
run_already_active
checkpoint_not_found
checkpoint_resume_required
response_format_mismatch
invalid_response_format
invalid_search_mode
run_timeout
max_tool_iterations
bootstrap_failed
model_failed
tool_failed
finalizer_failed
structured_output_invalid
plugin_failed
worker_unavailable
```

旧英文错误文本在兼容期保持不变；前端逐步迁移为使用 `error_code`。

### 9.3 WebSocket 客户端消息

继续支持：

```text
client.hello
user.message
run.stop
run.resume
browser.tool.result
ping
```

约束：

- `client.hello` 每条连接最多一次。
- preset/browser session 必须完成握手后才能启动 run。
- `run.stop` 不得直接关闭 WebSocket。
- `run.resume` 不得接受新用户内容。
- `browser.tool.result` 必须匹配 session、run 和 tool_call_id。

## 10. Session v2 数据设计

### 10.1 目标表

```sql
schema_migrations(
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)

agent_sessions(
  session_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  active_leaf_entry_id TEXT,
  search_mode TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

session_entries(
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_entry_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  role TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id),
  FOREIGN KEY(parent_entry_id) REFERENCES session_entries(entry_id)
)

runs(
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  start_entry_id TEXT,
  last_entry_id TEXT,
  config_json TEXT NOT NULL,
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id)
)

run_checkpoints(
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

session_resources(
  session_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY(session_id, resource_type, resource_name)
)

web_traces(
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

索引至少包括：

- `session_entries(session_id, created_at)`
- `session_entries(parent_entry_id)`
- `runs(session_id, started_at)`
- `runs(status)`
- `web_traces(session_id, created_at)`

### 10.2 消息树语义

- 每个 `session_entry` 通过 `parent_entry_id` 指向前一条活动记录。
- `sessions.active_leaf_entry_id` 决定当前主分支。
- 当前模型历史是从 active leaf 沿 parent 链回溯后反转的结果。
- fork 只是从任意 entry 创建新的 child，并更新 active leaf；不复制整段历史。
- 第一阶段 UI 不需要暴露 branch，但数据模型 MUST 支持未来增加。
- compaction summary 使用 `kind=compaction`，payload 保存被替代区间和摘要；原 entry 不删除。

### 10.3 checkpoint 内容

`state_json` 至少保存：

```ts
type CheckpointState = {
  promptProfile: string;
  originalUserContent: string;
  currentUserEntryId: EntryId;
  iteration: number;
  assistantText: string;
  pendingToolCalls: ToolCall[];
  completedToolCallIds: ToolCallId[];
  loopEntryIds: EntryId[];
  bootstrapContext: BootstrapContextEntry[];
  responseFormat?: ResponseFormat;
  model: string;
  temperature?: number;
  searchMode: SearchMode;
};
```

checkpoint 写入和 run 状态更新 MUST 在同一 SQLite 事务完成。

### 10.4 旧 Session 迁移

迁移策略采用“新表 + 懒迁移 + 保留旧表”，不就地覆盖旧行。

规则：

1. 启动时创建以 `agent_sessions` 为根的 v2 表，不删除旧 `sessions` 表。
2. 打开 Session 时，若 v2 不存在但旧行存在，则在一个事务中迁移。
3. 有 checkpoint 时，以 `checkpoint.messages` 作为活动消息链；无 checkpoint 时使用 `messages_json`。
4. 旧 `messages_json` 原值和 checkpoint 原值保存在迁移 metadata 中，便于审计和回退。
5. active skills/MCP 转换为 `session_resources`。
6. web traces 转换为 `web_traces`。
7. 旧 checkpoint 转换为 `runs(status='paused')` 和 `run_checkpoints`。
8. 迁移写入稳定的 `legacy_source_hash`；重复执行必须幂等。
9. 至少保留一个发布周期的旧表只读能力。
10. 提供离线 dry-run 命令，只报告数量、错误和校验 hash，不修改数据。

SQLite Adapter MUST 保持当前持久化挂载的安全假设：当数据库位于 `/data` 等容器挂载目录时使用 `PRAGMA journal_mode=DELETE`，避免依赖可能在镜像替换时丢失的 WAL sidecar。事务必须保持短小；大批量迁移由离线命令分批执行，不能长时间阻塞 Node event loop。

迁移校验：

- 活动消息链内容逐条相等。
- `can_resume` 相等。
- title、message count、search mode 相等。
- active skills/MCP 集合相等。
- structured checkpoint 的 `response_format` 相等。

## 11. PluginHost 与 Pi 兼容设计

### 11.1 兼容等级

| 等级 | 范围 | 首次交付 |
| --- | --- | --- |
| L1 Resource | `AGENTS.md`、`SKILL.md`、prompt、package metadata | MUST |
| L2 Tool | TypeBox/JSON Schema 工具注册、调用和结果 | MUST |
| L3 Lifecycle | 上下文 hook、工具拦截、run/session 生命周期 | SHOULD |
| L4 Session | branch、fork、compaction、自定义 entry | MAY |
| L5 UI/TUI | `ctx.ui`、主题、自定义渲染、TUI widgets | 非目标 |

兼容声明必须使用精确等级，例如 `pi-compat: L2`，禁止仅写“Pi compatible”。

### 11.2 PluginHost Interface

```ts
interface PluginHost {
  load(config: PluginLoadConfig): Promise<PluginLoadReport>;
  unload(pluginId: string): Promise<void>;
  tools(context: PluginContext): Promise<ToolDefinition[]>;
  dispatch<TEvent extends PluginEvent>(event: TEvent): Promise<PluginEventResult<TEvent>>;
  status(): PluginStatus[];
}
```

插件 hook 顺序：

1. Host 内建 policy
2. 全局受信插件，按配置顺序
3. 项目受信插件，按配置顺序
4. preset agent policy

安全 policy 拥有最终否决权。插件可以缩减能力，不能重新启用被 Host 禁止的工具。

### 11.3 Pi 生命周期映射

首批建议映射：

| Pi 概念 | Anomalo 事件或阶段 | 兼容行为 |
| --- | --- | --- |
| `session_start` | Session 首次打开 | 通知 |
| `before_agent_start` | ContextBuilder 构建前 | 可注入 system/context 数据 |
| `context` | 模型请求前 | 可修改规范化消息副本 |
| `tool_call` | ToolRuntime 调用前 | 可允许、修改或拒绝 |
| `tool_result` | ToolRuntime 返回后 | 可修改展示内容和 metadata |
| `turn_end` | 一次模型/工具轮次结束 | 通知 |
| `agent_end` | run terminal event 前 | 通知，不得取消终止 |
| `session_fork` | v2 fork | L4 才支持 |
| compaction hooks | compaction Module | L4 才支持 |

`registerTool` 在 L2 支持。`registerCommand` 在 L3 可映射到 Host command registry，但只允许本地或已授权调用。自定义 UI 和 TUI 渲染返回明确的 `unsupported_capability`，不得静默忽略。

### 11.4 插件发现与信任

- 默认不自动执行当前项目目录发现的 TypeScript 文件。
- 插件必须出现在受版本控制的配置或部署 allowlist 中。
- 配置必须记录 package/entry、版本约束、启用状态和权限。
- npm/git package 安装与运行分开；Host 运行时不得自动 `npm install`。
- 加载前生成 `PluginLoadReport`，列出识别的工具、hook、命令和不支持能力。
- 加载失败默认隔离该插件，不阻止 Host 启动；标记为 `required` 的插件除外。
- 插件 hook 必须有 timeout；连续失败达到阈值后熔断，并产生结构化日志。
- 插件不得直接获取 SQLite Adapter、Fastify 实例、原始环境变量对象或主进程 secret store。

示例 Host 配置：

```yaml
plugins:
  - id: example-pi-extension
    package: "@example/pi-extension"
    entry: "dist/index.js"
    enabled: true
    required: false
    trust: local-code
    compatibility: L2
    permissions:
      - tools.register
      - lifecycle.context
```

### 11.5 插件隔离

Pi 扩展按受信本地代码看待。第一版不宣称安全执行不可信插件。

建议执行层级：

1. 默认在独立 Node child process 中运行插件，通过结构化 IPC 通信。
2. child process 使用最小环境变量，不继承模型 key 以外的 secret。
3. Host 对每个 hook 和工具调用施加 timeout 和 AbortSignal。
4. 文件系统与网络的真正隔离依赖容器/OS policy，Node child process 本身不是安全沙箱。
5. 若插件必须访问 UI，只通过显式 Host Interface，不传 Fastify/Vue 实例。

## 12. Python Worker 设计

### 12.1 职责

第一阶段 Python Worker 保留：

- STT/TTS provider
- Vision/OpenCV
- Buddy 音频桥和暂未迁移的硬件逻辑
- FruitSpy Python/Crawl4AI Adapter
- 暂未迁移的 Python Skill tools

Python Worker 不拥有：

- 主 Agent loop
- 主 Session 写入
- preset agent 绑定
- Pi PluginHost
- 对外 chat WebSocket

### 12.2 通信 Interface

迁移期推荐内部 loopback HTTP + NDJSON 流。Node Host 通过 `PythonWorkerAdapter` 隐藏协议细节。

基础端点：

```text
GET  /internal/health
GET  /internal/capabilities
POST /internal/tools/list
POST /internal/tools/call
POST /internal/audio/transcribe
POST /internal/audio/synthesize
POST /internal/vision/analyze
POST /internal/buddy/action
```

要求：

- 只绑定 `127.0.0.1` 或 Unix domain socket。
- 使用启动时生成的 worker token。
- 每个请求携带 `request_id`、可选 `run_id` 和 deadline。
- stop/timeout 时 Node Host 取消请求；Python Worker SHOULD 响应客户端断开。
- 工具调用返回规范 `ToolResult`。
- 大型音频或图片使用流，不放入 JSON base64，除非现有 Interface 无法立即迁移。
- worker 不可用时返回 `worker_unavailable`，不会导致 Node Host 崩溃。

### 12.3 进程生命周期

- 本地开发允许分别启动 Host 和 Worker。
- 单容器部署中由 Node Host 的 launcher 启动 Python child process。
- launcher 必须等待 `/internal/health` 成功后再发布相关工具。
- SIGTERM 先停止接受新 run，再 abort active run，最后终止 Worker。
- Worker 意外退出时，Host 标记相关 Adapter degraded，并按指数退避重启。

## 13. Node Host 设计

### 13.1 Fastify Module

Fastify 只负责协议转换和授权，不包含 Agent 业务规则。

路由处理流程：

```text
validate request
  → authenticate/authorize
  → resolve preset agent/session
  → call RunController
  → serialize AgentEvent
```

Host MUST 继续提供当前路径和响应形状。迁移期间可增加 `/internal/runtime/status`，但不得要求现有前端切换路径。

### 13.2 WebSocket 连接状态

每条连接保存：

```ts
type ConnectionState = {
  sessionId: SessionId;
  initialized: boolean;
  presetAgentId?: string;
  activeRunId?: RunId;
  browserRegistration?: BrowserRegistration;
  sendQueue: SerializedSendQueue;
};
```

WebSocket Module 只负责连接级状态。active run 的事实来源是 `RunController`，不能同时在两个位置维护互相矛盾的状态。

### 13.3 静态前端

- Node Host 在生产中直接托管 Vite build 输出。
- 开发模式仍由 Vite proxy `/api`、`/ws`、`/health`、`/fonts`、`/static`。
- 前端先迁移为 import `@anomalo/contracts`，再考虑将目录移动到 `apps/web`。
- 旧 `agent-backend/app/frontend` 生成目录在 Node Host 接管生产前继续维护。

## 14. 配置设计

保持现有环境变量，新增变量使用 `ANOMALO_` 前缀。

建议新增：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ANOMALO_RUNTIME_IMPL` | `python`，切换期后改 `node` | 选择主运行时 |
| `ANOMALO_SESSION_SCHEMA` | `v1`，切换期后改 `v2` | Session Adapter 选择 |
| `ANOMALO_PYTHON_WORKER_URL` | loopback 地址 | Python Worker 地址 |
| `ANOMALO_PYTHON_WORKER_TOKEN` | 启动生成或 secret | Worker 鉴权 |
| `ANOMALO_PI_EXTENSIONS_ENABLED` | `false` | Pi PluginHost 总开关 |
| `ANOMALO_PLUGIN_CONFIG` | `config/plugins.yaml` | 插件 allowlist |
| `ANOMALO_PLUGIN_TIMEOUT_MS` | `30000` | hook/tool 默认 timeout |
| `ANOMALO_EVENT_SCHEMA_VERSION` | `1` | 事件 schema |

配置加载顺序：

```text
code defaults < environment < persisted runtime settings < per-run preset
```

每个 run 启动时冻结 model、temperature、search mode、tool allowlist 和 response format。运行中配置变化只影响新 run。

## 15. 安全设计

迁移不会自动解决现有远程认证问题。Node Host 对外发布前必须满足：

- 管理 Interface 继续要求 `ANOMALO_ADMIN_TOKEN`。
- chat、session、audio、memory 等 Interface 若暴露到非 loopback，必须由反向代理或 Host auth policy 保护。
- 插件和 Skill 明确标记为 trusted code。
- MCP stdio command 和插件 package 必须来自 allowlist。
- `llm.request` 调试事件默认隐藏 Authorization、secret 和敏感 header。
- Python Worker token 不发送到前端。
- Browser bridge result 必须严格匹配 session/run/tool_call。
- ToolRuntime 在列出工具和调用工具时都执行 allowlist。
- PluginHost 的生命周期 hook 无权绕过 Host policy。
- 日志不得记录完整音频、图片、模型 key、admin token 或 worker token。

安全上线 Gate：未配置终端用户认证时，生产 Host MUST 默认只绑定 loopback，除非显式设置 acknowledged override。

## 16. 可观测性

所有日志使用结构化字段：

```text
session_id
run_id
tool_call_id
plugin_id
adapter
phase
iteration
duration_ms
error_code
```

建议指标：

- active runs
- run duration 和 terminal status
- model first-token latency
- tool duration/error count，按 Adapter 分类
- checkpoint save/resume count
- finalizer retry/failure count
- plugin hook duration/failure/fuse count
- Python Worker health/restart count
- Session migration success/failure count

`llm.request` inspector 数据与生产日志分离。Inspector 可按管理权限读取，但普通日志只保存计数、模型、工具数和 context segment 大小。

## 17. 测试策略

### 17.1 契约测试优先

迁移前从当前 Python Implementation 生成可重复 fixture。动态字段归一化：

- `run_id`
- timestamp
- duration
- 外部模型 request id

禁止用真实有副作用工具生成 fixture。使用 Replay Model Adapter 和 deterministic Tool Adapter。

必须覆盖：

- 普通文本完成
- 多轮工具调用
- 最大迭代限制
- 模型流中断
- 工具执行期间 stop
- timeout
- resume 成功
- resume 失败后仍可重试
- paused session 拒绝新消息
- bootstrap tools 并行和 required failure
- `json_object` 和 `json_schema` finalizer
- finalizer 首次验证失败、第二次成功
- finalizer 失败保存 checkpoint
- preset tool allowlist
- Browser Operator 握手与工具 result 匹配

### 17.2 Module 测试

| Module | 主要测试 Seam |
| --- | --- |
| AgentCore | Replay Model + InMemory Session + deterministic ToolRuntime |
| RunController | fake clock、AbortSignal、并发 Session |
| ContextBuilder | 固定资源输入，断言排序和过滤 |
| Session | 同一套测试运行于 InMemory 和 SQLite Adapter |
| ToolRuntime | 多 Adapter、重名、allowlist、timeout、异常归一化 |
| PluginHost | fixture Pi extensions、hook 顺序、timeout、熔断 |
| PythonWorkerAdapter | mock HTTP Worker、断连、超时、取消 |
| Host | Fastify inject + WebSocket 集成测试 |

测试必须穿过 Module Interface。若测试必须访问 Implementation 私有状态，应先检查 Module 是否过浅或 Seam 放置错误。

### 17.3 前端回归

- 现有 `agentSessionProjection` 测试继续运行。
- 添加 Node 事件 fixture，确保旧 Python 与新 Node 事件产生相同 UI 投影。
- Transport 同时测试有/无 `schema_version`。
- run terminal event 只能完成活动组一次。
- stop/resume 按钮状态与 `can_resume` 一致。

### 17.4 数据迁移测试

构造以下旧数据库 fixture：

- 空 Session
- 普通历史
- active skills/MCP/web traces
- paused checkpoint
- interrupted tool call checkpoint
- structured output checkpoint
- 非 ASCII 内容
- 部分损坏 JSON

损坏行不得阻止其他 Session 迁移；报告 session_id 和可执行修复建议。

### 17.5 硬件验证

Buddy 硬件验证保持人工 Gate：

- Serial/TCP connect
- state projection
- touch approval/denial
- audio input/output
- camera follow 不受 Host 迁移影响

测试前遵循 Buddy 文档，不随意打开 serial monitor，不改变固件的 servo auto-angle sync 设置。

## 18. 分阶段实施计划

### Phase 0：冻结行为契约

编码内容：

- 建立 `docs/design` 和迁移 ADR。
- 提取 AgentEvent、Tool、Run request 的 JSON Schema fixture。
- 补齐现有 Python lifecycle 契约测试。
- 建立 Replay LLM 和 deterministic tools。
- 记录当前 REST、NDJSON、WebSocket 行为。

退出条件：

- 当前 Python 测试全绿。
- 关键事件序列有 golden fixtures。
- 旧前端可用 fixtures 完成投影测试。
- 没有真实模型或真实硬件依赖。

### Phase 1：在 Python 中深化 Agent Module

编码内容：

- 从 `runtime.py` 提取 ContextBuilder。
- 从运行并发与 stop 逻辑提取 RunController。
- 将 structured finalizer 变成 AgentCore 内部 Implementation。
- 保持 `AgentRuntime` 作为兼容 facade，调用新的深 Module。
- 禁止修改对外事件和 Session schema。

退出条件：

- golden fixtures 无差异。
- `runtime.py` 不再直接加载 prompt/skills/MCP 文件。
- WebSocket 不再直接操作 AgentCore 私有状态。
- pause/resume、timeout 和 structured output 测试全绿。

### Phase 2：建立 TypeScript 工作区和共享 contracts

编码内容：

- 添加 root `package.json` workspaces 和 `tsconfig.base.json`。
- 创建 `@anomalo/contracts`。
- 前端改为消费共享事件类型和运行时 schema。
- Python 使用导出的 JSON Schema 做对照验证。

退出条件：

- `npm test --workspaces` 可运行。
- Python 和 TypeScript 对同一 fixtures 验证结果一致。
- 前端行为无变化。

### Phase 3：实现 TypeScript AgentCore

编码内容：

- AgentCore、RunController、ContextBuilder、ToolRuntime。
- OpenAICompatibleAdapter、ReplayModelAdapter。
- InMemorySessionAdapter。
- 只运行 replay/fixture，不连接生产流量。

退出条件：

- Python 和 TypeScript 的规范化事件序列一致。
- 所有 stop/resume/finalizer fixture 通过。
- AgentCore 无 Fastify、SQLite、OpenAI SDK 直接 import。

### Phase 4：Session v2 与 Node Host

编码内容：

- SQLite Session Adapter、schema migration、dry-run CLI。
- 为旧 Python Host 增加读取和写入同一 v2 schema 的兼容 Adapter。
- 在切换 Node Host 前，先让 Python Host 以 `ANOMALO_SESSION_SCHEMA=v2` 运行并验证恢复能力。
- Fastify Host、REST/NDJSON/WebSocket Interface。
- 静态前端托管。
- `ANOMALO_RUNTIME_IMPL` 切换开关。
- 先在本地和测试环境使用 Node Host。

退出条件：

- 旧 Session 迁移校验通过。
- Python Host 和 Node Host 的 Session 契约测试运行于同一组 v2 fixture。
- `/api/chat`、`/api/chat/stream`、WebSocket 与旧 Host 契约一致。
- Node Host 可使用 mock model 完成全部前端流程。
- 关闭 Node 模式即可回到旧 Python Host。

### Phase 5：迁移 Adapter 与 Python Worker

编码内容：

- MCP、Web、Browser、Buddy、Python sandbox Adapter。
- 把音频、视觉和剩余 Python 能力整理为 Worker Interface。
- 去除 `buddy-backend` 对 `app.*` 的交叉 import。
- Node launcher 管理 Worker 生命周期。

退出条件：

- Tool status、调用结果和错误码与旧系统一致。
- Buddy 人工 Gate 通过。
- Worker 不可用时 Host 仍可提供不依赖 Worker 的 Agent 能力。

### Phase 6：Pi 兼容

编码内容：

- L1 Resource loader。
- L2 `registerTool` 和 Pi Tool Adapter。
- 插件 child-process runner。
- L3 生命周期 mapping、load report、timeout 和熔断。
- fixture 插件兼容测试。

退出条件：

- 至少两个不同 Pi 扩展通过 L2 测试，Seam 因此成为真实 Seam。
- 不支持能力有明确报告。
- 未 allowlist 的插件不会被执行。
- 插件失败不会破坏主 Host。

### Phase 7：切换与清理

编码内容：

- 新安装默认 `ANOMALO_RUNTIME_IMPL=node`。
- 现有部署完成 dry-run 和备份后切换。
- 保留旧 Python Host 一个发布周期。
- 观察稳定后移除旧 chat/runtime Host，只保留 Worker。

退出条件：

- Node Host 连续稳定运行目标观察期。
- 无未迁移 Session。
- 无旧 Host 独占能力。
- 回滚演练通过。

## 19. 建议 PR 切分

每个 PR 必须可独立回滚，禁止一个 PR 同时包含语言迁移、Session 数据迁移和硬件改造。

1. `docs: record node runtime migration design`
2. `test: freeze agent runtime event contracts`
3. `refactor: deepen python context and run modules`
4. `chore: add typescript workspace and shared contracts`
5. `feat: implement replayable typescript agent core`
6. `feat: add session v2 sqlite adapter and migration cli`
7. `feat: add node host chat transports`
8. `feat: add runtime implementation switch`
9. `refactor: expose python capabilities through worker interface`
10. `feat: migrate tool adapters to node host`
11. `feat: add pi resource and tool compatibility`
12. `feat: add pi lifecycle plugin runner`
13. `chore: make node host the default runtime`
14. `chore: retire legacy python chat host`

每个 PR 描述应包含：

- 改变了哪个 Module 的 Interface 或 Implementation。
- 对现有行为契约是否有差异。
- 新增或复用哪些契约测试。
- 数据是否变化以及回滚方式。
- feature flag 和发布顺序。

## 20. 发布与回滚

### 20.1 发布顺序

1. 备份 `/data/sessions.sqlite3` 和 preset agent 数据库。
2. 运行 Session v2 dry-run。
3. 部署同时包含旧 Python Host 和 Node Host 的镜像。
4. 用 mock model 和临时 Session 执行 smoke test。
5. 对测试 Session 启用 Node Host。
6. 全局切换 `ANOMALO_RUNTIME_IMPL=node`。
7. 观察 run error、checkpoint、Worker 和 Buddy 指标。

### 20.2 回滚

- 停止接收新 run。
- 等待或 stop 当前 active run，确认 checkpoint 已保存。
- 切换 `ANOMALO_RUNTIME_IMPL=python` 并重新部署。
- 旧 Python Host 在兼容期通过 Python v2 Session Adapter 继续读取和写入同一组 v2 表。
- 不允许通过删除 v2 表回滚。

正式切换前 MUST 完成 Python v2 Session Adapter。v2 → legacy export 只用于离线诊断，不作为生产回滚路径。

## 21. 风险与控制

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| 逐行 TypeScript 重写复制耦合 | 新系统失去 Locality | Phase 1 先深化 Python Module，契约测试 Gate |
| Node 与 Python 事件细节不一致 | 前端状态错误 | 共享 schema、golden fixtures、投影测试 |
| Session 迁移破坏 resume | 丢失未完成任务 | 新表懒迁移、原值保留、hash 校验、dry-run |
| 双运行时重复执行工具 | 外部副作用重复 | 每个 Session 单一 owner，禁止 live shadow execution |
| 插件拥有主机权限 | 凭据或文件泄露 | allowlist、child process、最小环境、明确 trusted code |
| Python Worker 故障拖垮 Host | 全系统不可用 | Adapter 降级、健康检查、重启和 capability 隐藏 |
| Buddy 交叉 import 阻碍迁移 | 硬件能力难拆 | 先定义 Call Buddy Adapter，再迁移实现 |
| SQLite native driver 构建失败 | ARM64 镜像不可部署 | 在 Apple Container 构建阶段编译并做 smoke test |
| 完整 Pi 兼容范围失控 | 迁移长期无法结束 | 分级声明，L5 明确非目标 |

## 22. 完成定义

只有满足以下条件，才可称为“Node.js 驱动迁移完成”：

- Node Host 是 HTTP/WebSocket 和 Agent Run 的唯一 owner。
- Vue 与 Host 共享 `@anomalo/contracts`。
- AgentCore、Session、ToolRuntime、PluginHost 都有稳定 Interface 和契约测试。
- 现有 chat、preset、browser、stop/resume、structured output 行为通过回归。
- 旧 Session 可无损读取和恢复。
- Python 只保留明确的 Worker 能力。
- Buddy 仍符合“设备是具身 Interface，Host 是主运行时”的领域定义。
- Pi L1/L2 兼容通过至少两个真实扩展验证。
- 插件信任、allowlist 和不支持能力可观察。
- 部署和回滚演练完成。

## 23. 给实现模型的编码约束

负责编码的模型应遵循以下顺序：

1. 先读本文、`README.md`、Buddy `CONTEXT.md` 和相关测试。
2. 每次只实现一个 Phase 或一个 PR 切片。
3. 先补或运行契约测试，再修改 Implementation。
4. 不修改事件名、错误语义、Session 数据或工具顺序，除非当前 PR 明确授权。
5. 不以“以后会有第二个 Adapter”为理由提前制造 Seam；例外是本文已列出的迁移 Seam。
6. 新 Module 必须通过删除测试：若删除后复杂度不会重新散落到多个调用者，则该 Module 可能是 Shallow。
7. 测试只穿过 Interface；不要为测试暴露私有 Implementation。
8. 遇到本文未决事项时，优先保持现有行为，并在 PR 中记录假设。
9. 不执行破坏性数据库迁移；所有迁移必须可 dry-run、幂等并保留原数据。
10. 每个阶段结束后同时运行 Python、TypeScript 和前端测试。

目标测试命令：

```bash
uv run pytest
uv run ruff check .
npm test --workspaces --if-present
npm run typecheck --workspaces --if-present
npm --prefix frontend run test
npm --prefix frontend run build
```

## 24. 参考资料

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [Pi Packages](https://pi.dev/docs/latest/packages)
- [Pi Sessions](https://pi.dev/docs/latest/sessions)
- [Pi Compaction](https://pi.dev/docs/latest/compaction)
- [Pi Security](https://pi.dev/docs/latest/security)
- Anomalo 当前运行时：`agent-backend/app/agent/runtime.py`
- Anomalo 当前 Session：`agent-backend/app/agent/session.py`
- Anomalo 当前 Tool Interface：`agent-backend/app/tools/base.py`
- Buddy 领域上下文：`buddy-backend/docs/CONTEXT.md`
