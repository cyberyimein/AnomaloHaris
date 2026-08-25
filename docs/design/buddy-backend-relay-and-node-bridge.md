# Buddy Backend Relay 与 Node Bridge 设计

> 状态：Implemented as an optional Node integration on `codex/buddy-bridge`
>
> 目标：让 Buddy 后端拥有设备与 Hook Relay，Node Agent 通过固定插件和 Skill 使用 Buddy。

## 1. 边界

```text
Codex Hook Runner ── hook token ──▶ apps/buddy-service (Node)
                                      │
                                      ├─ HookRelay：事件归一化、状态机、审批等待
                                      ├─ BuddyGateway：TCP / 可选串口、Call Buddy 命令、设备事件
                                      └─ HTTP API：状态、控制、事件

Node Agent ── buddy Skill + buddy-bridge ── service token ──▶ apps/buddy-service

Admin UI ── admin token ── Node Host `/api/buddy/*` proxy ── service token ──▶ apps/buddy-service
```

- Node Host 不导入 `buddy-backend` 的旧 Python 包，不连接串口，也不包含音频、视觉或媒体栈。
- `apps/buddy-service` 是独立 Node 进程；根目录 `buddy-backend/` 只保留设备固件、协议和迁移参考，不再承载第二个活动服务。
- Buddy 后端不持有 Provider key，也不执行模型循环。
- 服务启动时默认自动建立 Gateway；无串口配置时只监听本机 127.0.0.1:8766。
- 远程 TCP 设备必须显式配置 BUDDY_TCP_CLIENT_IP；未配置客户端白名单时拒绝公开监听。
- `buddy-bridge` 是可选 L2 plugin；它的故障必须转换成普通 tool failure 或生命周期诊断，不能让 Agent Core 崩溃。
- Buddy dashboard 只使用 Node Host 的 admin-gated control-plane proxy；它不会把 Buddy 工具添加到默认 Agent 或 retrieval subagent 的工具图。
- `buddy` Skill 是模型侧说明，不是设备执行器；真实工具由 plugin 注册并调用 Node 服务。

## 2. 服务 API

默认地址是 `http://127.0.0.1:8765`。Node 服务使用 `BUDDY_SERVICE_TOKEN` 验证 Node
bridge，使用独立的 `BUDDY_HOOK_TOKEN` 验证 Codex hook。loopback 开发环境可以不设置
token；公共监听必须同时配置 token。

| 方法 | 路径 | 调用方 | 作用 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | local probe | 健康检查 |
| `GET` | `/v1/buddy/status` | bridge | 连接、传输和最近事件摘要 |
| `GET` | `/v1/buddy/events` | bridge | 读取脱敏设备事件 |
| `POST` | `/v1/buddy/state` | bridge/admin | 更新视觉状态 |
| `POST` | `/v1/buddy/text` | bridge/admin | 更新短状态文本 |
| `POST` | `/v1/buddy/look` | bridge/admin | 轻量头部动作 |
| `POST` | `/v1/buddy/led` | bridge/admin | LED 提示 |
| `POST` | `/v1/buddy/approval` | bridge | 等待 Buddy 审批 |
| `POST` | `/v1/agent/events` | bridge | 发送 Node Agent 生命周期事件 |
| `POST` | `/api/copilot/hooks/{event_name}` | Codex hook | 兼容旧 Hook runner，返回 `{}`/allow/deny |

`/api/copilot/hooks/*` 只返回紧凑 Hook effect；诊断状态通过 `/v1/buddy/relay/sessions`
查询，不把完整 prompt、工具参数或 token 写入日志。

## 3. Skill 与 Preset Model

`runtime-bundle/skills/buddy/SKILL.md` 负责告诉模型何时使用 `buddy_*` 工具，以及设备不可用时
如何降级。工具只有在当前 Preset Model 固定绑定 `buddy-bridge@1.0.0` 后才会进入工具图。

不要修改已发布的 `luna@1` 或默认 `anomaloharis@1` 来偷偷加入硬件能力。需要 Luna 控制 Buddy 时，
发布新的 `luna-buddy@1` 或 `luna@2`，并让该版本同时绑定：

```yaml
plugins:
  fixed:
    - host-core
    - web
    - buddy-bridge@1.0.0
```

`buddy` Skill 的激活仍然是 Session 资源操作；插件固定绑定负责安全工具边界，Skill 负责模型
行为说明，两者不能互相替代。

## 4. Hook Relay 不变量

- 状态按 `session_id` 隔离；没有可识别会话的事件直接丢弃。
- `sequence` 或时间戳倒退、重复事件不会重放状态和审批。
- Buddy 连接失败、超时和格式错误均 fail-open，不阻塞普通 Agent。
- 只有审批桥明确启用且收到用户决定时，Hook 才返回 `allow` 或 `deny`。
- 审批请求按 `request_id` 幂等，完整 prompt、工具参数和凭据不进普通日志。
- audio、vision、camera 和 TTS/STT 不属于本插件或 Buddy 服务的本批次范围。

## 5. 启动与验证

```bash
npm run build --workspace @anomaloharis/buddy-service
npm run start --workspace @anomaloharis/buddy-service

# Node Host 侧
ANOMALOHARIS_PI_EXTENSIONS_ENABLED=true \
  ANOMALOHARIS_PLUGIN_CONFIG=./runtime-bundle/config/plugins.yaml \
  npm run start --workspace @anomaloharis/node-host
```

没有真实设备时，`/healthz` 和插件加载仍应成功；控制工具应返回明确的
`buddy_unavailable`，而不是伪造成功。

### Apple Container 部署

Buddy 服务仍然是独立容器。它必须与 AnomaloHaris 位于同一个
`anomaloharis-external` 网络，Node Host 使用该网络网关映射的 Buddy
HTTP 端口访问；Apple Container 当前不提供可靠的容器名 DNS，且
`host.docker.internal` 是 Docker 专用地址。公开监听时必须同时设置
`BUDDY_SERVICE_TOKEN` 和 `BUDDY_HOOK_TOKEN`。远程设备使用 TCP 时，还要
发布 Buddy 的 TCP 端口（部署脚本默认使用宿主机/容器端口 `8787`）。Apple
Container 会将已发布端口的来源 NAT 成网络网关地址，因此容器内的
`BUDDY_TCP_CLIENT_IP` 应设置为该网关，而不是设备在宿主局域网中的原始地址。
