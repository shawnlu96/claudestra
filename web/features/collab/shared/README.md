# 团队视图（i28-TV1，取代 C4 的另画页面）

侧栏「团队 · 全部 feature」打开的就是本地协作视图 `CollabView`，只是数据源换成中心共享台账：

- `dag/shared-navigation.tsx` 的 `SharedCollabContent` 把 `CollabView` 包进 `TeamSource`（`team-ops.tsx`）。
- `TeamSource` 用 `SharedLedgerSession`（`web/lib/api/shared-ledger.ts`，身份校验、迟到响应作废）建
  `team-source-shared.ts` 的数据源，经 `team-source-context.ts` 注入 `use-collab.ts`；不注入时是本机台账。
- 形状转换在 `team-source-adapter.ts`（纯函数，`tests/web-team-source.test.ts`）：feature = 事项，规划节点 = 任务
  （绑了卡用执行镜像的阶段，没绑的是「规格」），节点 deps = 依赖边。标题一律卡号 + 标题，不拿 UUID 当标题；
  中心没有的字段（事件、时间线、审查、指标）不编，视图显示「暂无」。中心没有事件流：每 5 秒读列表，serverSeq 变了才重拉。
- 团队特有的操作放在本地视图已有的位置：「团队」标签（手机是「团队」整屏）顶上的「团队规划」——新建 feature、
  编辑规划、409 冲突重放、查回执；任务详情里的「团队操作」——开卡 / 绑卡 / 阶段 / 审批（按 capabilities 置灰）。

CAS 提交与冲突规则不变：重写保留已绑卡节点；409 保留草稿和它的基线、显示最新图，必须显式「重读后编辑」；
重读后同事新增的节点保留，绑卡节点只能用最新，并发改 / 删的节点逐条选；网络 / 回包失败保留 requestId 查回执，
从不自动重发（`shared-model.ts`、`shared-rebase.ts`、`use-shared-submission.ts`）。

同屏对照截图（opt-in，回环服务器，不连生产 bridge）：

```sh
SHARED_LEDGER_SHOTS_DIR=<审查目录> [TEAM_VIEW_SNAPSHOT=<仓库外的只读快照 JSON>] \
  bun test tests/web-shared-ledger-browser.test.ts
```

本地视图与团队视图 1400 / 390 × 浅 / 深共 8 张拼成 `compare.png`，每张过 `tests/helpers/ui-shot-checks.ts`
（文字框相交、UUID 标题、横向溢出、文字被挤成竖排）。缺省数据是 `team-fixture-gen.ts` 造的生产形状夹具；
生产快照（含真实标题、peer 名）不进 git，只从 `TEAM_VIEW_SNAPSHOT` 指的仓库外路径读。
