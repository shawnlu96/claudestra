# i28-V1p 截图与浏览器证据

复现：`DONE_BROWSER=1 TZ=Asia/Shanghai bun test tests/web-collab-done-browser.test.ts`。

夹具固定 90 张已完成卡。服务端在 2026-10-02 02:00（上海），浏览器在 2026-10-01 11:00（洛杉矶）；卡片完成于浏览器今日、服务器昨日。首屏包含最近 30 张；第一页取 50 张，最后一页取 10 张。

- `light/dark-mobile-390-first.png`：390×844 手机首屏，今日完成 30 张且带步骤点。
- `light/dark-mobile-390-next.png`：展开「更早完成」后自动翻页，当日溢出卡仍带步骤点。
- `light/dark-desktop-first.png`、`*-desktop-next.png`：桌面已完成大纲首屏、翻页。
- 四份 `*-evidence.json`：实际请求游标与墙钟时间、浏览器异常、溢出检查。第二次请求模拟 503，第三次约 2 秒后自动重试同一游标，已有数据保留。

截图使用真实 React 组件与生产 CSS；接口通过 Playwright 路由在进程内调用真实 projectView/donePage，未启动服务或修改生产状态。此处为测试证据，生产字节数待 PM 实测。
