# Buddy 可选插件参考

> 状态：非 Node Host 核心；当前不由 Anomalo 默认加载。
> 目的：保留 Call Buddy 设备控制协议和插件拆分边界，供未来独立插件恢复使用。

Anomalo 的核心运行时是 Node.js。Buddy 不再挂载到 Node Host 的 HTTP、WebSocket 或 Agent
Core 生命周期中，也不再提供内置的音频、视觉或 Codex hook 中转能力。需要 Buddy 的部署应
显式安装一个独立插件或外部服务，并由该插件自行负责硬件连接、鉴权、资源和生命周期。

## 保留的插件素材

- `buddy_backend/gateway.py`：Call Buddy 串口/TCP 文本命令和 JSON Lines 事件网关。
- `buddy_backend/bridge.py`：供独立插件注入 gateway/settings 的轻量依赖边界。
- `buddy_backend/tools.py`、`tooling.py`：旧 Buddy 工具适配素材；恢复前需要重新定义
  Node 插件协议，不能直接从 Node Host 导入 Python 模块。
- `buddy_backend/skill_api.py` 和 `skills/`：设备 presence、approval、events 的历史技能
  参考；它们不属于默认 Preset Model 的固定插件。
- `docs/call-buddy-protocol.md`：设备侧 Call Buddy 低层协议参考。

已删除的运行时包括：

- Buddy 音频桥和音频帧处理；
- Buddy 视觉检测 API 和检测器；
- Copilot/Codex hook 转发脚本、HTTP 路由和状态投影实现；
- 将 Buddy 自动挂载进旧 FastAPI Host 的入口。

Hook 状态机没有丢失，恢复参考见 [`docs/design/buddy-hook-state-machine.md`](../docs/design/buddy-hook-state-machine.md)。
该文档只保存设计，不代表当前部署存在对应端点。

## 推荐的未来边界

```text
Node Host / Preset Model
        │ optional plugin capability
        ▼
Buddy plugin or external Buddy service
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
`docs/call-buddy-protocol.md` 为准；其中的音频帧章节是历史固件能力，不构成 Anomalo
Host 的功能承诺，未来是否恢复必须由独立插件重新评估。

## 恢复前检查

- 为插件新增独立包、manifest、权限和集成测试；
- 不修改 Node Host 默认插件 allowlist；
- 不恢复全局 Codex hook，除非 relay 设计和安装范围重新获批；
- 明确音频/视觉是否仍是产品需求；若需要，作为独立媒体插件或外部服务实现；
- 更新 ADR 和本文档，确保没有重新引入 Python Host、FastAPI 路由或隐式硬件依赖。
