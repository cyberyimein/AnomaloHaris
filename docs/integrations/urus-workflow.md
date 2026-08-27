# Urus → AnomaloHaris Workflow 对接

> 适用版本：Workflow Definition `anomaloharis.dev/workflow/v1`、Capability Manifest `anomaloharis.dev/workflow-capabilities/v1`
>
> 本文描述 Urus 使用已注册 Workflow 的完整流程：获取能力清单、提交 Definition、校验、导入 draft、发布和运行。本文不定义“在一次请求中携带临时 Workflow Definition 并立即执行”；该模式不受支持。

如果 Urus 仍然是调用单个 Preset Model（例如
`scheduled-event-investigator@1`），请继续使用
[`urus-anomaloharis.md`](./urus-anomaloharis.md)。本文件描述的是 Workflow Runtime
的 `/api/workflows/...` 接口，两者不要混用。

## 1. 对接边界

AnomaloHaris 负责：

- 导出当前实例的 Workflow Capability Manifest。
- 校验并保存 Urus 提交的声明式 JSON。
- 将有效 Definition 保存为 `draft`，由管理员发布为不可变的 `name@version`。
- 按已发布的 Workflow Ref 执行，并通过统一 Run Control 返回 Run、事件、取消和审计信息。

Urus 负责：

- 根据 Manifest 中的节点、Preset Model 和 Plugin Operation 编排 Definition。
- 在 Definition 中引用精确的 `name@version`，不能使用 `latest` 或只有名称的引用。
- 为每一次业务操作生成稳定的幂等键，并保存 Workflow Ref、Run ID 和最后事件序号。
- 在连接中断后查询原 Run，而不是盲目创建新 Run。

Workflow JSON 是不可信的声明式数据，不得包含 JavaScript、Provider credential、system
prompt、插件路径、远程 `$ref` 或其他可执行内容。

## 2. 地址和认证

以下示例使用环境变量：

```bash
export ANOMALOHARIS_BASE_URL="https://anomaloharis.example.internal"
export ANOMALOHARIS_ADMIN_TOKEN="<management-token>"
export URUS_WORKFLOW_TOKEN="<workflow-service-token>"
```

实际部署应通过私有网络或已认证的反向代理访问 Host，并通过 Secret Store 注入 token；不要
把 token 写入 Workflow JSON、代码仓库、Manifest 或日志。

### 2.1 管理面 token

以下操作使用 `X-AnomaloHaris-Admin-Token`：

- `GET /api/manage/workflow-capabilities`
- `POST /api/manage/workflows/validate`
- `POST /api/manage/workflows/import`
- Workflow 列表、详情、导出、重新校验、发布、退役和删除

```http
X-AnomaloHaris-Admin-Token: <management-token>
```

管理 token 只用于受控的 Workflow 注册流程。Urus 的日常运行不应持有管理 token。

### 2.2 Urus service token

运行面使用：

```http
Authorization: Bearer <workflow-service-token>
```

至少需要以下 scope：

| 操作 | Scope |
| --- | --- |
| 启动 Workflow、停止自己的 Run | `workflow:run` |
| 查询自己的 Run 和事件 | `workflow:read` |

生产环境建议为 Urus 配置单独的 service client，并限制可调用的 Workflow Ref：

```bash
ANOMALOHARIS_SERVICE_TOKENS='[
  {
    "id": "urus",
    "token": "<secret-from-secret-store>",
    "scopes": ["workflow:read", "workflow:run"],
    "workflow_refs": ["daily-event-review@1"]
  }
]'
```

`workflow_refs` 是该 client 的 allowlist；省略或设为空表示不增加 client 级别的 Ref 限制，
但仍受 Host 的 `ANOMALOHARIS_WORKFLOW_ALLOWED_REFS`（逗号分隔）限制。调用身份、Host
allowlist、Workflow policy、Preset Model policy 和 Plugin Operation permission 取交集，
不会因为 Workflow metadata 而扩大权限。

只设置 `ANOMALOHARIS_SERVICE_TOKEN` 的兼容配置默认只有旧的
`compute:models`、`compute:invoke` 和 `compute:read` scope，不能直接作为 Workflow service
token 使用。需要 Workflow 调用时使用上面的 `ANOMALOHARIS_SERVICE_TOKENS` 配置，明确授予
`workflow:read` 和 `workflow:run`。

## 3. 获取 Capability Manifest

Manifest 是 Urus 设计 Definition 的唯一能力来源。它描述当前实例支持的：

- `node_types`：节点类型、版本、配置 Schema、输入/输出端口。
- `preset_models`：当前已发布且可解析的精确 Preset Model Ref 及 hash。
- `plugin_operations`：显式声明 `workflow_callable` 的插件操作及输入/输出 Schema、权限、
  超时和幂等语义。
- `limits`：DAG、节点/边数量、并行度和最长运行时间。
- `unsupported_features`：当前不能编排的能力，例如 `loop`、`wait`、`approval` 和
  `subworkflow`。

获取并保存 Manifest：

```bash
curl --fail-with-body --silent --show-error \
  -H "X-AnomaloHaris-Admin-Token: ${ANOMALOHARIS_ADMIN_TOKEN}" \
  "${ANOMALOHARIS_BASE_URL}/api/manage/workflow-capabilities?download=true" \
  -o anomaloharis-workflow-capabilities.json
```

Urus 应在编排时保存 `manifest_hash`，并将它写入 Definition 的可选字段：

```json
{
  "compatibility": {
    "authored_against_manifest_hash": "sha256:<64-lowercase-hex-chars>"
  }
}
```

Manifest hash 变化本身只产生兼容性 warning；导入时仍会按 Definition 中的精确依赖重新
解析。Urus 必须以实际返回的 `preset_models` 和 `plugin_operations` 为准，不能仅凭历史
Manifest 猜测能力。

> 当前 Host 的 Manifest 路由属于管理面，使用 admin token；Workflow Tab 也通过该路由提供
> 下载。不要把 admin token 放进 Urus 的运行服务。如果需要 Urus 自动拉取 Manifest，应由
> 受控的集成/发布服务代理该管理操作；直接面向 Urus 暴露独立只读 Manifest 路由需要单独的
> 服务端变更。

## 4. 编写 Workflow Definition

### 4.1 必须满足的合同

- `metadata.name`：`^[a-z][a-z0-9-]{0,63}$`。
- `metadata.version`：正整数；发布后不可修改。
- `spec.nodes`：最多 100 个节点；`spec.edges`：最多 400 条边。
- 必须恰好有一个 `input` 节点和一个 `output` 节点；所有节点必须从入口可达并能到达出口。
- V1 只支持 DAG，不支持环路、循环、等待、人工审批或子工作流。
- 所有边都必须引用 Manifest 中声明的端口，且输入/输出 Schema 可赋值。
- `preset_model` 必须引用 Manifest 中已发布的精确 Preset Model Ref。
- `plugin_operation` 必须引用 Manifest 中的精确 `operation_id` 和 `operation_version`。
- Definition 不得覆盖 Preset Model 的 provider、prompt、plugins、tools、credential 或
  runtime policy。

### 4.2 V1 节点类型

| 类型 | 用途 | 关键配置 |
| --- | --- | --- |
| `input` | 唯一运行入口 | `{}` |
| `output` | 唯一运行出口 | `{}` |
| `preset_model` | 调用已发布 Preset Model | `model_ref`，可选 `input_mode: "message"`、`session_mode: "isolated"` |
| `condition` | 受限 AST 条件分支 | `expression` |
| `parallel` | 显式扇出 | `{}` |
| `join` | 等待并聚合多分支 | `{}` |
| `plugin_operation` | 调用 workflow-callable 插件操作 | `operation_id`、`operation_version` |

### 4.3 Urus 可导入的最小示例

下面的示例把一个请求交给 Urus 专用 Preset Model。`scheduled-event-investigator@1` 必须
出现在当前 Manifest 的 `preset_models` 中；如果实例使用其他已发布模型，Urus 应替换
`model_ref`，而不是让调用方覆盖它。

保存为 `daily-event-review-v1.json`：

```json
{
  "api_version": "anomaloharis.dev/workflow/v1",
  "kind": "Workflow",
  "metadata": {
    "name": "daily-event-review",
    "version": 1,
    "description": "Review a scheduled event through the Urus retrieval Preset Model.",
    "labels": {
      "owner": "urus"
    }
  },
  "spec": {
    "input_schema": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": ["message"],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object"
    },
    "nodes": [
      {
        "id": "input",
        "type": "input",
        "type_version": 1,
        "config": {}
      },
      {
        "id": "review",
        "type": "preset_model",
        "type_version": 1,
        "config": {
          "model_ref": "scheduled-event-investigator@1",
          "input_mode": "message",
          "session_mode": "isolated"
        },
        "retry": {
          "max_attempts": 1,
          "backoff_ms": 0
        }
      },
      {
        "id": "output",
        "type": "output",
        "type_version": 1,
        "config": {}
      }
    ],
    "edges": [
      {
        "from": {
          "node": "input",
          "port": "data"
        },
        "to": {
          "node": "review",
          "port": "input"
        }
      },
      {
        "from": {
          "node": "review",
          "port": "output"
        },
        "to": {
          "node": "output",
          "port": "result"
        }
      }
    ],
    "policy": {
      "timeout_seconds": 900,
      "max_parallelism": 1,
      "failure_mode": "fail_fast"
    }
  }
}
```

## 5. 校验、导入和发布

校验没有副作用，不会创建 Workflow、启动 Run、调用插件或安装依赖。导入与校验使用同一
套规则；导入成功后一定先是 `draft`，不会自动发布。

### 5.1 无副作用校验

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "X-AnomaloHaris-Admin-Token: ${ANOMALOHARIS_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @daily-event-review-v1.json \
  "${ANOMALOHARIS_BASE_URL}/api/manage/workflows/validate"
```

成功响应：

```json
{
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": [],
    "resolved_dependencies": [
      {
        "node_id": "review",
        "dependency_kind": "preset_model",
        "dependency_ref": "scheduled-event-investigator@1",
        "dependency_hash": "sha256:<64-lowercase-hex-chars>"
      }
    ],
    "definition_hash": "sha256:<64-lowercase-hex-chars>",
    "capability_manifest_hash": "sha256:<64-lowercase-hex-chars>",
    "compiled_hash": "sha256:<64-lowercase-hex-chars>"
  }
}
```

`valid=false` 时，优先根据 `errors[].path`、`errors[].code` 和 `errors[].node_id` 修正
Definition。错误 code 是机器合同，不能依赖 message 文本做分支。

### 5.2 导入为 draft

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "X-AnomaloHaris-Admin-Token: ${ANOMALOHARIS_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @daily-event-review-v1.json \
  "${ANOMALOHARIS_BASE_URL}/api/manage/workflows/import"
```

响应包含 `workflow`、`validation` 和 `idempotent`：

- 新的 `name@version`：HTTP `201`，保存为 `draft`。
- 相同 Definition hash 再次导入：HTTP `200`，`idempotent: true`。
- 相同 Ref 但 Definition hash 不同：HTTP `409`，错误码为 `workflow_version_conflict`。
- 已发布或已退役的 Ref 不可覆盖。

### 5.3 发布

导入后由管理员确认校验报告，再发布：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "X-AnomaloHaris-Admin-Token: ${ANOMALOHARIS_ADMIN_TOKEN}" \
  "${ANOMALOHARIS_BASE_URL}/api/manage/workflows/daily-event-review/versions/1/publish"
```

只有 `published` Workflow 可以运行。发布后不得修改 Definition、精确依赖或 policy；任何
修改都必须增加版本，例如 `daily-event-review@2`。退役使用：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "X-AnomaloHaris-Admin-Token: ${ANOMALOHARIS_ADMIN_TOKEN}" \
  "${ANOMALOHARIS_BASE_URL}/api/manage/workflows/daily-event-review/versions/1/retire"
```

退役后不接受新 Run，但历史 Run、审计和 Definition 仍可查询和导出。

### 5.4 自动化注册的边界

当前注册接口属于管理面，校验、导入、发布都需要 admin token。推荐的生产流程是：

```text
Urus 生成并提交 JSON
  → 发布流水线或 AnomaloHaris 管理员校验
  → import draft
  → 人工/策略审批
  → publish
  → 将 workflow ref 和 compiled hash 回传 Urus
```

不要把 admin token 作为 Urus 运行 token 长期保存。若以后需要 Urus 自动注册，应新增独立
的受限发布服务或明确的 `workflow:manage` scope；不能让现有 `workflow:run` token 获得
管理权限。

## 6. 运行已发布 Workflow

### 6.1 非流式运行

非流式接口会等待 Workflow 到达终态，适合单次任务或 Urus 能接受较长 HTTP 请求的场景：

```bash
export URUS_OPERATION_ID="scheduled-event-2026-08-26T09:00:00+09:00"
export URUS_IDEMPOTENCY_KEY="urus-${URUS_OPERATION_ID}"

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${URUS_WORKFLOW_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "${ANOMALOHARIS_BASE_URL}/api/workflows/daily-event-review/versions/1/runs" <<JSON
{
  "input": {
    "message": "Discover and verify today's scheduled events for the configured markets. Return the agreed event JSON."
  },
  "idempotency_key": "${URUS_IDEMPOTENCY_KEY}",
  "metadata": {
    "client_id": "urus",
    "operation_id": "${URUS_OPERATION_ID}"
  }
}
JSON
```

请求体只有三部分：

- `input`：必须满足 Definition 的 `spec.input_schema`。
- `idempotency_key`：建议必填，长度 1–255；应稳定绑定 Urus 的业务操作。
- `metadata`：用于追踪的非敏感业务元数据；不能用来传递权限或覆盖 Workflow 配置。

典型成功响应的外层结构：

```json
{
  "run": {
    "run_id": "run_...",
    "runtime_kind": "workflow",
    "target_ref": "daily-event-review@1",
    "target_hash": "sha256:<compiled-hash>",
    "client_id": "urus",
    "status": "succeeded",
    "input": {
      "message": "..."
    },
    "output": {},
    "usage": {},
    "created_at": "2026-08-26T00:00:00.000Z",
    "started_at": "2026-08-26T00:00:00.000Z",
    "finished_at": "2026-08-26T00:01:00.000Z"
  },
  "events": [
    {
      "schema_version": 1,
      "run_id": "run_...",
      "runtime_kind": "workflow",
      "target_ref": "daily-event-review@1",
      "sequence": 1,
      "timestamp": "2026-08-26T00:00:00.000Z",
      "type": "run.queued",
      "data": {
        "status": "queued"
      }
    }
  ]
}
```

实际 `events` 还会包含 `workflow.node.started`、`workflow.node.succeeded`、
`workflow.node.failed`、`workflow.node.skipped` 和终态事件。Preset Model 节点成功事件
可能包含 `child_run_id` 和 `usage`。

### 6.2 流式运行

长任务或需要实时状态时使用：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${URUS_WORKFLOW_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "input": {"message": "Run the scheduled-event review."},
    "idempotency_key": "urus-scheduled-event-2026-08-26T09:00:00+09:00",
    "metadata": {"client_id": "urus"}
  }' \
  "${ANOMALOHARIS_BASE_URL}/api/workflows/daily-event-review/versions/1/runs/stream"
```

响应是 `application/x-ndjson`，每行一个统一 Run Control 事件。下面只展示事件类型顺序
示意；实际 `sequence`、时间和 `data` 以服务端返回为准：

```json
{"schema_version":1,"run_id":"run_...","runtime_kind":"workflow","target_ref":"daily-event-review@1","sequence":1,"timestamp":"2026-08-26T00:00:00.000Z","type":"run.queued","data":{"status":"queued"}}
{"schema_version":1,"run_id":"run_...","runtime_kind":"workflow","target_ref":"daily-event-review@1","sequence":2,"timestamp":"2026-08-26T00:00:00.000Z","type":"workflow.run.started","data":{"workflow_ref":"daily-event-review@1","compiled_hash":"sha256:<compiled-hash>"}}
{"schema_version":1,"run_id":"run_...","runtime_kind":"workflow","target_ref":"daily-event-review@1","sequence":3,"timestamp":"2026-08-26T00:00:00.000Z","type":"workflow.node.started","data":{"node_id":"input","attempt":1}}
{"schema_version":1,"run_id":"run_...","runtime_kind":"workflow","target_ref":"daily-event-review@1","sequence":4,"timestamp":"2026-08-26T00:01:00.000Z","type":"workflow.run.succeeded","data":{"output":{}}}
{"schema_version":1,"run_id":"run_...","runtime_kind":"workflow","target_ref":"daily-event-review@1","sequence":5,"timestamp":"2026-08-26T00:01:00.000Z","type":"run.succeeded","data":{"status":"succeeded"}}
```

以 `run_id` 和 `sequence` 为准，不要以网络到达顺序之外的字段推断状态。客户端断线后
使用 Run 查询和事件查询恢复。

### 6.3 查询 Run 和事件

查询 Run：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${URUS_WORKFLOW_TOKEN}" \
  "${ANOMALOHARIS_BASE_URL}/api/runs/${RUN_ID}"
```

从某个 sequence 之后继续获取事件：

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${URUS_WORKFLOW_TOKEN}" \
  "${ANOMALOHARIS_BASE_URL}/api/runs/${RUN_ID}/events?after_sequence=12"
```

事件接口返回：

```json
{
  "run_id": "run_...",
  "events": [
    {
      "schema_version": 1,
      "run_id": "run_...",
      "runtime_kind": "workflow",
      "target_ref": "daily-event-review@1",
      "sequence": 13,
      "timestamp": "2026-08-26T00:01:00.000Z",
      "type": "workflow.run.succeeded",
      "data": {"output": {}}
    }
  ]
}
```

`sequence` 在单个 Run 内从 1 开始单调递增。终态包括：`succeeded`、`failed` 和 `stopped`。

### 6.4 停止 Run

停止需要 `workflow:run`：

```bash
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${URUS_WORKFLOW_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"user_stop"}' \
  "${ANOMALOHARIS_BASE_URL}/api/runs/${RUN_ID}/stop"
```

允许的 reason：`user_stop`、`disconnect`、`timeout`、`fail_fast`、`host_shutdown`。停止会
传播到活动的 child Agent Run 和插件操作。已经是终态的 Run 重复停止是幂等的，不会重新执行
Workflow。

## 7. Urus 重试和错误处理

### 7.1 幂等规则

同一个调用身份、Workflow Ref 和 `idempotency_key`：

- 首次调用创建一个 Run，通常返回 HTTP `201`。
- 重复提交相同请求返回 HTTP `200`，并返回相同 `run_id`。
- 使用同一 key 但修改 `input` 或 `metadata` 会返回 HTTP `409`，错误码为
  `idempotency_key_reused`。
- 没有 key 的请求不能安全地从网络超时中恢复；Urus 应为每个可重试业务操作生成稳定 key。

推荐的恢复流程：

```text
提交带稳定 idempotency_key 的 Run
  ├─ 收到 run_id       → 查询 Run/事件直到终态
  ├─ HTTP 超时/断线    → 用同一 key 重试，或用已知 run_id 查询
  └─ 连接恢复          → GET /api/runs/{run_id}/events?after_sequence={last_sequence}
```

### 7.2 HTTP 错误

Workflow API 错误使用统一外层字段：

```json
{
  "error": "Workflow daily-event-review@1 is not allowed for this service client.",
  "error_code": "workflow_ref_forbidden"
}
```

常见错误：

| HTTP | `error_code` | 处理建议 |
| --- | --- | --- |
| 400 | `invalid_workflow_run_request` | 修正 JSON 结构、`input` 或字段名 |
| 401 | `unauthorized` | 检查 Bearer token 和 Host 配置 |
| 403 | `forbidden` / `workflow_ref_forbidden` | 检查 service scope 和 Ref allowlist |
| 404 | `workflow_not_found` / `run_not_found` | 确认 Ref、版本或调用身份 |
| 409 | `idempotency_key_reused` | 不要复用 key 执行另一项业务操作 |
| 503 | `workflow_unavailable` | Runtime 未装配或依赖不可用，稍后重试并告警 |
| 500 | `workflow_runtime_error` | 保存 request id，联系 AnomaloHaris 运维，不要无界重试 |

校验/导入错误以 `validation.errors[].code` 为机器合同，例如
`WORKFLOW_PRESET_MODEL_NOT_FOUND`、`WORKFLOW_PLUGIN_OPERATION_FORBIDDEN`、
`WORKFLOW_SCHEMA_INCOMPATIBLE` 和 `WORKFLOW_CYCLE_FORBIDDEN`。修复 Definition 后必须创建
新的 Definition 内容；已发布版本不能原地覆盖。

## 8. 从现有 Urus Preset Model 调用迁移

现有对接：

```text
Urus → POST /v1/chat/completions → scheduled-event-investigator@1
```

Workflow 对接：

```text
Urus → POST /api/workflows/daily-event-review/versions/1/runs
     → WorkflowRunner → preset_model 节点
     → scheduled-event-investigator@1
```

迁移时：

1. 保留现有 Preset Model 作为节点的 `model_ref`，不要把 provider 或 prompt 搬进 Workflow JSON。
2. 将 Urus 的业务请求放入 Workflow `input`，并按 `input_schema` 校验。
3. 先导入并发布 Workflow，记录 `workflow_ref` 和 `compiled_hash`。
4. 后续运行只发送 Workflow Ref 对应的 URL、`input` 和幂等键。
5. Workflow 的 Preset Model 节点默认使用隔离 child Agent Run；不要依赖调用方聊天 Session
   history 传递状态。

两种接口可以并存，但同一业务操作应明确选择一种协议。不要把 `/v1/chat/completions` 的
`messages` 请求体直接发送到 Workflow Run API；Workflow Run API 使用 `{ "input": ... }`。

## 9. 对接验收清单

- [ ] Urus 使用最新 Manifest，并保存 `manifest_hash`。
- [ ] Definition 的 `api_version`、节点 `type_version` 和所有精确依赖均来自 Manifest。
- [ ] Definition 通过 `/validate`，并记录 `definition_hash`、`compiled_hash` 和 warnings。
- [ ] Definition 通过 `/import` 后为 `draft`，由管理员确认后再 `/publish`。
- [ ] Urus service token 只有 `workflow:read`、`workflow:run` 及必要的 Ref allowlist。
- [ ] 每次运行使用稳定的 `idempotency_key`，并保存 `run_id`、`target_ref` 和最后 sequence。
- [ ] 成功、失败、超时、断线恢复和停止均通过真实环境验证。
- [ ] Urus 不持有 admin token，不把 token、prompt、provider 或插件私有配置写入 Workflow JSON。
- [ ] 发布新版本后，Urus 切换到新的完整 Ref；旧版本退役前先确认没有需要完成的 Run。
