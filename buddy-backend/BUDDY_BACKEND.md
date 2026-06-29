# Buddy Backend 对接说明

这份文档给开发 Buddy 客户端的 AI 使用，描述当前 Buddy 后端的代码结构、运行方式、HTTP API、设备协议和对齐要求。

## 目录结构

- `buddy_backend/gateway.py`：Buddy 连接网关。负责串口/TCP 连接、发送文本命令、读取 JSON Lines 事件、收发二进制音频帧。
- `buddy_backend/audio_bridge.py`：Buddy 语音回合桥。把设备麦克风音频交给 agent 的 STT/LLM/TTS，再把回答音频回传给设备。
- `buddy_backend/api.py`：FastAPI Buddy 管理接口，挂载在主服务的 `/api/buddy/*`。
- `buddy_backend/copilot_api.py`：Copilot/Codex hook HTTP 接口，挂载在 `/api/copilot/hooks/{event_name}`。
- `buddy_backend/copilot_hooks.py`：把 hook 事件转换成 Buddy 状态和审批请求。
- `buddy_backend/tools.py`：把 Buddy 控制暴露成 agent tools。
- `buddy_backend/skill_api.py`：给 `skills/` 下的 Buddy 技能调用的轻量 API。
- `skills/`：Buddy 相关运行时技能，包括 presence、approval、events。
- `docs/call-buddy-protocol.md`：设备侧 Call Buddy 协议原文，客户端实现时以它为低层协议细节来源。
- `scripts/copilot_buddy_hook.py`：本地 hook 转发脚本，读取仓库根目录 `.env` 后把 hook payload 发到 Anomalo HTTP API。

## 运行关系

当前 Buddy 后端作为独立 Python 包 `buddy_backend` 存在，但仍由 `agent-backend/app/main.py` 统一挂载到同一个 FastAPI 进程中。

主服务启动时：

1. `app.container.get_buddy_gateway()` 创建 `BuddyGateway`。
2. 如果 `ANOMALO_BUDDY_TRANSPORT=tcp`，FastAPI lifespan 会自动启动 TCP listener。
3. `BuddyAudioBridge.start()` 启动后台线程，轮询 `BuddyGateway.wait_for_audio_turn()`。
4. 前端、agent tools、skills、Copilot hooks 都通过同一个 gateway 操作 Buddy。

本地运行：

```bash
pip install -e ".[audio,buddy,dev]"
PYTHONPATH=agent-backend:buddy-backend uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## 环境变量

- `ANOMALO_BUDDY_TRANSPORT`：`serial` 或 `tcp`。默认 `serial`。
- `ANOMALO_BUDDY_SERIAL_PORT`：串口设备，例如 `/dev/tty.usbmodem2101`。
- `ANOMALO_BUDDY_BAUD_RATE`：串口波特率，默认 `115200`。
- `ANOMALO_BUDDY_TCP_HOST`：TCP listener 绑定地址，默认 `0.0.0.0`。
- `ANOMALO_BUDDY_TCP_PORT`：TCP listener 端口，默认 `8787`。
- `ANOMALO_BUDDY_TCP_CLIENT_IP`：可选客户端 IP 白名单。
- `ANOMALO_BUDDY_HOST_NAME`：发给设备展示的 host 名称。
- `ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE`：`auto` / `on` / `off`，控制是否保存 Buddy 音频诊断文件。
- `ANOMALO_COPILOT_BUDDY_APPROVAL_TIMEOUT_SECONDS`：hook 审批等待秒数，默认 `90`。
- `ANOMALO_COPILOT_BUDDY_PERMISSION_BRIDGE_ENABLED`：是否让 `permissionRequest` 真的等待 Buddy 审批，默认 `false`。

## HTTP API

所有 Buddy 管理接口都需要通过 `X-Anomalo-Admin-Token` 访问，除非服务未配置 `ANOMALO_ADMIN_TOKEN`。

### `GET /api/buddy/status`

返回连接状态、transport、TCP/串口信息、音频输入状态、最近事件数量和可用串口。

### `POST /api/buddy/connect`

请求体可为空，也可覆盖连接参数：

```json
{
  "transport": "tcp",
  "port": "/dev/tty.usbmodem2101",
  "baud_rate": 115200,
  "tcp_host": "0.0.0.0",
  "tcp_port": 8787,
  "tcp_client_ip": "192.168.31.78"
}
```

### `POST /api/buddy/disconnect`

断开当前串口/TCP 连接并停止 listener。

### `GET /api/buddy/events?after_id=0&limit=50`

返回 gateway 缓存的 JSON Lines 事件。客户端轮询时用 `after_id` 做增量读取。

### `POST /api/buddy/command`

发送原始文本命令：

```json
{ "command": "CB think asking model" }
```

### `POST /api/buddy/state`

发送高层状态：

```json
{ "state": "thinking", "text": "asking model" }
```

支持状态：`connect`、`disconnect`、`idle`、`listening`、`thinking`、`speaking`、`stop`、`error`、`coding`、`approval`、`done`。

### `POST /api/buddy/approval`

在 Buddy 上展示审批请求并等待事件响应：

```json
{
  "request_id": "codex-123",
  "text": "Allow shell command?",
  "timeout_seconds": 30
}
```

设备应返回 `approval.response` 事件，payload 至少包含 `id` 和 `choice`。`choice` 建议使用 `approve`、`deny` 或 `timeout`。

### `POST /api/buddy/vision/detect`

multipart 图片上传接口。服务端在第一次请求时懒加载 MediaPipe BlazeFace，返回检测到的人脸框。
默认只检测，不控制 Buddy；传 `apply_buddy_action=true` 时，检测到脸会按配置尝试暂停漫游。

### `POST /api/buddy/vision/frame`

Buddy 设备侧上传低频摄像头帧的接口。和 `/detect` 使用同一个检测器，但默认
`apply_buddy_action=true`。建议设备每几分钟上传一张低分辨率 JPEG 或灰度转 RGB 图片即可，
不需要实时视频流。

这个接口允许三种访问方式：localhost、管理端 token，或设备侧专用访问。设备侧专用访问
可通过请求头 `X-Anomalo-Buddy-Vision-Token` 对应
`ANOMALO_BUDDY_VISION_FRAME_TOKEN`，也可以通过
`ANOMALO_BUDDY_VISION_FRAME_CLIENT_IP` / `ANOMALO_BUDDY_TCP_CLIENT_IP` 配置 Buddy 设备 IP。

检测到任意人脸时，如果 `ANOMALO_BUDDY_VISION_ENABLED=true` 且 Buddy 已连接，服务端发送：

```text
ROAM PAUSE <ANOMALO_BUDDY_VISION_PAUSE_MS>
HOME
CB idle person nearby
```

当前服务端已按这个命令名发送；固件侧仍需要实现 `ROAM PAUSE` 才能彻底停止 idle wander。

### `GET /api/buddy/vision/status`

返回 Buddy vision 是否启用、detector 是否已经加载、阈值、暂停时长和最近一次检测结果。

## 设备协议摘要

低层协议详见 `docs/call-buddy-protocol.md`。客户端 AI 对齐时重点保证这些能力：

- 连接后可以接收 host 发来的文本命令，每条命令以换行分隔。
- 设备主动事件用 JSON Lines 发回 host，每行一个 JSON object。
- 常用 host 命令包括 `CB idle`、`CB listen`、`CB think`、`CB speak`、`CB error`、`CODEX CODING`、`CODEX DONE`、`TEXT`、`LOOK`、`LED`、`APPROVAL`。
- 设备事件包括 `device.heartbeat`、`buddy.state.changed`、`touch.click`、`touch.listen_cancel`、`approval.response`、`audio.input.start`、`audio.input.stop`。
- TCP 模式下 Buddy 是 client，Anomalo 是 server；Buddy 主动连接 `ANOMALO_BUDDY_TCP_HOST:ANOMALO_BUDDY_TCP_PORT`。

## 音频回合

Buddy 设备侧负责采集 PCM16 麦克风音频并按协议发送给 host。后端流程：

1. `gateway.py` 收到音频输入开始、二进制音频帧、音频输入结束。
2. 完整音频被封装成 `BuddyAudioTurn`。
3. `audio_bridge.py` 对 PCM 做预处理和归一化。
4. 调用 agent 后端的 `VoiceService`：STT -> agent run -> TTS。
5. TTS 音频被转换为 Buddy 需要的 PCM 输出格式，按 chunk 发回设备。

客户端需要确保采样率、声道数、sample width 与协议声明一致；如果音量过低，后端会让 Buddy 回到 `idle` 并提示 `mic too quiet`。

## Agent Tools 和 Skills

主 agent 会加载 Buddy tool provider：

- `buddy_set_state`
- `buddy_set_text`
- `buddy_request_approval`
- `buddy_look`
- `buddy_set_led`

Buddy 技能位于 `buddy-backend/skills`，由 agent 后端的多目录技能加载器读取。客户端 AI 不需要直接调用这些 Python 文件，但要保证设备协议能支撑技能发出的状态、文本、LED、审批和事件查询需求。

## 客户端对齐清单

- 能用串口或 TCP 建立长连接。
- 文本命令按行解析，未知命令要返回可诊断事件而不是断开。
- 状态命令会改变设备 UI：idle、listening、thinking、speaking、coding、approval、done、error。
- 周期性发送 `device.heartbeat`，payload 包含当前 state 和可选电量。
- 触摸/按钮事件用 JSON Lines 回传，事件名稳定。
- 审批 UI 能根据 `APPROVAL`/状态命令展示请求，并返回 `approval.response`。
- 如实现低频视觉检测，按几分钟一次上传低分辨率帧到 `/api/buddy/vision/frame`，
  并携带 `X-Anomalo-Buddy-Vision-Token` 或确保设备 IP 匹配服务端配置。
- 如希望检测到人脸后停止电机噪音，固件需要实现 `ROAM PAUSE <ms>` 并停止 idle wander。
- 麦克风音频流能明确 start/stop，并发送完整 PCM 帧。
- 播放 host 返回音频时，设备状态应能进入 speaking，播放结束后回到 idle。
- 出错时发事件说明原因，避免只静默断线。
