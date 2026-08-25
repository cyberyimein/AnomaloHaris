# Buddy 设备协议与迁移参考

> 状态：设备/协议参考；活动服务位于 `apps/buddy-service`，当前不由 AnomaloHaris 默认加载。
> 目的：由独立 Node Buddy 服务拥有设备控制、Hook Relay 和审批状态机，再通过 Node bridge plugin 向 Agent 暴露能力。

AnomaloHaris 的核心运行时是 Node.js。Buddy 不挂载到 Node Host 的 HTTP、WebSocket 或 Agent
Core 硬件层；Buddy 作为 `apps/buddy-service` 下的独立 Node 服务运行，负责硬件连接、Hook
Relay、审批状态机和鉴权。Node Agent 只通过 `buddy-bridge` 插件调用 Buddy HTTP API，Skill
只提供模型侧的使用说明。

## 目录边界

- `apps/buddy-service/src/gateway.ts`：Node Call Buddy TCP/可选串口适配和 JSON Lines 事件网关。
- `apps/buddy-service/src/hook-relay.ts`：Node 会话隔离、顺序检查、状态投影和可选审批等待。
- `apps/buddy-service/src/service.ts`：Node HTTP API、鉴权和 Hook 兼容路由。
- `/Users/waynewong/.codex/hooks/codex-hook.mjs`：Codex stdin/stdout Hook 适配器，故障时 fail-open。
- `apps/buddy-bridge/`：Agent Host 的可选 L2 插件，不包含硬件代码。
- 旧 `buddy_backend/` Python 网关和工具已删除；迁移时只参考本目录的固件协议文档。
- `docs/call-buddy-protocol.md`：设备侧 Call Buddy 低层协议参考。

不属于本批次的运行时包括：

- Buddy 音频桥和音频帧处理；
- Buddy 视觉检测 API 和检测器；
- 旧的 Copilot/Codex hook 转发脚本；Hook Relay 已迁移到 `apps/buddy-service`，不恢复旧脚本；
- 将 Buddy 自动挂载进旧 FastAPI Host 的入口。

Hook 状态机实现见 [`apps/buddy-service/src/hook-relay.ts`](../apps/buddy-service/src/hook-relay.ts)，协议和恢复边界见
[`docs/design/buddy-hook-state-machine.md`](../docs/design/buddy-hook-state-machine.md)。

## 推荐的未来边界

```text
Node Host / Preset Model
        │ fixed optional plugin binding
        ▼
buddy-bridge plugin
        │ authenticated HTTP
        ▼
Buddy backend / Hook Relay
        │ Call Buddy protocol
        ▼
StackChan / Buddy device
```

插件至少应独立拥有：

1. 设备连接与断线重连；
2. `buddy.status`、`buddy.events`、状态和审批工具；
3. admin/service token 校验与日志脱敏；
4. 可选能力声明和超时/故障隔离；
5. 与 Node Host 的版本化插件契约。

Node 服务启动：

```bash
npm run build --workspace @anomaloharis/buddy-service
npm run start --workspace @anomaloharis/buddy-service
```

默认只监听 `127.0.0.1:8765`。远程或容器部署必须设置独立的
`BUDDY_SERVICE_TOKEN` 和 `BUDDY_HOOK_TOKEN`；Node bridge 只接收显式 allowlist
中的 `ANOMALOHARIS_BUDDY_*` 变量。

核心路由：

- `GET /healthz`
- `GET /v1/buddy/status`
- `GET /v1/buddy/events`
- `POST /v1/buddy/state|text|look|led|approval`
- `POST /v1/agent/events`
- `POST /api/copilot/hooks/{event_name}`（兼容 Hook runner）

Node Host 不应因为 Buddy 未安装、设备离线或插件崩溃而影响普通 Agent、Preset Model、
旧 API 或 WebSocket 会话。

## 当前设备协议摘要

低层协议是每行一条文本命令、设备事件使用 JSON Lines。常用主机命令包括：

```text
CB connect [text]
CB idle [text]
CB listen [text]
CB think [text]
CB speak [text]
CB error [text]
CODEX CODING [text]
CODEX APPROVAL <id> [text]
CODEX DONE [text]
STATE idle|listening|thinking|speaking|coding|approval|done|error|sleep
TEXT <text>
APPROVAL <id> [text]
LOOK <yaw> <pitch> [speed]
LED <r> <g> <b> [ms]
```

常用设备事件包括 `device.boot`、`device.heartbeat`、`buddy.state.changed`、
`approval.response`、`touch.click` 和 `touch.listen_cancel`。完整协议以
`docs/call-buddy-protocol.md` 为准；其中的音频帧章节是历史固件能力，不构成 AnomaloHaris
Host 的功能承诺，未来是否恢复必须由独立插件重新评估。

## 恢复前检查

- 为插件新增独立包、manifest、权限和集成测试；
- 不修改 Node Host 默认插件 allowlist；
- Hook runner 只指向 Buddy backend，不重新挂载到 Node Host；
- 明确音频/视觉是否仍是产品需求；若需要，作为独立媒体插件或外部服务实现；
- 更新 ADR 和本文档，确保没有重新引入 Python Host、FastAPI 路由或隐式硬件依赖。
- 串口能力通过可选 `serialport` 适配提供；没有该依赖时 Node 服务仍可使用 TCP 和模拟/测试网关。
