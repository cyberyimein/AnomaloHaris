# Buddy 固件设计审查 · 2026-11-15

> 后续整改见 [0.5.0 修复与验收记录](buddy-firmware-design-fixes-2026-11-15.md)。本报告保留原审查时的结论与证据边界。

审查对象为当前 `firmware/stackchan` 0.4.7 工作区，以及与操作有关的 Buddy 页面。结论是：基础硬件适配已有不少正确处理，但同步调度、动作结果确认和状态语义仍不适合高频、连续的 Agent 操作。用户发现的“转头顺带拍照、拍照卡顿”有明确的代码原因。

本轮产出为审查和离线复现；没有修改运行代码、刷写设备、移动实物或采集房间照片。

## 对照基线与证据边界

- 当前 AnomaloHaris HEAD：`78205d15f7aa77be1f2b1e33579217ed5507e630`。固件有未提交文件，因此以下结论以本报告记录的工作区文件为准，不能仅凭 HEAD 还原。
- 主要旧固件：`/Users/waynewong/code/MyStackChan/MystackChan/MystackChan.ino`，仓库 HEAD `952f206c2f97bcb0549b6d4ccd81d603f9d26054`；另对照 `/Users/waynewong/code/StackChan-BSP/sketches/MyStackChan/MyStackChan.ino` 和 BSP 驱动，仓库 HEAD `ae18836faf1b9d8867b4970d8b393639afffb611`。
- Python 驱动固定为官方 UIFlow2 **2.4.7** 标签提交 [`9f66a4ecd8c8f163b83980667da37b57cbbb3e33`](https://github.com/m5stack/uiflow-micropython/tree/9f66a4ecd8c8f163b83980667da37b57cbbb3e33/m5stack/libs)。重点对照 `hardware/stackchan.py`、`driver/m5ioe1.py`、`driver/scs_servo.py` 和 `driver/si12t.py`。它与之前实机观察到的旧 RGB 驱动返回值行为一致；不能用 master 驱动替代这份基线。
- 官方说明按具体问题引用。网页的版本路径不替代固定源码；相机镜像默认仅有文档证据，列为待实物验证项。
- 本轮确定项来自当前调用链或 Fake 驱动复现。未测量实际设备本轮的编码耗时、峰值 RAM、串口失败率或镜像方向。

可重复运行的离线证据：[复现脚本](buddy-firmware-audit-2026-11-15-repro.py)。它使用仓库的 Fake 驱动，不读取 `config.py`，不连接设备。脚本断言的是本次审查基线的缺陷行为，修复后应更新为正常行为回归测试。

```sh
python3 docs/reviews/buddy-firmware-audit-2026-11-15-repro.py
```

## 优先问题

| 编号 | 优先级 | 结论 | 确认方式 |
| --- | --- | --- | --- |
| F1 | P1 | 主方向按钮默认“移动并拍照”，增加了不必要的交互延迟 | 页面调用链；用户现场反馈 |
| F2 | P1 | 网络收发和耗时动作独占主循环，阻塞本地反馈及电源键轮询 | 源码；虚拟慢连接复现；图像数据量计算 |
| F3 | P2 | 舵机没有移动也可返回成功，底层写入结果没有传播 | 固定 SDK 源码；静态姿态 Fake |
| F4 | P2 | 关机响应丢失后停在半关机状态，没有自动完成期限 | 完整服务循环 Fake |
| F5 | P2 | 只读能力仍改变动作状态，撤销手动灯光并清理错误 | 两次 `touch.read` 复现 |
| F6 | P2 | 物理故障三秒后自动清除，没有恢复检查或持久健康记录 | 注入持续故障复现 |
| F7 | P2 | 图像时间标记使用编码后、甚至接收后的时间 | 注入编码延迟复现；服务端调用链 |
| F8 | P2／扩展前处理 | 扩展模块的输入 schema 只是元数据，不会自动约束 handler | 注册扩展能力并传入越界参数复现 |

### F1：网页将纯移动和视觉观察混在主控制入口

证据：[BuddyDashboard.vue:175](../../frontend/src/dashboard/BuddyDashboard.vue#L175) 的方向按钮调用 `quickObserve()`；[第 929 行](../../frontend/src/dashboard/BuddyDashboard.vue#L929) 选择 `head.observe`。[device.py:1024](../../firmware/stackchan/device.py#L1024) 固定移动 800 ms，再等待默认 250 ms，随后采图。这个路径每次都支付图像链路成本。

下方 [Move head 按钮](../../frontend/src/dashboard/BuddyDashboard.vue#L248) 调用的是 `head.move`；[device.py:973](../../firmware/stackchan/device.py#L973) 本身没有拍照。离线调用得到 `head.move` 相机调用 **0 次**，`head.observe` **1 次**。所以“所有舵机接口必然拍照”并不成立；问题集中在最显眼的网页方向入口。

建议：方向按钮默认只移动，提供独立拍照按钮；保留明确命名的“转向并观察”组合操作和 Agent 工具。手动移动不应依赖相机 capability 是否存在，也不应等待图像返回才完成交互。

验收：每个方向按钮只发 `head.move`，没有隐式 `camera.capture/head.observe`；显式观察才采图；使用 Playwright 脚本验证请求序列，不增加前端单元测试。

### F2：主循环没有得到持续运行的保证

证据：[main.py:248](../../firmware/stackchan/main.py#L248) 每轮依次更新 M5、轮询电源键、更新设备，再同步读取请求、调用能力和发送响应。连接使用 [30 秒 socket 超时](../../firmware/stackchan/main.py#L117)，[read_request](../../firmware/stackchan/main.py#L58) 没有整个请求的总期限，也不会在分段读取之间运行设备更新。一个客户端每隔 29 秒传来一小段合法请求头，六段可占住 **174 秒虚拟时间**，而每次读取都没有超时；这是离线模型，不是对实物发起的阻塞测试。

相机链路也在相同主循环中执行：[device.py:992](../../firmware/stackchan/device.py#L992) 的采图、显示恢复、RGB565→PNG、Base64，接着是 [http_api.py:62](../../firmware/stackchan/http_api.py#L62) 的整包 JSON 序列化与 UTF-8 编码。`head.move` 另有同步 `sleep_ms(move_time_ms)`，`head.observe` 还有 settle 等待。

当前 [PNG 编码器](../../firmware/stackchan/png_encoder.py#L72) 使用无压缩 DEFLATE。离线实算的 QVGA 数据量为：

| 阶段 | 字节数 |
| --- | ---: |
| RGB565 原帧 | 153,600 |
| RGB888 扫描行缓冲 | 230,640 |
| PNG | 230,723 |
| Base64 字符串 | 307,632 |

这些阶段会创建多份临时数据；上表不是峰值 RAM 相加公式。HTTP 的 8192 字节分块发送发生在整包生成后，只减少发送块大小，不消除编码和 JSON 阶段的等待。实际阶段耗时和峰值 RAM 需单独测量。

影响：灯效、猫动画、触摸采样、本地电源键轮询都会延迟，短触摸可能漏掉。官方 [Button API](https://uiflow-micropython.readthedocs.io/en/2.4.7/hardware/button.html) 明确依赖主循环持续调用 `M5.update()`；[MicroPython socket 文档](https://docs.micropython.org/en/latest/library/socket.html) 的 socket 超时也不能代替应用层整个请求的期限。

旧固件主循环同样有协作式限制，但明确分别调用输入、动作、灯效和绘制更新。不能把旧固件也存在的阻塞当成当前设计合理的依据。当前 README 所称“触摸独立于 API 调用”也应改成准确的调度约束。

建议：用有总期限的增量网络收发和可推进的动作任务，让主循环持续处理本地输入；等待舵机时用目标／期限／反馈推进状态，不直接 sleep。图像结果与动作确认分开传输，优先评估把图像编码搬到部署主机，设备传递有所有权的 RGB565 数据。保留显示和相机的单一资源所有者，避免为并发再次引入混图。

CoreS3 的 RGB565 配置有官方依据；[camera 文档](https://uiflow-micropython.readthedocs.io/en/stable/advanced/camera.html) 将相机 JPEG 模式限定于 AtomS3R-M12，不能直接把 CoreS3 的 `pixformat` 改成 JPEG 当作性能修复。

验收：慢头部、慢客户端、移动和拍照期间都记录主循环最大间隔；电源键及输入处理有明确延迟预算；分别测量 move、settle、camera init/snapshot/copy/deinit、encode、JSON 和网络发送耗时。

### F3：目标姿态与已确认结果没有区分

证据：[device.py:964](../../firmware/stackchan/device.py#L964) 写入两个目标后等待固定时间，读回异常被忽略，随后返回 `ok: true` 和目标角度，没有检查是否到位。固定 2.4.7 的 [`StackChan.set_servo_angle`](https://github.com/m5stack/uiflow-micropython/blob/9f66a4ecd8c8f163b83980667da37b57cbbb3e33/m5stack/libs/hardware/stackchan.py#L274) 也没有向上传递底层 `Scscl.write_pos` 的成功码。

Fake 保持实测角度 `0/45`，并让 setter 不执行动作，调用目标 `30/60` 仍返回成功和 `30/60`。这证明软件无法区分“已请求”与“确实执行”，不代表实物已经发生该故障。

同一 SDK 对扭矩命令也不传播底层结果。因此 `head.release/hold` 的 `guiding` 状态与实际扭矩可能不同；这是源码支持的风险，未故意在实物上制造串口故障。

建议：适配层保留命令失败信息，结果区分目标姿态、实测姿态和完成状态；在合理容差与期限内确认移动。扭矩释放／保持应有验证能力或明确的未确认状态。

### F4：关机依赖客户端成功收包

证据：[main.py:283](../../firmware/stackchan/main.py#L283) 仅在响应发送成功时 arm 最终关机。若关机动作已经执行，正常响应和错误响应都发送失败，设备已经关闭舵机、显示关机画面，却保持 `shutdown_requested=true`、`shutdown_poweroff_armed=false`。[device.py:469](../../firmware/stackchan/device.py#L469) 不会切断电源，其他普通能力也被 shutdown guard 拒绝。

离线完整服务循环模拟断开的客户端，并推进 60 秒，仍未调用 `powerOff()`。这是缺少自动完成／恢复期限，不是不可恢复：重试关机且响应成功、或本地长按电源键，都能再次 arm。

建议：关机意图一经接受就启动有界的完成期限；尽力发送确认，但不能无限等待客户端。响应失败也应按同一关机事务完成，或明确回滚到可操作状态。

旧 Arduino 固件曾因某些路径会重启而用 `deepSleep(0, true)`。当前 Python 的 `Power.powerOff()` 此前已由用户确认屏幕和灯熄灭，官方 [Power API](https://uiflow-micropython.readthedocs.io/en/2.4.7/system/power.html) 也定义其关闭电源；本轮不把这个历史差异列为当前错误。

### F5：只读调用有表现和控制副作用

证据：[device.py:338](../../firmware/stackchan/device.py#L338) 只把 sleep/wake 与灯光操作特殊处理；`touch.read`、`power.read`、`imu.read` 等仍走第 353 行开始的通用动作路径，清除错误、进入 acting，再返回 ready。这会触发灯效、猫表情以及手动覆盖状态变更。

离线设置手动灯光后连续两次 `touch.read`，灯光来源从 `manual` 变成 `lifecycle`。第一次没有清掉，还与 `_led_override_armed` 在 `led.set` sideband 返回后仍保留为真有关；第二次普通调用才触发撤销，行为取决于调用历史。

建议：按能力声明区分查询、动作和表现控制。查询返回数据，不进入 acting、不清故障、不重置手动表现；覆盖标记应在所属操作结束时收束，不能依赖下一次无关调用的 finally。

### F6：错误展示期限被当作硬件恢复机制

证据：[device.py:408](../../firmware/stackchan/device.py#L408) 在 error 超过三秒后直接清掉 `last_error`，再依据 Wi-Fi/HTTP 服务状态切回 ready，没有重试或检查原故障。离线注入持续物理故障，推进 3100 ms 后即得到 `ready`、`lastError=null`。

旧宠物固件中的短暂错误表情自动回 idle，适合一次会话提示；Agent 身体还需要持续的组件健康信息。当前 `last_action` 也不能代替故障记录。这个问题不等于所有组件故障都必须让整个机器人永久停机。

建议：将展示表情、单次调用错误、组件故障分开。组件故障保留来源、时间、最近恢复检查；可以自动结束红灯表情，但应保留降级状态，只有验证恢复后才清除对应故障。

### F7：图像“采集时间”偏晚

证据：[device.py:999](../../firmware/stackchan/device.py#L999) 在 PNG 和 Base64 编码后才取 `capturedAtMs`。离线让编码阶段推进 1000 ms，帧已取得的时刻与返回时间相差正好 1000 ms。

另外，[buddy-service:260](../../apps/buddy-service/src/service.ts#L260) 和 [前端控制器:123](../../frontend/src/dashboard/buddyDashboardController.js#L123) 将接收处理时的主机时间记录为 `capturedAt`。链路越慢，按这些字段判断图像新鲜度就越乐观。

建议：相机取得自有帧时立即记录设备单调时钟；另记编码／接收完成时间。主机时间与设备 ticks 不可直接相减，跨设备映射需要时钟估计或明确的 age 语义。展示和 Agent 工具不能将接收时间当作真实曝光时间。

### F8：扩展能力的 schema 没有执行约束

证据：[register_capability](../../firmware/stackchan/device.py#L260) 保存输入 schema，但 [invoke](../../firmware/stackchan/device.py#L316) 只检查 args 是对象，随后依靠具体 handler 自行校验。Buddy service 也没有通用 schema 验证。离线注册一个 `level <= 1`、禁止额外字段的模块，再传 `{level:99, unexpected:true}`，handler 仍然执行。

目前内置 handler 多数手工校验输入，所以这是扩展框架的缺口，不代表现有所有能力都能越界。新增红外等模块时，不能把“注册了 schema”误认为“获得了校验”。

建议：选择可在 MicroPython 上可靠运行的受支持 schema 子集并集中校验；或者明确规定模块必须提供 validator，并在注册时强制校验契约。服务端和设备端都应在执行硬件操作前拒绝无效输入。

## 待验证与能力取舍

- **相机方向**：初始化未显式设定水平镜像；官方 [camera 文档](https://uiflow-micropython.readthedocs.io/en/stable/advanced/camera.html) 说明默认开启。应使用带文字及左右标记的静态目标核对，之后固定相机坐标约定。目前只可判为风险，不能宣称实物左右已经反转。
- **回中姿态**：旧固件 HOME_PITCH 为 25°，当前 `head.home` 为 45°。这需要结合希望的视线方向决定，不能仅凭数值差异判定机械错误；推荐成为明确的机体配置。
- **触摸能力**：旧固件存在 click、前滑、后滑事件，当前只记录一次有效触摸及区域。取消 Codex/Copilot 宠物业务动作符合本轮目标；若 Agent 需要理解滑动意图，应补独立手势事件，不恢复旧业务绑定。
- **音频覆盖**：旧项目包含音频输入与传输路径；当前注册能力只有 `speaker.tone`，没有录音或语音播放。这是“全部身体能力暴露给 Agent”目标下的后续能力清单，不能把 `led.express(listening)` 当作已经在录音。
- **Agent 可理解的触摸语义**：`touch.read` 返回原始 0–3，手势只接受 2/3，工具描述尚未明确这点。需要补充契约，避免 Agent 把 LOW 噪声当作有效按压。
- **文档漂移**：README 第 205 行仍称 ready 为青色；第 93 行暗示触摸独立于 API 请求。应按当前暗金灯色及实际调度方式更新。

## 目前应保留的设计

- 原机 NVS 标定值与用户限位分离，限制 pan/tilt 范围；启动时先释放扭矩、读取姿态、同步目标再保持，方向正确。官方 [StackChan 指南](https://uiflow-micropython.readthedocs.io/en/2.4.7/controllers/stackchan.html) 也强调标定与扭矩语义。
- 灯效与 Agent 情绪是独立表现层，错误、关机、休眠和摄像提示有优先级。暗金待机、亮度减半与 LOW 过滤有此前实物校准依据，不因旧默认不同而撤销。
- RGB565 小端 LED RAM 编码、第二灯条的反向物理索引符合固定 SDK/BSP。IR 收发参数未发现确定错误。
- 相机按次初始化、复制到自有像素缓冲并释放，再恢复屏幕，避免了之前的共享缓冲混图。后续性能工作要保留这份所有权约束。
- 软件屏幕快照明确表示“已提交帧”，没有伪称物理 LCD 回读，这个界限应保留。

## 建议的整改顺序与验收

1. **先处理用户最直接的转头体验**：网页方向键只移动，拍照独立触发，组合观察单独保留。用 Playwright 检查实际请求序列及按钮反馈。
2. **调整执行骨架和图像链路**：持续运行设备 tick；给请求总期限；拆开命令确认、任务完成与图片传输；测量各阶段耗时后选择主机编码／较小帧／二进制传输方案。不能仅靠增加超时或发送块大小。
3. **明确动作和故障结果**：舵机命令确认与姿态反馈、关机失败期限、纯查询语义、组件故障记录一起整理，并补对应故障注入回归。
4. **校准 Agent 感知契约**：图像方向、时间、目标／实测姿态、触摸档位。然后完善模块验证与音频／手势扩展。

验收应包括：纯移动不采图；采图期间本地输入延迟有界；模拟 UART 不执行时不会回报已完成移动；客户端丢包仍能完成关机事务；只读查询不撤销手动灯光；组件故障未经检查不会消失；图像时间不包括编码耗时；扩展 handler 不收到越界输入。硬件故障注入应先在 Fake 中验证，实物验证只做必要的可恢复项目。

## 工作区文件指纹（SHA-256）

```text
firmware/stackchan/main.py f33652e7f9a455d9f6c0f7d4cc64c9f494e43b36e7ed1c2e189b51ce2f5a94c9
firmware/stackchan/device.py 3d1a8c8323fc0713cbd6f84a19e8787e046c4874ce9681f0bd1667c7b13a3c98
firmware/stackchan/lazy_camera.py 9ff6a3282f455538ba608ae8e346465f9463460336a011f59ffad81cbaaaeeda
firmware/stackchan/png_encoder.py 16e1335b9600b38319e673b85bb0f1128cac5a5984363430ea0d53ecacb452b3
firmware/stackchan/capabilities.py 06b18da6b5c33574682f9e9077acc7a03c29f50dfc5fece55da755969be9af3b
frontend/src/dashboard/BuddyDashboard.vue eeb39499dc02515e5ed2775cc726270a741860a4b7f2d77e6a156ffe04571c5f
```
