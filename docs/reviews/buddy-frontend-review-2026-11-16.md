# Buddy 前端审查与修复 · 2026-11-16

审查 `BuddyDashboard.vue`、`buddyDashboardController.js` 及 Host/Buddy service
的接口接线。固件仍使用 BuddyNeko 0.5.0 的固定版本集成副本。

## 修复

1. **状态失效与恢复**：HTTP/网络失败后不再沿用旧在线、姿态、忙碌或故障展示。
   状态变为未知，清除旧图片和动作结果并禁用手动控制；刷新恢复后重新可用。
2. **并发快照**：失败与成功都绑定请求序号。较早轮询的失败响应不能覆盖较新的
   成功刷新或其访问状态提示。
3. **移动授权与图片**：撤销 Agent 的 `head.move` 权限不再无条件清除管理员通过
   `camera.capture` 获取的照片。相机/观察撤权及服务端缓存清理语义继续生效。
4. **页签操作**：增加左右方向键、Home/End、roving tabindex 和可见焦点。
   所有页签关联当前唯一的 `buddy-tab-panel`，面板反向关联当前活动页签，避免
   非活动页签指向不存在的元素。

没有新增前端 UI 单元测试；浏览器验证使用 Playwright 脚本及模拟 API。

## 验证

- contracts、workflow runtime、Buddy bridge/service、Node Host 的 TypeScript 构建通过。
- Node Host、Buddy service、bridge、CLI 的 244 项测试通过。
- 正式前端生产构建、canonical naming 和 runtime architecture 检查通过。
- 完整模拟浏览器脚本通过：21 项能力、28 次手动调用；保留原有权限、纯移动、
  独立拍照和灯光检查，新增状态失败恢复、过期失败、移动撤权保留图像、键盘/ARIA
  关联和全部页签在 320px 下无页面横向溢出的检查。
- 运行脚本：`scripts/qa/buddy-dashboard-playwright.mjs`。
  生产实机脚本：`scripts/qa/buddy-body-live.mjs`。截图及现场报告位于 Git 忽略的
  `output/playwright/`，不包含在源码提交中。

部署使用持久化数据卷和现有私有环境配置，保留旧容器以便回退。生产验收检查
Host 健康、Buddy 页面、回中不拍照、独立采图、手动灯光和授权文件指纹保持一致。
