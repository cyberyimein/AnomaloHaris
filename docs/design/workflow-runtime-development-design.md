# AnomaloHaris Workflow Runtime 开发设计

> 状态：Proposed for implementation
>
> 面向读者：负责分阶段实现本方案的 Luna 编码模型，以及后续审查、测试和发布人员
>
> 依赖决策：`docs/adr/0002-node-only-preset-model-compute-center.md`、`docs/adr/0003-anomaloharis-canonical-naming.md`、`docs/adr/0004-peer-agent-and-workflow-runtimes.md`
>
> Urus 对接手册：`docs/integrations/urus-workflow.md`
>
> 规范词：MUST 表示必须满足，SHOULD 表示默认应满足，MAY 表示可以延后
>
> 范围：只实现“导入并注册版本化工作流，再按 `name@version` 调用”的方式；不支持在单次运行请求中携带临时工作流定义

## 1. 执行摘要

AnomaloHaris 将新增与 AgentCore 平级的一等 Workflow Runtime。Workflow Runtime 是可执行的深 Module，负责工作流的注册、校验、编译和调度；外部导入的 Workflow JSON 是它管理的声明式、版本化资源，不是可执行插件代码。

Preset Model 与 Workflow 是两种平级的可调用资源；AgentCore 与 WorkflowRunner 是两个平级执行 Module。二者共同接入统一 Run Control，复用同一套身份、鉴权、幂等、事件传输、取消、usage 和审计语义。Workflow Runtime 通过受信任的内建 Runtime Adapter 装配和版本锁定，但不受普通工具插件 Interface 限制。

外部系统（例如 Urus）的标准协作流程是：

```text
AnomaloHaris 导出 Workflow Capability Manifest
  → Urus 按能力清单设计 Workflow Definition
  → Urus 导出 Workflow JSON
  → AnomaloHaris 无副作用校验
  → 导入为 draft
  → 再校验并编译
  → 管理员发布 workflow-name@version
  → 调用方只发送 workflow ref 和运行数据
```

必须保持以下架构约束：

1. Workflow 与 Preset Model 是平级可调用资源；Workflow Definition 是数据。
2. WorkflowRunner 与 AgentCore 是平级执行 Module，共享统一 Run Control；不得建设两套身份、鉴权、Run、事件、取消、usage 或审计基础设施。
3. Workflow Runtime 通过受信任的内建 Runtime Adapter 装配；它不是普通工具插件，也不得获得任意 Host、Fastify 或 Vue 控制权。
4. WorkflowRunner 只负责图调度，通过 AgentExecution Interface 调用 AgentCore；AgentCore 永远不得依赖 Workflow Runtime。
5. 已发布工作流通过不可变 `name@version` 寻址；修改定义、节点配置、精确依赖或策略必须创建新版本。
6. 导入不等于发布；任何导入内容必须先成为 draft。
7. Workflow JSON 不得包含 JavaScript、Provider credential、system prompt、插件安装路径或任意可执行代码。
8. Host 继续拥有鉴权、HTTP 路由、错误投影和前端 Tab 外壳；Runtime Adapter 只接入显式 Seam。
9. 第一阶段只交付管理面和兼容性闭环，不执行工作流；第二阶段再交付运行面。

## 2. 产品与内部命名决策

### 2.1 当前混用是否会导致开发混乱

会，但风险来自“没有规则的混用”，而不是 `@anomalo/*` 字符串本身。当前仓库已经同时存在： <!-- naming-compat -->

- 产品名和 workspace 根包名：`AnomaloHaris` / `anomaloharis`。
- 历史 npm scope：`@anomalo/*`。 <!-- naming-compat -->
- 历史 HTTP header 和管理 token：`X-Anomalo-*`。 <!-- naming-compat -->
- 历史 Schema URI：`anomalo.dev`。 <!-- naming-compat -->
- 内建 Preset Model：`anomalo@1`。 <!-- naming-compat -->

如果在 Workflow 开发中一部分新标识使用 `anomalo`、另一部分使用 `anomaloharis`，Luna 很容易误判哪些是兼容标识、哪些是新产品标识，并进一步制造重复配置、错误环境变量和不兼容协议。 <!-- naming-compat -->

### 2.2 Stage 0 完成后的唯一命名层级

名称迁移必须在 Workflow 功能开发前作为 Stage 0 集中完成。Stage 0 Gate 通过后，实现者 MUST 遵守以下映射：

| 层级 | 规范名称 | 规则 |
| --- | --- | --- |
| 产品显示、文档、人类可读错误 | `AnomaloHaris` | 新代码和 UI 不得把产品显示为 `Anomalo` | <!-- naming-compat -->
| workspace 根包 | `anomaloharis` | 保持现状 |
| 所有公开 Schema URI | `anomaloharis.dev/*` | Stage 0 迁移现有 `anomalo.dev/*` | <!-- naming-compat -->
| npm scope | `@anomaloharis/*` | Stage 0 原子迁移所有 workspace package、import 和 lockfile |
| Workflow Runtime package | `@anomaloharis/workflow-runtime` | 不得再创建新的 `@anomalo/*` package | <!-- naming-compat -->
| Runtime Adapter ID | `workflow-runtime` | 不携带产品前缀，避免未来 scope 改名影响持久化引用 |
| 数据库表、类型、路由资源 | `workflow_*` / `Workflow*` / `/api/workflows` | 使用领域名，不使用产品简称 |
| Header | `X-AnomaloHaris-*` | 旧 Header 只能由集中兼容 Adapter 临时读取 |
| 环境变量 | `ANOMALOHARIS_*` | 内部配置对象只允许 canonical 字段 |
| 内建默认 Preset Model | `anomaloharis@1` | Stage 0 一次性迁移定义、Session binding 和 fixture |

`anomalo`、`@anomalo/*`、`anomalo.dev`、`ANOMALO_*` 和 `X-Anomalo-*` 在 Stage 0 后只允许出现在： <!-- naming-compat -->

- 集中的 `LegacyNamingAdapter`。
- 数据迁移代码和迁移 fixture。
- 标明 historical/superseded 的旧文档。
- 明确验证旧输入兼容性的测试。

业务 Implementation、数据库新写入、公开导出、日志字段和新测试 fixture 不得继续产生旧名称。兼容期采用“旧输入可读、内部立即规范化、所有输出只写新名称”；兼容期限和删除版本由 Stage 0 ADR 固定。

### 2.3 新代码命名规则

- 类型使用 `WorkflowDefinition`、`CompiledWorkflow`、`WorkflowRef`，不得使用模糊的 `Flow`、`Job` 或 `Pipeline`。
- `workflow` 只表示可发布的定义；`workflowRun` 表示一次执行；`nodeRun` 表示一次节点执行。
- `plugin` 只表示受信任的可执行 Module；不得把导入的 Workflow Definition 称为 plugin package。
- `model_ref` 必须表示 Preset Model Ref；`workflow_ref` 必须表示 Workflow Ref。
- 代码和协议中不得用裸 `name` 代替 ref；发布和运行路径必须始终携带 version。

## 3. 目标与非目标

### 3.1 目标

- Workflow 作为与 Preset Model 平级的一等可调用资源接入现有 Node-only Host。
- Workflow Definition 支持 JSON 导入、无副作用校验、draft 管理、导出、发布、退役和按版本调用。
- Workflow Tab 可以导出当前实例的机器可读 Workflow Capability Manifest。
- Urus 可以依据 Manifest 离线设计工作流，并在导入时得到稳定、可定位的校验报告。
- WorkflowRunner 与 AgentCore 共享统一 Run Control，并复用现有 Preset Model 和插件能力。
- 同一已发布 `workflow-name@version` 对应不可变定义与不可变 compiled hash。
- 运行可以取消、恢复进程崩溃后的终态，并可追踪每个子 Run。

### 3.2 非目标

- 不支持“工作流定义和数据一起发送并立即运行”。
- 不实现图形化拖拽编辑器；Workflow Tab 是导入、检查、发布和运行管理面。
- 不允许在导入时安装、更新或下载插件。
- 不允许 Workflow JSON 直接选择 Provider、覆盖 Preset Model prompt、工具集合或运行 policy。
- 不支持任意 JavaScript、模板代码、shell、动态模块 import 或远程 `$ref`。
- 第一版不支持图环路、长时间 wait、人工审批、定时触发、子工作流、补偿事务和跨 Host 分布式调度。
- 不重写现有 Preset Model Registry、AgentCore 或 PluginHost；只在统一 Run Control 建立真正需要的执行 Runtime Seam。
- 不把 Workflow Runtime 降格为普通工具插件。
- 不建设拥有独立鉴权、Run identity、事件传输、usage 和审计的第二套 Host 内核。

## 4. 统一领域术语

| 术语 | 定义 |
| --- | --- |
| Workflow Runtime | 与 AgentCore 平级的可执行深 Module；提供 Registry、Validator、Compiler 和 Runner |
| Runtime Adapter | 在统一 Run Control Seam 装配某个执行 Runtime 的受信任 Adapter |
| Run Control | Agent 与 Workflow 共享的身份、鉴权、幂等、事件、取消、usage 和审计 Module |
| AgentExecution Interface | WorkflowRunner 调用 AgentCore 的单向执行 Interface |
| Workflow Definition | 外部可导入、可导出的声明式 JSON 定义 |
| Workflow Name | 稳定的小写名称 |
| Workflow Version | 每个 name 下单调递增的正整数 |
| Workflow Ref | `<name>@<version>` |
| Workflow Draft | 尚未发布、允许删除的版本记录 |
| Compiled Workflow | Definition 经校验并解析所有依赖后生成的不可变快照 |
| Workflow Capability Manifest | 当前实例可编排节点、Preset Model、插件操作和限制的机器可读快照 |
| Node Type | Workflow Runtime 支持的一类节点及其配置、输入和输出 Schema |
| Plugin Operation | 插件显式声明为 `workflow_callable` 的确定性调用入口 |
| Workflow Run | 一次已发布 Workflow 的执行 |
| Node Run | Workflow Run 中一个节点的一次执行尝试 |
| Child Agent Run | `preset_model` 节点通过 AgentExecution Interface 创建的 Agent Run |

## 5. 架构与 Module 职责

```text
                    Workflow Tab / Urus / Agent clients
                                  │
                                  ▼
                  Host transport + auth + error projection
                                  │
                                  ▼
                         Unified Run Control
          identity / idempotency / events / stop / usage / audit
                         │                   │
              ┌──────────┘                   └──────────┐
              ▼                                         ▼
       Agent Runtime Adapter                    Workflow Runtime Adapter
              │                                         │
              ▼                                         ▼
         AgentCore Module                      WorkflowRunner Module
              ▲                                         │
              └────── AgentExecution Interface ─────────┤
                                                        ├── WorkflowRegistry
                                                        ├── WorkflowCompiler
                                                        └── PluginOperation Adapter
                                                                  │
                                                                  ▼
                                                              PluginHost
```

### 5.1 平级资源与平级执行 Module

Preset Model 和 Workflow 在产品 Interface 上平级：

```text
preset-model-name@version  → Agent Runtime Adapter → AgentCore
workflow-name@version      → Workflow Runtime Adapter → WorkflowRunner
```

两种资源拥有各自的 Definition、Registry、Compiler 和运行状态，但共享统一 Run Control。这里的“平级”不表示两套独立 Host：Host、transport、鉴权、run id、幂等、事件序列、取消、usage 和审计只有一个所有者。

依赖方向必须保持单向：

```text
WorkflowRunner → AgentExecution Interface → AgentCore
AgentCore      ✗→ WorkflowRunner
```

WorkflowRunner 可以将 Preset Model 作为节点执行；AgentCore 不知道 Workflow、Node Run 或 DAG。这样 Workflow 能获得 AgentCore 的 Leverage，同时 AgentCore 保持独立和可测试。

### 5.2 Workflow Runtime package

建议新增 workspace package：

```text
apps/workflow-runtime/
  package.json                # @anomaloharis/workflow-runtime
  src/index.ts
  src/registry.ts
  src/capability-catalog.ts
  src/validator.ts
  src/compiler.ts
  src/runner.ts               # 第二阶段
  src/store.ts
  src/errors.ts
  src/nodes/*                 # 第二阶段
  src/*.test.ts
```

该 Module 的 Interface 必须保持窄而深：Host 不应理解图算法、依赖解析、hash、节点状态转换或编译细节。删除该 Module 后，这些复杂性会重新出现在多个调用者和测试中，因此它提供实际 Depth、Leverage 和 Locality，而不是 pass-through。

### 5.3 Runtime Adapter 与普通插件的区别

Workflow Runtime 通过受信任的内建 Runtime Adapter 注册到统一 Run Control。Runtime Adapter 负责：

- 声明 runtime kind、版本、package hash 和 capability。
- 把统一 Run Control 的 start/get/events/stop 调用投影到 Workflow Runtime。
- 把 Workflow Runtime 的事件和终态投影回统一 Run envelope。
- 在启动时验证版本锁和健康状态。

它不得注册任意 Fastify 路由、注入 Vue、读取 raw request 或绕过 Host 鉴权。

普通插件仍由 `PluginHost` 管理，提供 tool、hook 和显式 `workflow_callable` operation。Workflow Runtime 本身不是普通工具插件；`plugin_operation` 节点才是 Workflow Runtime 对普通插件能力的受控调用。

现有 `PluginHost` Interface 不得为了 Workflow Runtime 扩展数据库、路由、UI 或顶层运行生命周期。Runtime Adapter 与 PluginHost 是两个不同的 Seam。

### 5.4 统一 Run Control

现有 Agent `RunService` 必须深化为统一 Run Control，而不是在旁边创建 `WorkflowRunService`。建议 Interface：

```ts
type ExecutionTarget =
  | { kind: "preset_model"; ref: PresetModelRef }
  | { kind: "workflow"; ref: WorkflowRef };

export interface ExecutionRuntimeAdapter {
  readonly kind: ExecutionTarget["kind"];
  resolve(ref: string): Promise<ResolvedExecutionTarget>;
  start(context: RunContext, input: unknown): AsyncIterable<RunEvent>;
  stop(runId: string, reason: StopReason): Promise<StopResult>;
  recover(runId: string): Promise<RecoveryResult>;
}

export interface RunControl {
  start(target: ExecutionTarget, request: StartRunRequest): AsyncIterable<RunEvent>;
  get(runId: string): Promise<RunRecord>;
  events(runId: string, afterSequence?: number): AsyncIterable<RunEvent>;
  stop(runId: string, reason: StopReason): Promise<StopResult>;
}
```

统一 Run Control 的 Implementation 负责：

- 调用身份和 target allowlist。
- 全局 run id、idempotency key 和并发/预算。
- 顶层事件 sequence、transport replay 和终态。
- stop 信号及 Host restart recovery 调度。
- usage/cost 聚合和审计索引。

Runtime Adapter 负责目标特有的 resolve、执行和状态细节。Agent Runtime Adapter 保留现有 Session/checkpoint 语义；Workflow Runtime Adapter 管理 DAG、Node Run 和 child run 关系。

### 5.5 Workflow 管理 Interface

Host 通过独立管理 Seam 使用 Workflow Runtime；管理 Interface 不进入统一 Run Control：

```ts
export interface WorkflowManagement {
  capabilities(): WorkflowCapabilityManifest;
  validate(definition: unknown): Promise<WorkflowValidationReport>;
  importDraft(definition: unknown): Promise<WorkflowImportResult>;
  list(options?: WorkflowListOptions): Promise<WorkflowSummary[]>;
  get(ref: WorkflowRef, options?: WorkflowResolveOptions): Promise<StoredWorkflow>;
  exportDefinition(ref: WorkflowRef): Promise<WorkflowDefinition>;
  publish(ref: WorkflowRef): Promise<PublishedWorkflow>;
  retire(ref: WorkflowRef): Promise<PublishedWorkflow>;
  deleteDraft(ref: WorkflowRef): Promise<void>;
}

```

运行调用只通过统一 Run Control，禁止 Host 直接调用第二套 `WorkflowExecution` Interface。以上 TypeScript 仅规定调用方向；具体类型以 `@anomaloharis/contracts` 中导出的 Schema 为唯一来源。测试必须通过同一 Seam 使用 in-memory Adapter，不得为测试暴露 Registry 内部方法。

### 5.6 Workflow Runtime 依赖 Adapter

Workflow Runtime 不直接 import `SqlitePresetModelRegistry`、AgentCore Implementation、Fastify request 或 Vue 状态。Host 注入以下 Adapter：

- `PresetModelResolver`：列出可公开编排的已发布 Preset Model，并按精确 ref 解析 compiled hash、输入和输出能力。
- `AgentExecution`：按精确 Preset Model Ref 启动、查询和停止 Agent Run；生产 Adapter 调用统一 Run Control 的受控 child-run Interface。
- `PluginOperation` Interface：列出并调用显式允许工作流使用的插件操作。
- `WorkflowClock`：产生时间，便于确定性测试。
- `WorkflowIdGenerator`：产生 run/node-run ID。

第一阶段只需要 resolver 和 catalog Adapter；第二阶段才启用执行 Adapter。每个 Seam 必须至少存在生产 Adapter 和测试内存 Adapter，避免只有一个 Adapter 的假抽象。AgentExecution Interface 不得暴露 Provider、prompt 或 tool loop 细节。

生产 AgentExecution Adapter 使用 Run Control 的受限 child-run Interface：

```ts
export interface ChildRunControl {
  startAgentChild(
    parentRunId: string,
    target: { kind: "preset_model"; ref: PresetModelRef },
    request: StartChildAgentRunRequest,
  ): AsyncIterable<AgentRunEvent>;
  stopChildren(parentRunId: string, reason: StopReason): Promise<void>;
}
```

该 Interface 只接受 `preset_model` target，禁止 WorkflowRuntime 递归启动另一个 Workflow。Run Control 负责写入 `parent_run_id`、继承调用身份与预算、收紧权限并传播 stop；Workflow Runtime 只保存 child run id。

## 6. Workflow Definition 合同

### 6.1 顶层结构

`@anomaloharis/contracts` 必须增加 TypeBox Schema、静态类型、Ajv 校验和导出的 JSON Schema：

```json
{
  "api_version": "anomaloharis.dev/workflow/v1",
  "kind": "Workflow",
  "metadata": {
    "name": "daily-event-review",
    "version": 1,
    "description": "Review scheduled events",
    "labels": {
      "owner": "urus"
    }
  },
  "spec": {
    "input_schema": {
      "type": "object",
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object"
    },
    "nodes": [],
    "edges": [],
    "policy": {
      "timeout_seconds": 900,
      "max_parallelism": 4,
      "failure_mode": "fail_fast"
    }
  },
  "compatibility": {
    "authored_against_manifest_hash": "sha256:..."
  }
}
```

规则：

- name 使用 `^[a-z][a-z0-9-]{0,63}$`。
- version 是正安全整数。
- 顶层和关键嵌套对象必须 `additionalProperties: false`；`metadata.labels` 和 JSON Schema 内容除外。
- Definition UTF-8 编码后默认不得超过 1 MiB。
- 节点默认最多 100 个，边最多 400 条。
- JSON Schema 只允许本地结构；禁止远程 `$ref`、递归无界 Schema 和未知 format 扩展。
- `authored_against_manifest_hash` 用于兼容性告警，不能单独决定导入失败。全量 Manifest 可能因无关能力变化而改变；真正的兼容性由 Definition 使用的精确依赖决定。

### 6.2 节点统一结构

```json
{
  "id": "investigate",
  "type": "preset_model",
  "type_version": 1,
  "config": {
    "model_ref": "scheduled-event-investigator@1"
  },
  "retry": {
    "max_attempts": 1,
    "backoff_ms": 0
  }
}
```

- node id 使用 `^[a-z][a-z0-9_-]{0,63}$`，在 Definition 内唯一。
- `type + type_version` 唯一决定节点语义。
- 节点配置必须符合 Capability Manifest 中该节点的 `config_schema`。
- 重试只对节点 Adapter 声明为 retryable 的错误生效。
- Workflow Runner 不得在重试之间改变已解析依赖版本。

### 6.3 边与端口

```json
{
  "from": { "node": "input", "port": "data" },
  "to": { "node": "investigate", "port": "input" }
}
```

- 数据只通过显式端口流动，不允许节点从全局上下文读取任意其他节点结果。
- source output Schema 必须可赋值给 target input Schema。
- 同一单值 input port 最多有一条入边；集合型端口必须在 Node Type 中明确声明。
- `condition` 使用 `true` 和 `false` 控制端口。
- V1 图必须是 DAG；自环和间接环都返回稳定错误码。

### 6.4 V1 Node Types

| type | 阶段 | 语义 |
| --- | --- | --- |
| `input` | 1 定义/2 执行 | 唯一入口；把运行输入按 `spec.input_schema` 投影为 `data` |
| `output` | 1 定义/2 执行 | 唯一出口；结果必须满足 `spec.output_schema` |
| `preset_model` | 1 定义/2 执行 | 通过 AgentExecution Interface 调用精确 Model Ref |
| `condition` | 1 定义/2 执行 | 使用受限表达式 AST 选择 `true` 或 `false` 分支 |
| `parallel` | 1 定义/2 执行 | 显式扇出；受 Workflow 并发限制控制 |
| `join` | 1 定义/2 执行 | 等待声明的所有分支并按稳定 key 聚合 |
| `plugin_operation` | 1 声明/2 执行 | 仅调用显式 `workflow_callable` 的精确插件操作 |

第一版不提供 loop。未来引入 loop 必须另写设计，规定最大迭代、终止条件、checkpoint、费用和取消传播。

### 6.5 Preset Model 节点

`preset_model` 节点 config：

```json
{
  "model_ref": "scheduled-event-investigator@1",
  "input_mode": "message",
  "session_mode": "isolated"
}
```

要求：

- 必须引用已发布的精确 `name@version`，禁止 `latest`。
- 不允许携带 provider、prompt、temperature、plugins、tools 或 credential。
- `message` 模式输入至少包含 `{ "message": "..." }`。
- V1 每个节点使用隔离 Session；不得隐式共享其他节点或调用方 Session history。
- 输出统一为 `{ child_run_id, status, message, structured_output?, usage? }`。
- response format 是否可覆盖完全服从 Preset Model policy；Workflow 不扩大其权限。

### 6.6 受限表达式

`condition` 不接受字符串脚本，使用可校验 AST：

```json
{
  "op": "eq",
  "left": { "path": "$.status" },
  "right": { "literal": "confirmed" }
}
```

V1 只支持 `eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`and`、`or`、`not`、`exists`。路径只读取当前节点输入，最大深度和 AST 节点数必须受限；不得执行函数、网络、文件或时间读取。

## 7. Workflow Capability Manifest

### 7.1 用途与导出

Workflow Tab 必须提供独立的“导出能力清单”操作，下载 `anomaloharis-workflow-capabilities.json`。同一内容也通过只读 Interface 提供给 Urus；它不是某个 Workflow 的导出文件。

Manifest 至少包含：

```json
{
  "api_version": "anomaloharis.dev/workflow-capabilities/v1",
  "engine": {
    "runtime_id": "workflow-runtime",
    "runtime_version": "1.0.0",
    "adapter_version": "1.0.0",
    "package_hash": "sha256:...",
    "definition_api_version": "anomaloharis.dev/workflow/v1"
  },
  "limits": {
    "graph": "dag",
    "max_nodes": 100,
    "max_edges": 400,
    "max_parallelism": 8,
    "max_duration_seconds": 3600
  },
  "node_types": [],
  "preset_models": [],
  "plugin_operations": [],
  "unsupported_features": ["loop", "wait", "approval", "subworkflow"],
  "generated_at": "2026-08-25T00:00:00.000Z",
  "manifest_hash": "sha256:..."
}
```

### 7.2 Manifest 生成规则

- Node Types 来自 Workflow Runtime 自己的版本化 Node Type Registry。
- Preset Models 只包含已发布且当前可解析的精确 refs。
- Draft、retired、不可用或插件锁损坏的 Preset Model 不得作为可编排能力输出。
- Plugin Operations 只包含明确声明 `workflow_callable: true` 且已加载、未熔断、版本与 hash 可确定的操作。
- 数组必须按稳定 key 排序；hash 前使用 canonical JSON，排除 `generated_at` 和 `manifest_hash` 本身。
- 相同运行时能力必须生成相同 hash，与枚举顺序和进程重启无关。
- Manifest 只描述 Interface，不泄露 system prompt、credential ref、插件私有配置、package path、environment 或 Host 文件路径。

### 7.3 Plugin Operation 声明扩展

现有 `PluginCapabilityDeclaration` 只包含 `id/kind/description`，不足以安全编排。必须向后兼容地增加可选字段：

```ts
type WorkflowCallableOperation = {
  id: string;
  version: number;
  workflow_callable: true;
  description: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  permissions: readonly string[];
  timeout_ms: number;
  idempotency: "required" | "supported" | "none";
};
```

没有这些字段的现有 tool/service capability 默认 `workflow_callable: false`。工具已出现在 Preset Model 中不等于它可以被 Workflow 直接调用。

## 8. 校验、导入和编译

### 8.1 无副作用校验

校验必须是无副作用操作：不得创建数据库记录、启动 Agent Run、调用插件、安装依赖或修改缓存。校验顺序固定为：

1. JSON 解析与大小限制。
2. Workflow Definition Schema 校验。
3. name/version 和节点 ID 规范化检查。
4. 图语义校验：唯一入口/出口、端口、可达性、DAG、边数。
5. Node Type 和 config Schema 解析。
6. 精确 Preset Model / Plugin Operation 依赖解析。
7. 数据端口 Schema 兼容检查。
8. 权限、并发、timeout 和 retry policy 检查。
9. 编译预览与 hash 计算。

### 8.2 Validation Report

```json
{
  "valid": false,
  "errors": [
    {
      "code": "WORKFLOW_PRESET_MODEL_NOT_FOUND",
      "path": "/spec/nodes/2/config/model_ref",
      "node_id": "investigate",
      "message": "Preset Model scheduled-event-investigator@2 is not published"
    }
  ],
  "warnings": [],
  "resolved_dependencies": [],
  "definition_hash": "sha256:...",
  "capability_manifest_hash": "sha256:...",
  "compiled_hash": null
}
```

要求：

- `path` 使用 JSON Pointer。
- error/warning 按 path、code 稳定排序。
- code 是机器合同，message 是人类说明。
- 同一根因不得重复生成多个错误。
- Manifest hash 不一致但所有精确依赖仍满足时产生 warning，不得失败。
- warning 不阻止导入或发布；UI 必须明确显示。

最低错误码集合：

```text
WORKFLOW_INVALID_JSON
WORKFLOW_SCHEMA_INVALID
WORKFLOW_REF_INVALID
WORKFLOW_NODE_ID_DUPLICATE
WORKFLOW_ENTRY_INVALID
WORKFLOW_OUTPUT_INVALID
WORKFLOW_NODE_UNREACHABLE
WORKFLOW_CYCLE_FORBIDDEN
WORKFLOW_PORT_NOT_FOUND
WORKFLOW_PORT_MULTIPLE_INPUTS
WORKFLOW_SCHEMA_INCOMPATIBLE
WORKFLOW_NODE_TYPE_UNSUPPORTED
WORKFLOW_NODE_CONFIG_INVALID
WORKFLOW_PRESET_MODEL_NOT_FOUND
WORKFLOW_PLUGIN_OPERATION_NOT_FOUND
WORKFLOW_PLUGIN_OPERATION_FORBIDDEN
WORKFLOW_LIMIT_EXCEEDED
WORKFLOW_PERMISSION_DENIED
```

### 8.3 Import 语义

- Import 必须先执行与 validate 完全相同的校验 Implementation，禁止两套规则。
- valid=false 时不写库。
- valid=true 时创建 `draft` 和 compiled snapshot。
- 相同 `name@version` 不存在：返回 `201 Created`。
- 已存在且 definition hash 相同：幂等返回现有 draft，返回 `200 OK` 和 `idempotent: true`。
- 已存在且 hash 不同：返回 `409 workflow_version_conflict`。
- 已发布或已退役 ref 永远不能被 Import 覆盖。
- Import 不自动 publish。

### 8.4 编译产物

Compiled Workflow 至少固定：

- Workflow Ref、Definition hash 和 Compiler version。
- 每个 Node Type 的精确 type version。
- 每个 Preset Model Ref、compiled model hash 和 plugin lock hash。
- 每个 Plugin Operation 的 plugin id/version/package hash/operation version。
- 规范化节点和拓扑顺序。
- 已验证端口 Schema 和策略。
- Capability Manifest hash（用于审计，不作为唯一运行依赖）。
- Compiled hash。

运行前必须再次确认精确依赖未损坏；不可用时返回 `workflow_unavailable`，不得静默解析到新版本。

## 9. 生命周期、持久化和一致性

### 9.1 Workflow 生命周期

```text
draft → published → retired
```

- draft 可以删除。
- published 不可修改或删除。
- retired 不接受新 Run，但已有 Run、审计和导出仍可解析。
- publish 必须重新校验并重新编译；只有结果 valid 且 compiled hash 与保存快照一致才能原子发布。
- 不支持退回 draft。

### 9.2 建议表结构

```sql
CREATE TABLE workflows (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_versions (
  name TEXT NOT NULL REFERENCES workflows(name),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'retired')),
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  compiled_hash TEXT NOT NULL,
  capability_manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  PRIMARY KEY(name, version)
);

CREATE TABLE workflow_dependency_locks (
  workflow_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL,
  dependency_ref TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  PRIMARY KEY(workflow_name, workflow_version, node_id, dependency_kind),
  FOREIGN KEY(workflow_name, workflow_version)
    REFERENCES workflow_versions(name, version) ON DELETE CASCADE
);
```

第二阶段增加统一顶层 Run 表和 Workflow 专属明细表。`execution_runs` 与 `execution_run_events` 由统一 Run Control 拥有；Workflow Runtime 不得复制其中的身份、幂等、顶层状态或事件 sequence：

```sql
CREATE TABLE execution_runs (
  run_id TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES execution_runs(run_id),
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('preset_model', 'workflow')),
  target_ref TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  idempotency_key TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stopped_at TEXT,
  UNIQUE(client_id, runtime_kind, target_ref, idempotency_key)
);

CREATE TABLE execution_run_events (
  run_id TEXT NOT NULL REFERENCES execution_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);

CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY REFERENCES execution_runs(run_id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  compiled_hash TEXT NOT NULL,
  FOREIGN KEY(workflow_name, workflow_version)
    REFERENCES workflow_versions(name, version)
);

CREATE TABLE workflow_node_runs (
  node_run_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  usage_json TEXT,
  child_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(workflow_run_id, node_id, attempt)
);
```

数据库写入必须使用事务。Definition、dependency locks 和 compiled snapshot 必须同事务创建；publish 的状态变更和最终校验结果也必须同事务提交。创建 Workflow Run 时，`execution_runs` 与 `workflow_runs` 必须同事务写入；Node Run 只能引用已经存在的顶层 execution run。Preset Model 节点创建的 Agent Run 必须通过 `parent_run_id` 指向 Workflow Run，供 stop 传播、usage 聚合和审计追踪。

## 10. HTTP Interface

### 10.1 管理面

所有 `/api/manage/workflows*` 路由使用 Stage 0 统一后的 `X-AnomaloHaris-Admin-Token`。兼容期旧 Header 只在 Host 的 `LegacyNamingAdapter` 中读取并立即规范化；Workflow Runtime 不得知道旧 Header。

| Method | Path | 语义 |
| --- | --- | --- |
| `GET` | `/api/manage/workflow-capabilities` | 返回/下载当前 Capability Manifest |
| `POST` | `/api/manage/workflows/validate` | 无副作用校验任意 Definition |
| `POST` | `/api/manage/workflows/import` | 校验并导入为 draft |
| `GET` | `/api/manage/workflows` | 列出 draft/published/retired |
| `GET` | `/api/manage/workflows/:name/versions/:version` | 查看定义、状态、locks 和报告 |
| `GET` | `/api/manage/workflows/:name/versions/:version/export` | 下载 Workflow Definition JSON |
| `POST` | `/api/manage/workflows/:name/versions/:version/validate` | 重新校验已保存 draft |
| `POST` | `/api/manage/workflows/:name/versions/:version/publish` | 原子发布 |
| `POST` | `/api/manage/workflows/:name/versions/:version/retire` | 退役已发布版本 |
| `DELETE` | `/api/manage/workflows/:name/versions/:version` | 仅删除 draft |

上传使用 `application/json`；响应错误统一为现有 Host error envelope，`error_code` 使用稳定 code。下载响应必须设置安全文件名和 `Content-Disposition: attachment`。

### 10.2 运行面（第二阶段）

| Method | Path | 语义 |
| --- | --- | --- |
| `POST` | `/api/workflows/:name/versions/:version/runs` | 启动已发布 Workflow |
| `POST` | `/api/workflows/:name/versions/:version/runs/stream` | NDJSON 返回 Workflow events |
| `GET` | `/api/runs/:runId` | 通过统一 Run Control 查询状态和结果 |
| `GET` | `/api/runs/:runId/events` | 通过统一 Run Control 按 sequence 查询事件 |
| `POST` | `/api/runs/:runId/stop` | 通过统一 Run Control 幂等停止并传播取消 |

请求体：

```json
{
  "input": {},
  "idempotency_key": "urus-operation-123",
  "metadata": {
    "client_id": "urus"
  }
}
```

- ref 必须来自 URL 的精确 name/version，不接受 body 覆盖。
- input 必须满足 Workflow `input_schema`。
- 相同调用身份、Workflow Ref 和 idempotency key 必须返回同一 Run。
- 不允许运行 draft/retired。
- service token 应增加 workflow read/run scope，并支持限制可调用 Workflow refs、并发和预算；管理 token 不用于 Urus 的日常运行。

## 11. Runner 语义（第二阶段）

### 11.1 状态机

Workflow Run：

```text
queued → running → succeeded
                 → failed
                 → stopping → stopped
```

Node Run：

```text
pending → ready → running → succeeded
                           → failed
                           → skipped
                           → stopped
```

每次状态转换必须先持久化事件，再向流订阅者投影。事件至少包括：

```text
workflow.run.started
workflow.node.started
workflow.node.succeeded
workflow.node.failed
workflow.node.skipped
workflow.run.succeeded
workflow.run.failed
workflow.run.stopping
workflow.run.stopped
```

这些类型是统一 Run envelope 中的 Workflow payload。所有 Agent 与 Workflow 顶层事件共享：

```text
schema_version / run_id / parent_run_id? / runtime_kind / target_ref /
sequence / timestamp / type / data
```

`sequence` 只在单个 run 内单调。Child Agent Run 保留自己的事件流；Workflow Run 只记录 node 状态和 child run 引用，不复制完整 Agent event，避免重复存储和顺序歧义。

### 11.2 调度规则

- 使用编译后的稳定拓扑顺序决定同优先级节点启动顺序。
- 全局并发不得超过 Host 限制；单 Workflow 并发不得超过 Definition policy。
- `parallel` 只表达显式扇出，不绕过并发限制。
- `join` 必须等待其声明的所有非 skipped 上游达到终态。
- 默认 `fail_fast`：任一必需节点最终失败后不再启动新节点，并取消活动节点。
- stop 是幂等操作，必须传播到所有活动 child Agent Runs 和 Plugin Operations。
- Plugin Operation 超时必须使用声明值和 Workflow 上限中的较小者。

### 11.3 崩溃恢复

V1 不承诺从任意中间节点自动继续执行。Host 启动时：

- `queued` 可重新进入调度。
- 残留 `running/stopping` Run 标记为 `failed`，错误码 `WORKFLOW_HOST_RESTARTED`。
- 已有 child run id 和 node outputs 保留用于审计。
- 不自动重放可能产生外部副作用的 Plugin Operation。

未来若实现 checkpoint resume，必须基于节点幂等声明另写设计。

## 12. Workflow Tab 需求

Workflow Tab 是 Host 拥有的管理 UI，建议新增：

```text
frontend/src/workflows/Workflows.vue
frontend/src/workflows/workflowTransport.js
frontend/src/workflows/workflowTransport.test.js
```

### 12.1 第一阶段 UI

- 主导航新增 `Workflows` Tab。
- 能力区显示 runtime/adapter version、manifest hash、支持节点数、可用 Preset Models 数和可调用插件操作数。
- “导出能力清单”下载完整 Manifest。
- 工作流列表按 name/version 展示 draft/published/retired、definition hash、compiled hash 和更新时间。
- “导入工作流”支持选择 `.json` 文件和粘贴 JSON，两者进入同一校验流程。
- 导入前先显示 Validation Report；用户明确确认后才调用 import。
- 错误显示稳定 code、JSON Pointer、node id 和 message；支持复制报告 JSON。
- 详情页可查看规范化 Definition、依赖 locks、warnings 和 Manifest 差异。
- “导出工作流”只导出可移植 Definition，不导出 compiled snapshot、数据库 ID、凭据或运行历史。
- draft 支持重新校验、发布和删除；published 支持退役；retired 只读和导出。
- 所有 destructive action 使用明确确认；只有 draft 删除是真删除。

### 12.2 第二阶段 UI

- published Workflow 提供测试运行表单，根据 `input_schema` 生成基础字段或允许 JSON 输入。
- 显示 Workflow Run 状态、节点时间线、child run id、usage 和错误。
- 支持停止活动 Run。
- 支持下载运行输入、输出和事件，但必须执行敏感字段脱敏。
- 第一版不画可编辑流程图；只读 DAG 可视化 MAY 延后，不影响验收。

## 13. 安全与资源限制

- Workflow Runtime 和 Runtime Adapter 是受信任本地代码；Workflow JSON 一律按不可信输入处理。
- JSON 解析必须限制 body 大小、对象深度、数组长度、Schema 深度和表达式 AST 大小。
- 使用无原型对象或安全访问方式，拒绝 `__proto__`、`prototype` 和 `constructor` 等污染 key。
- 禁止远程 Schema `$ref` 和导入时网络访问。
- 导入不得触发插件加载或 package 安装。
- 插件操作必须显式 `workflow_callable`，并锁定 package/version/hash。
- Capability Manifest 不得泄露 prompt、credential、环境变量、文件路径或 private plugin config。
- Workflow Run 的 metadata 不得成为权限传递通道。
- service token 权限取调用者 scope、Workflow policy、Preset Model policy 和 Plugin Operation permission 的交集，不得扩大任一层权限。
- 日志默认记录 ref/hash/status/latency，不记录完整敏感 input/output；完整 payload 只进入受保护的 Run Store。

## 14. 可观测性与审计

每个 Workflow Run 必须记录：

- workflow ref、definition hash、compiled hash。
- capability manifest hash。
- client id、idempotency key 的安全 hash。
- 每个节点的 type/version、状态、attempt、延迟和错误码。
- Preset Model child run id、model ref、compiled model hash 和 usage。
- Plugin Operation 的精确 ref/package hash。
- stop 发起者和原因。

建议指标：

```text
workflow_runs_total{workflow_ref,status}
workflow_run_duration_seconds{workflow_ref}
workflow_node_runs_total{workflow_ref,node_type,status}
workflow_node_duration_seconds{workflow_ref,node_type}
workflow_validation_total{result,error_code}
workflow_import_total{result}
workflow_active_runs
```

不得将高基数 run id、node id 或 client-provided label 放入 metrics label。

## 15. Stage 0 与两阶段分阶段切片需求

Stage 0 是 Workflow 开发的强制前置 Gate，不计入后续两个功能阶段。Stage 0 未完成时，不得创建 Workflow contracts、package、数据库表、路由或 UI，以免新功能继续固化旧名称。

每个切片必须能独立 review、测试和回滚。不得用一个提交同时跨越 contracts、Registry、Runner、UI 和真实 Provider。

### Stage 0：AnomaloHaris 命名原子迁移

目标：仓库的当前代码、公开协议、新数据库写入、默认资源和测试全部只产生 `AnomaloHaris/anomaloharis`；旧名称只收敛在一个临时兼容 Adapter 和迁移材料中。

#### Slice 0.1：命名 ADR、清单和冻结规则

**Files**

- `docs/adr/0003-anomaloharis-canonical-naming.md`
- `CONTEXT.md`
- 全仓命名扫描 fixture 或检查脚本

**需求**

- ADR 明确 canonical 名称、旧名称清单、迁移方式、兼容期限和删除版本。
- 生成机器可检查的替换矩阵，不允许仅靠人工搜索。
- 修改 ADR-0002 和当前 Accepted design 中的默认 Model Ref 与技术命名；旧 ADR 历史段落可保留，但必须标注 historical。
- 增加 CI naming Gate：旧名称只能出现在 allowlist 指定的兼容 Adapter、迁移 fixture 和历史文档路径。

**验收**

- 清单覆盖 npm scope、import、Schema URI、Header、环境变量、默认 Model Ref、database filename/metadata、Docker、部署脚本、文档路径和 Urus 配置。
- CI 对任意新引入的非 allowlist `@anomalo/`、`anomalo.dev`、`ANOMALO_`、`X-Anomalo-` 或裸 `anomalo@` 失败。 <!-- naming-compat -->
- ADR 明确兼容 Adapter 的删除日期或目标版本，禁止永久双命名。

#### Slice 0.2：源码、package 和公开协议迁移

**Files**

- 根 `package.json`、所有 workspace `package.json`、`package-lock.json`
- `packages/contracts/*`
- `apps/*`、`frontend/*`
- Docker、部署脚本和环境模板

**需求**

- npm scope 从 `@anomalo/*` 原子迁移到 `@anomaloharis/*`，同步所有 import、exports 和测试 mock。 <!-- naming-compat -->
- Schema URI 从 `anomalo.dev/*` 迁移到 `anomaloharis.dev/*`。 <!-- naming-compat -->
- 环境变量规范化为 `ANOMALOHARIS_*`，内部配置对象不得保留旧字段。
- Header 输出只使用 `X-AnomaloHaris-*`；兼容读取集中在 `LegacyNamingAdapter`。
- user-agent、`owned_by`、日志 source、下载文件名和 UI 文案统一。
- 文档和集成文件名使用 `anomaloharis`，例如把 `urus-anomalo.md` 改为 `urus-anomaloharis.md`。 <!-- naming-compat -->

**验收**

- clean install、workspace build/typecheck/test 全部通过。
- contracts JSON Schema 导出只产生新 URI。
- 新旧 Header 输入兼容测试通过，但所有 response/header/export 只出现新名称。
- 除 allowlist 外，命名 Gate 无旧名称命中。

#### Slice 0.3：默认资源与持久化数据迁移

**Files**

- Preset Model Registry migration
- Session、Run、usage、idempotency 和 fixture 数据
- 默认配置和 Urus 集成配置

**需求**

- 内建默认 Preset Model 从 `anomalo@1` 迁移为 `anomaloharis@1`。 <!-- naming-compat -->
- 因 ref 参与 compiled snapshot/hash，迁移必须重新编译并更新所有关联 hash，不能只替换字符串。
- 在事务中迁移 Preset Model identity、Session binding、Run metadata、dependency locks 和默认配置。
- 迁移前自动备份目标 SQLite 文件；迁移可重复执行且结果幂等。
- 失败必须整体回滚，禁止数据库同时存在两个“默认 Agent”身份。
- 历史审计若必须保留原始输入，放入明确的 `legacy_ref` 字段；运行时解析和新写入只使用 canonical ref。

**验收**

- 旧数据库 fixture 升级后，所有活动引用都解析为 `anomaloharis@1`。
- compiled hash、plugin lock hash 和 Session binding 一致性检查通过。
- 第二次运行 migration 是 no-op。
- 故障注入验证事务回滚和备份恢复。
- 新建空数据库从未产生 `anomalo@1`。 <!-- naming-compat -->

#### Slice 0.4：调用方切换、兼容观察和 Gate

**Files**

- `docs/integrations/urus-anomaloharis.md`
- service-token 配置、部署清单和 smoke tests
- `LegacyNamingAdapter` telemetry

**需求**

- Urus 和其他已知调用方切换到新 Header、环境变量和 `anomaloharis@1`。
- 兼容 Adapter 对旧输入记录低基数 deprecated counter 和调用方标识，不记录 token。
- 发布前执行真实 chat、Preset Model、stream、WebSocket、管理 UI 和 Urus smoke。
- 达到 ADR 规定的兼容期限后删除 Adapter 和 allowlist；删除必须是独立可审查提交。

**验收**

- 所有已知调用方只发送新名称。
- 完整运行测试中没有旧名称的新写入和公开输出。
- 旧输入兼容路径有测试和告警，但不渗透到业务 Module。
- Stage 0 Gate 通过后才能合并任何 Workflow 功能 Slice。

#### Stage 0 Gate

- 全仓 canonical package scope 为 `@anomaloharis/*`。
- 所有当前 Schema、Header、环境变量和默认 Model Ref 使用 `anomaloharis`。
- 数据 migration 幂等、可回滚并经过旧数据库 fixture 验证。
- Urus 已切换并通过真实 smoke。
- CI naming Gate 生效。
- 旧名称只存在于明确 allowlist，且有删除版本；不存在“新旧名称长期双写”。

#### Stage 0 实施记录（2026-08-25）

Stage 0 的命名切片已经落地；Workflow contracts、Workflow Runtime package、数据库表、路由和 UI 在本 Gate 通过后按后续 Phase 1/Phase 2 记录继续实现：

- **0.1 已完成**：新增 `docs/adr/0003-anomaloharis-canonical-naming.md`、`CONTEXT.md` 和 `npm run check:naming`；检查脚本扫描 tracked/non-ignored working-tree 文件，并只允许兼容 Adapter、迁移脚本/测试和历史文档保留旧标识。
- **0.2 已完成**：workspace package、imports、Schema URI、Header 输出、环境模板、Docker/deployment、前端文案、Urus 文档路径和 runtime resource 已切换到 canonical 命名；`LegacyNamingAdapter` 集中处理旧 env/header/ref 输入，canonical 值优先；部署脚本仅保留旧数据目录和旧镜像 metadata 的只读发现兼容。
- **0.3 已完成**：`npm run migrate:naming --workspace @anomaloharis/node-host -- --data-dir <dir> [--apply]` 支持 dry-run、逐库备份、事务迁移、Preset Model 快照/Plugin Lock 重编译和失败恢复。当前本地 `data/` 已迁移为 `anomaloharis@1`，第二次 dry-run 为 no-op。
- **0.4 已完成（本地范围）**：Node Host、Buddy bridge/service 和 Urus 调用文档使用 canonical 输入；旧 env/header/ref 的兼容测试覆盖，Adapter telemetry 只记录低基数 key，不记录 token。真实部署 smoke 仍需在有 Urus service token 的环境执行。

本地 Gate 验证命令：

```text
npm run check:naming
npm run build --workspace @anomaloharis/contracts
npm run typecheck --workspace @anomaloharis/node-host
npm test --workspace @anomaloharis/contracts
npm test --workspace @anomaloharis/node-host
npm test --workspace @anomaloharis/buddy-bridge
npm test --workspace @anomaloharis/buddy-service
npm --prefix frontend run build
npm test --workspace anomaloharis-frontend
```

### Phase 1：可移植定义、能力清单和安全管理闭环

目标：Urus 已经可以获得准确能力清单、提交 Workflow JSON、得到完整校验结果，并由管理员完成 draft/publish/export 生命周期；本阶段不执行 Workflow。

#### Slice 1.1：Contracts 与 fixtures

**Files**

- `packages/contracts/src/workflows.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/validation.ts`
- `packages/contracts/schemas/workflow-*.schema.json`
- `packages/contracts/fixtures/workflows/*.json`

**需求**

- 实现 Definition、Capability Manifest、Validation Report、Summary 和 Import Result Schema。
- 导出 canonical valid/invalid fixtures。
- 明确 stable error codes 和 JSON Pointer 格式。
- 不修改现有 Agent/Preset Model contract 行为。

**验收**

- contracts build/typecheck/test 通过。
- 导出的 JSON Schema 可被独立 Ajv 实例加载。
- 每个 invalid fixture 只命中预期错误集合。
- canonical JSON/hash fixture 跨重启稳定。

#### Slice 1.2：Workflow Runtime 管理面骨架与 Registry

**Files**

- `apps/workflow-runtime/*`
- `apps/node-host/src/main.ts`

**需求**

- 建立 `@anomaloharis/workflow-runtime` package、管理 Interface 和稳定 runtime identity `workflow-runtime`。
- 实现 SQLite Registry、draft/import/list/get/export/delete。
- Host 通过 WorkflowManagement Seam 注入 Runtime 的管理能力；第一阶段不得注册执行 Runtime Adapter。
- 同 ref/hash 导入幂等，不同 hash 冲突。

**验收**

- in-memory SQLite 生命周期测试通过。
- 进程重启后 Definition/compiled hash 稳定。
- published/retired 不可覆盖；只有 draft 可删除。
- Workflow Runtime 未配置时 Host 返回明确 `workflow_unavailable`，Agent Runtime 和其他功能不受影响。

#### Slice 1.3：Capability Catalog、Validator 与 Compiler

**Files**

- `apps/workflow-runtime/src/capability-catalog.ts`
- `apps/workflow-runtime/src/validator.ts`
- `apps/workflow-runtime/src/compiler.ts`
- `apps/node-host/src/plugins.ts`

**需求**

- 聚合 Node Types、已发布 Preset Models 和 workflow-callable Plugin Operations。
- 实现分层校验、稳定报告、dependency locks 和 compiled snapshot。
- 扩展插件能力声明，但保持旧插件默认不可直接编排。
- validate 和 import 复用同一 Implementation。

**验收**

- 图环路、不可达节点、错误端口、Schema 不兼容、缺失依赖和权限错误均有测试。
- Manifest 排序/hash 稳定且不泄密。
- 无关 Manifest 变化只告警；精确依赖缺失阻止导入/发布。
- validate 不产生数据库写入或插件调用。

#### Slice 1.4：Host 管理路由

**Files**

- `apps/node-host/src/workflow-api.ts`
- `apps/node-host/src/host.ts`
- `apps/node-host/src/host.test.ts`

**需求**

- 实现第 10.1 节全部管理路由。
- 复用现有 management token 和错误 envelope。
- 支持安全 JSON 下载文件名和 content disposition。
- publish 在事务内重新校验。

**验收**

- 缺少/错误 admin token 为 403。
- invalid import 不写库；conflict 为 409；幂等导入为 200。
- 管理路由 Fastify inject 测试覆盖所有 lifecycle。
- 现有 host/compute 测试无回归。

#### Slice 1.5：Workflow Tab

**Files**

- `frontend/src/workflows/*`
- `frontend/src/App.vue`
- `frontend/src/management/managementAccess.js`

**需求**

- 实现第 12.1 节 UI。
- 文件上传和粘贴共享 transport/validation path。
- 导出 Manifest 与导出 Definition 是两个独立操作。
- UI 不自行复制后端图校验规则；只做 JSON parse 和展示。

**验收**

- frontend unit tests 覆盖导入确认、错误定位、下载、publish/retire/delete 权限。
- 浏览器 E2E 完成：导出 Manifest → 导入 fixture → 看到报告 → 创建 draft → 发布 → 导出 Definition。
- 管理 token 过期时复用现有登录提示。

#### Phase 1 Gate

- Urus 能仅凭导出的 Manifest 构造一份有效 fixture。
- 相同 fixture 可幂等导入并导出等价 canonical Definition。
- 不支持的节点或依赖在发布前被拒绝。
- 发布版本不可修改或删除。
- 所有现有 workspace tests/build 通过。
- 本阶段不存在可访问的 Workflow run route，避免“管理完成即被误认为执行完成”。

#### Phase 1 实施记录（`feat/agent-workflow-runtime-phase1-2`，2026-08-25）

当前分支已完成 Phase 1 的代码切片；Phase 2 在同一分支继续实现，执行面代码已落地但仍需完成真实 Provider、浏览器 E2E 和 Urus 集成 Gate：

- **1.1 已完成**：`@anomaloharis/contracts` 新增 Workflow Definition、Capability Manifest、Validation Report、Summary、Import Result Schema、canonical hash 辅助函数和 valid/invalid fixtures；contracts 的 Ajv registry 与导出 Schema 已覆盖新合同。
- **1.2 已完成**：新增 `@anomaloharis/workflow-runtime`，包含 `workflow-runtime` identity、SQLite Registry、draft import/list/get/export/delete、publish/retire 生命周期、dependency locks 和重启后 hash 稳定性。
- **1.3 已完成（管理面范围）**：Runtime 内置 V1 Node Type Catalog、无副作用 Validator、DAG/端口/可达性/Schema/精确 Preset Model 与 workflow-callable Plugin Operation 校验、Compiled Snapshot；PluginHost capability declaration 增加显式 `workflow_callable` operation 合同，旧 capability 默认不可编排。
- **1.4 已完成**：Node Host 通过独立 `WorkflowManagement` Seam 注册全部 Phase 1 管理路由，使用统一管理 token/error envelope 语义；Runtime 未配置时返回 `workflow_unavailable`，未注册任何执行路由。
- **1.5 已完成（管理 UI）**：新增 Workflows Tab、Manifest/Definition 下载、文件或粘贴导入、后端校验报告展示、draft/publish/retire/delete 和 Definition 详情；UI 没有复制后端图校验规则。

本阶段管理面验证：contracts 7 tests、Workflow Runtime 3 tests、Node Host 90 tests、Buddy bridge 4 tests、Buddy service 16 tests、frontend 41 tests、canonical naming Gate 和三个 TypeScript typecheck 均通过。真实浏览器 E2E 与 Phase 2 执行面不在这段 Phase 1 记录中提前宣称完成。

### Phase 2：版本化执行、节点调度和运行观测闭环

目标：调用方可以按精确 `workflow-name@version` 提交数据，Runner 复用现有 Agent/Plugin 执行链完成 DAG，并获得持久化事件、结果、取消和审计。

#### Slice 2.1：统一 Run Control、Runtime Adapter 与持久化状态机

**Files**

- `packages/contracts/src/workflow-runs.ts`
- `apps/node-host/src/run-control.ts`
- `apps/node-host/src/runtime-catalog.ts`
- `apps/node-host/src/agent-runtime-adapter.ts`
- `apps/node-host/src/workflow-runtime-adapter.ts`
- `apps/workflow-runtime/src/store.ts`
- `apps/workflow-runtime/src/runner.ts`

**需求**

- 增加统一 Run envelope 以及 Workflow 专属 Request/Response/Event payload Schema。
- 将现有 Agent RunService 深化为统一 Run Control，并以 Agent Runtime Adapter 保持现有调用行为。
- 实现 execution_runs、execution_run_events、workflow_runs 和 workflow_node_runs。
- 顶层合法状态转换、sequence 和 idempotency 只能由 Run Control 实现。
- 先使用 fake node Adapter，不接真实 AgentCore。

**验收**

- 非法状态转换被拒绝。
- Agent 与 Workflow 对相同 client/target/idempotency key 都返回同一 Run。
- 事件 sequence 单调且重启后可查询。
- 崩溃恢复按第 11.3 节收敛终态。
- 现有 chat、Preset Model 和 native Run Interface 经 Agent Runtime Adapter 无回归。
- Agent 与 Workflow Runtime Adapter 必须通过同一 Run Control conformance suite。
- 静态依赖 Gate 验证 AgentCore 不 import Workflow Runtime、Workflow Definition、Node Run 或 DAG 类型。

#### Slice 2.2：确定性 DAG 调度节点

**Files**

- `apps/workflow-runtime/src/nodes/input.ts`
- `apps/workflow-runtime/src/nodes/output.ts`
- `apps/workflow-runtime/src/nodes/condition.ts`
- `apps/workflow-runtime/src/nodes/parallel.ts`
- `apps/workflow-runtime/src/nodes/join.ts`

**需求**

- 实现 input/output/condition/parallel/join。
- 实现并发上限、fail_fast、skip 和 stop 传播。
- 运行前和 output 后分别校验 input/output Schema。

**验收**

- 相同 compiled graph 和 input 产生相同调度顺序。
- 并发从不超过较小的 Host/Workflow limit。
- true/false 分支和 join skip 语义有组合测试。
- stop 不再启动新节点，活动 fake nodes 收到 AbortSignal。

#### Slice 2.3：Preset Model Adapter

**Files**

- `apps/node-host/src/workflow-runtime-adapter.ts`
- `apps/node-host/src/agent-execution-adapter.ts`
- `apps/workflow-runtime/src/nodes/preset-model.ts`
- 统一 Run Control 与现有 AgentCore wiring

**需求**

- `preset_model` 节点通过 AgentExecution Interface 执行，生产 Adapter 受控创建 child Agent Run。
- 固定 Model Ref、compiled model hash 和 plugin locks。
- child run id、usage、错误和取消向 Workflow Run 投影。
- 不复制 ProviderGateway 或 tool loop。

**验收**

- fake Provider 集成测试验证 child run 关联和 structured output。
- 真实 Provider Gate 至少执行一个两节点 Workflow，其中一个 Preset Model 真实产生 tool call。
- Preset Model 依赖损坏时为 `workflow_unavailable`，不自动升级。
- stop 可以终止活动 child Agent Run。

#### Slice 2.4：Plugin Operation Adapter

**Files**

- `apps/node-host/src/plugins.ts`
- `apps/node-host/src/workflow-runtime-adapter.ts`
- `apps/workflow-runtime/src/nodes/plugin-operation.ts`

**需求**

- 只调用已锁定且 `workflow_callable` 的 operation。
- 执行前后验证 input/output Schema。
- 传播 timeout、AbortSignal、权限和幂等键。
- 插件熔断或 hash 不匹配使节点失败，不 fallback 到同名工具。

**验收**

- 未声明 workflow_callable 的现有工具不能被调用。
- package hash/version/operation version mismatch 均在运行前失败。
- timeout、熔断、output Schema 错误和取消有集成测试。

#### Slice 2.5：运行 HTTP Interface 与 Workflow Tab 观测

**Files**

- `apps/node-host/src/workflow-api.ts`
- `frontend/src/workflows/*`

**需求**

- 实现第 10.2 节运行路由和 NDJSON events。
- 增加 service-token workflow scopes 和 ref allowlist。
- UI 实现测试运行、节点时间线、stop、输入输出和错误展示。

**验收**

- draft/retired run 返回稳定错误。
- idempotent run、stream 断线重连和 after-sequence 查询通过。
- 浏览器 E2E：选择 published Workflow → 输入数据 → 查看节点运行 → 获得结果；另覆盖 stop。
- Urus 使用 service token 完成一次端到端调用，管理 token 不出现在调用链。

#### Phase 2 Gate

- `workflow-name@version` 是唯一运行身份，body 无法覆盖。
- 至少一个包含 condition + parallel/join + Preset Model 的 Workflow 通过真实端到端测试。
- 至少一个显式 workflow-callable Plugin Operation 通过版本锁和权限测试。
- stop、timeout、fail_fast、idempotency、Host restart 都有持久化验证。
- Run 和 Node Run 可以从 UI 与 Interface 追踪到 child Agent Run。
- 现有 Preset Model、chat、stream、PluginHost 和 frontend E2E 无回归。

#### Phase 2 实施记录（`feat/agent-workflow-runtime-phase1-2`，2026-08-25）

本分支已完成 Phase 2 的第一轮可运行切片：

- **2.1 已完成**：新增统一 `execution_runs`、`execution_run_events`、`workflow_runs`、`workflow_node_runs` 持久化模型；`RunControl` 独占顶层身份、状态转换、事件 sequence、幂等、stop、Host restart recovery、全局执行容量和 usage 聚合；Agent 与 Workflow 通过带 version/package hash/capability/health 的 Runtime Adapter 接入同一运行控制面。普通 chat、stream、WebSocket、OpenAI-compatible 和 Preset Model run/resume 的新运行均强制经过 Run Control，旧 `native_runs` 仅保留只读历史兼容。
- **2.2 已完成**：`WorkflowRunner` 按编译后的稳定拓扑顺序调度 input/output/condition/parallel/join，执行 Host/Workflow 较小并发上限、fail-fast、skip、stop、retry 和边界 Schema 校验；节点状态和 attempt 持久化。retry 只接受节点 Adapter 明确标记为 retryable 的错误，缺失 Preset Model/Plugin Operation Adapter 时稳定失败，不存在生产 fake fallback。
- **2.3 已完成（fake Provider 集成范围）**：`preset_model` 节点通过 Agent Runtime Adapter 创建带 `parent_run_id` 的 child Agent Run，锁定 Preset Model compiled hash，结构化输出、child id、失败和停止结果投影回 Workflow Node Run。
- **2.4 已完成**：Plugin Operation 只允许调用显式 `workflow_callable` 声明且匹配 operation/version/package hash 的实现；执行前后 Schema 校验，传递权限声明、幂等键、AbortSignal 和超时，不回退到同名工具。
- **2.5 已完成（运行 Interface/UI 基础范围）**：新增 exact `name@version` 的 Workflow run、NDJSON stream、Run 查询、after-sequence 事件回放和 stop 路由；增加 service-token workflow scope/ref allowlist；Workflow Tab 支持 published Workflow 测试运行、节点事件时间线、停止、结果和错误展示。

本切片自动化验证覆盖：统一 Run Control 状态/幂等/回放/恢复、DAG condition + parallel/join、Preset Model child run、显式 Plugin Operation、Workflow run API/service auth、contracts、Workflow Runtime、Node Host、Buddy bridge/service、frontend tests，以及 contracts/Workflow Runtime/Node Host/frontend build/typecheck。以下仍属于 Phase 2 Gate 的外部验证，不在本记录中虚报完成：真实 Provider tool-call Workflow、真实浏览器 E2E、Urus service-token 端到端调用和部署环境重启演练。

开发完成前架构审查补充验证：stop 只在 Runtime Adapter 与活动 child/plugin 执行收敛后提交顶层终态；ChildRunControl 从父 Workflow Run 派生 client id 并只允许收紧权限；Runtime Adapter identity 随 Run 持久化并在 queued recovery 时校验；`npm run check:runtime-architecture` 静态阻止 AgentCore 反向依赖 Workflow Runtime，以及 Host/compute 绕过 Run Control 直接启动 AgentCore。

## 16. 建议提交顺序

```text
docs: decide anomaloharis canonical naming
refactor: migrate packages and contracts to anomaloharis
refactor: migrate persisted identities to anomaloharis
chore: switch callers and enforce canonical naming
feat: add workflow definition contracts and fixtures
feat: add workflow runtime registry and draft lifecycle
feat: compile workflows against exported capabilities
feat: expose workflow management routes
feat: add workflow management tab
refactor: deepen agent run service into unified run control
feat: register workflow runtime adapter
feat: persist workflow node state and events
feat: schedule deterministic workflow dags
feat: execute preset model workflow nodes
feat: execute locked workflow plugin operations
feat: add workflow run routes and ui tracing
```

每个提交必须保持 workspace build/test 可通过；不得在 contracts 未落地前在 Host 或 UI 手写重复类型。

## 17. Luna 实现纪律

1. 开工前先阅读 ADR-0002、ADR-0004、Stage 0 命名 ADR、本文和 `docs/design/node-preset-model-compute-center.md`；Stage 0 Gate 未通过时不得开始 Workflow 功能代码。
2. 不得修改用户当前未提交的 Web search 更改，除非另有明确任务。
3. 先写 contract/fixture，再写 Workflow Runtime Implementation；第二阶段先深化统一 Run Control 和 Agent Runtime Adapter，再接 Workflow Runtime Adapter，最后接 UI。
4. 不得把 Workflow 逻辑继续堆进 `host.ts` 或 `compute-api.ts`。
5. 不得让 Workflow Runtime 或 Runtime Adapter 直接持有 Fastify、Vue、Provider credential 或具体 SQLite Preset Model class。
6. 不得将 validate 和 import 实现成两套规则。
7. 不得把 Manifest hash mismatch 一概视为不兼容；必须解析精确依赖。
8. 不得把插件 tool listing 当作 workflow-callable 证明。
9. 不得以 mock DAG 通过代替真实 Provider + tool-call Gate。
10. 每个 Slice 完成后更新本文对应 checklist 或新增实施记录，不得只口头宣称完成。

## 18. 完成定义

本方案只有在以下条件全部满足时才算完成：

- Workflow Runtime 是与 AgentCore 平级的独立深 Module，Host 只通过 WorkflowManagement 和 Runtime Adapter Seam 使用它。
- Workflow Definition 与所有可执行 Runtime/插件代码严格分离。
- Capability Manifest 可导出、稳定、机器可读且不泄密。
- 导入前校验、导入 draft、发布、退役、删除 draft 和导出均符合生命周期。
- 已发布 Workflow 和所有依赖都由精确版本与 hash 固定。
- Agent 与 Workflow 共用唯一 Run Control；WorkflowRunner 通过 AgentExecution Interface 复用 AgentCore，并通过 PluginOperation Adapter 使用 PluginHost，没有第二套运行基础设施或 Agent loop。
- Urus 通过 Manifest 设计、通过 JSON 交付、通过 `workflow-name@version` 运行的全链路 E2E 通过。
- 两阶段 Gate 和现有 Node-only/Preset Model Gate 均通过。
- UI、contracts、数据库、错误码、事件和审计使用本文统一术语。
