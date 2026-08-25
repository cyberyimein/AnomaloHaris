# Buddy / Codex 钩子状态机（Buddy 后端可选服务）

> 状态：`Implemented in apps/buddy-service; optional`
> 更新时间：2026-08-23  
> 适用范围：Codex → Buddy 后端 Hook Relay → Buddy 的协议和状态机；Node Agent 通过独立 bridge plugin 使用同一服务。

## 1. 当前决策

AnomaloHaris 当前以 Node.js Agent Core / Node Host 为核心，Buddy 也是独立可选的 Node 服务。
`apps/buddy-service` 拥有 Codex Hook Relay、状态机、审批桥和 Call Buddy 设备连接；Node Host
只通过 `buddy-bridge` 插件发送 Agent 生命周期事件和工具请求，不直接导入 Buddy 或硬件代码。

后续若恢复，应作为独立的可选插件或外部 relay 部署：

```text
Codex hook runner
        │
        ▼
apps/buddy-service Hook Relay（Node 可选服务）
        │ 事件归一化、顺序检查、审批等待
        ▼
Buddy adapter（可选）
```

Node Agent Core 不直接导入 Buddy SDK、钩子脚本或视觉/音频模块。预设模型通过固定的
`buddy-bridge` plugin 获得工具；普通默认 Preset Model 不隐式获得硬件能力。

## 2. 事件归一化

外部钩子事件名称可以使用 Codex 原始名称，也可以使用旧配置中的 camelCase 名称。relay 在进入状态机前统一为以下事件：

| 外部事件 | 规范事件 | 作用 |
| --- | --- | --- |
| `UserPromptSubmit` / `userPromptSubmitted` | `userPromptSubmitted` | 新一轮用户请求开始 |
| `PreToolUse` / `preToolUse` | `preToolUse` | 工具即将执行 |
| `PostToolUse` / `postToolUse` | `postToolUse` | 工具执行完成 |
| `PermissionRequest` / `permissionRequest` | `permissionRequest` | 请求用户批准工具/动作 |
| `Notification` / `notification` | `notification` | 等待用户输入或权限提示 |
| `Stop` / `agentStop` | `agentStop` | 当前 Agent 回合结束 |
| `SessionEnd` / `sessionEnd` | `sessionEnd` | 会话结束 |
| `ErrorOccurred` / `errorOccurred` | `errorOccurred` | 发生运行时错误 |

事件至少应携带 `sessionId`（或可等价解析的 `session_id` / `threadId` / `thread_id`），并尽量携带 `sequence` 或 `timestamp`。不能识别会话的事件只能被 relay 丢弃并记录诊断信息，不能污染其他会话。

## 3. 状态模型

内部状态与 Buddy 展示状态分离：

| 内部状态 | Buddy 展示状态 |
| --- | --- |
| `IDLE` | `idle` |
| `RUNNING` | `coding` |
| `WAITING_USER` | `waiting_user` |
| `APPROVAL_REQUIRED` | 保持当前状态，同时显示审批卡片 |
| `SUCCEEDED` | `done` |
| `FAILED` | `error` |
| `CANCELLED` | `idle` |

核心转移规则：

| 事件 | 条件 | 新状态 | Buddy 动作 |
| --- | --- | --- | --- |
| `userPromptSubmitted` | — | `RUNNING` | `coding`，可展示压缩后的 prompt |
| `preToolUse` | — | `RUNNING` | `coding`，可展示工具名 |
| `postToolUse` | — | `RUNNING` | `coding`，可标记工具完成 |
| `permissionRequest` | 需要用户操作 | `APPROVAL_REQUIRED` | 显示审批请求 |
| `permissionRequest` | 不需要用户操作或审批桥关闭 | `RUNNING` | 不阻断 Agent |
| `notification` | `permission_prompt` 且需要用户操作 | `APPROVAL_REQUIRED` | 显示审批请求 |
| `notification` | `idle_prompt` / `user_input` / `waiting_user` | `WAITING_USER` | `waiting_user` |
| `agentStop` | 正常结束 | `SUCCEEDED` | `done` |
| `agentStop` | abort / cancelled / user exit | `CANCELLED` | `idle` |
| `sessionEnd` | `reason=error` | `FAILED` | `error` |
| `sessionEnd` | 其他原因 | `IDLE` | `idle` |
| `errorOccurred` | — | `FAILED` | `error` |

### 3.1 状态机不变量

1. **会话隔离**：状态快照以 `sessionId` 为主键；事件不能跨会话应用。
2. **单调顺序**：若事件带有可比较的 `sequence` / `timestamp`，小于已处理顺序的事件必须忽略；相同顺序的重复事件必须幂等。
3. **审批幂等**：同一 `requestId` 只显示一次审批卡片；重复事件不能重复通知 Buddy。
4. **默认不阻断**：审批桥默认关闭。桥关闭时，非 `requiresUserAction` 的权限事件返回空效果并继续 Agent。
5. **故障隔离**：Buddy 不可连接、请求超时、响应格式错误时，relay fail-open，返回空 hook effect；不得让模型运行时崩溃。
6. **显式拒绝**：审批桥启用且用户拒绝时，返回 `{"behavior":"deny","message":"Buddy denied the request."}`，并将会话置为取消/空闲。
7. **无敏感日志**：不得把 admin token、完整 prompt、工具参数或审批凭证写入普通日志。

## 4. 钩子输入、输出与传输约定

当前 Codex hook runner 通过仓库内的 Node 适配器
`/Users/waynewong/.codex/hooks/codex-hook.mjs` 向 relay 的 HTTP 端点发送 JSON：

用户级 `/Users/waynewong/.codex/hooks.json` 已注册该适配器的
`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PermissionRequest` 和
`Stop` 事件；现有 Otty hooks 保持不变。

```text
POST /api/copilot/hooks/{event_name}
Content-Type: application/json
Authorization: Bearer <hook token>
# 兼容旧 runner：x-anomaloharis-admin-token: <hook token>
```

旧实现的环境变量约定如下，仅作为恢复参考：

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `BUDDY_HOOK_BASE_URL` | relay 基地址 | 其次使用 `ANOMALOHARIS_BUDDY_SERVICE_URL`，再其次 `http://127.0.0.1:8765` |
| `BUDDY_HOOK_TOKEN` | relay Hook 令牌 | 其次使用旧变量 `ANOMALOHARIS_COPILOT_HOOK_ADMIN_TOKEN` / `ANOMALOHARIS_ADMIN_TOKEN` |
| `BUDDY_HOOK_TIMEOUT_MS` | Hook 网络超时 | 普通事件 5000ms；审批事件使用审批超时再加 5000ms |

relay 返回紧凑 JSON hook effect：

```json
{}
```

或在审批桥明确启用并已有用户决定时：

```json
{"behavior":"allow"}
```

```json
{"behavior":"deny","message":"Buddy denied the request."}
```

状态同步本身返回空结果时，Codex 应继续按其默认行为运行。网络错误、状态解析错误和 Buddy 断开都采用 fail-open；只有明确的 `allow` / `deny` 才改变审批结果。

## 5. Node Bridge 兼容边界

Node Host 只通过可选 bridge plugin 调用 Buddy 服务，不实现状态机。插件向 Buddy 后端发送规范事件：

```ts
type HookEvent = {
  name: string;
  sessionId: string;
  sequence?: number;
  timestamp?: number;
  payload: Record<string, unknown>;
};

type HookEffect =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | Record<string, never>;

POST /v1/agent/events

interface BuddyBridgePlugin {
  handleTool(call: ToolCall): Promise<ToolResult>;
  notify(event: HookEvent): Promise<void>;
}
```

Buddy 后端实现 Buddy 投影、审批超时、重连和会话状态。Node Host 只负责可选插件的生命周期和隔离，不应默认加载插件，也不应因为插件不可用而影响普通 Agent、preset model 或旧 API 请求。

## 6. 删除与恢复清单

当前删除内容：

- 旧的 `buddy-backend/scripts/copilot_buddy_hook.py`；
- 旧的直接依赖 AnomaloHaris Host 的 hook 配置；当前配置应调用 Node 适配器；
- 音频、视觉和媒体处理运行时。

恢复前必须重新确认：

1. 只为需要该能力的机器/用户安装 Buddy service 和 hook；
2. 使用独立的 service token 与 hook token；
3. 保持 `sessionId`、事件顺序和 request id 的来源可追踪；
4. 只在明确启用审批桥时返回 allow/deny；
5. 需要跨进程持久化时再引入存储，不把状态写入 Node Agent 数据库；
6. 继续保持各事件的脱敏日志与集成测试；
7. 不修改 AnomaloHaris 默认 Preset Model 的硬件能力。

本文档应作为恢复时的设计基线；恢复实现必须新增独立 ADR 和测试，不应仅凭旧脚本直接复制回来。
