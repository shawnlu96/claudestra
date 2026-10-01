# 谁在干活

`GET /api/v1/ledger/:project/work` 与台账使用相同的全范围 owner 权限门。
路由在一个 deferred 事务中读取快照；不派单、不推进调度、不写库，不读取 peer 凭据。

三栏按任务卡而非 agent 分行。在等优先使用 blocking ask、lend_orders、合并意图阶段，
其余 auto 卡调用 autoSnapshot + planScheduler 的只读规划；manual 卡保留调度视图与退回事件的原因。
已领 peer 单显示 `peer:<机器> · <家族>`，心跳 publishing 单独显示交付中。
子 DAG 待做节点按未满足依赖和是否有规格分组。负责人认人仍由原 dag-progress.ts 负责。

## 估时

事件阶段时间线中，已经离开的步骤才是样本。取本项目最近七天结束的步骤，
每类至少五个样本才取中位数（偶数取中间两个的平均数）。当前未结束步骤不参与样本。
样本不足时，节点 estimate 按常规步骤权重折算；没有 estimate 则使用缺省分钟数：
复述 10、写 60、审 30、修 30、合并 15、部署 15。节点折算权重总量为 130
（复述、写、审、合并、部署的总和；修复是额外一轮）。

卡剩余时间是 `max(本步骤常规时长 - 已用分钟, 0) + 后续步骤常规时长`。
code 的复述后有写、审、合并，写后有审、合并，审后有合并，修后补一轮审再合并。
已用超过常规只显示超出的分钟数，剩余值不会变成负数。

节点尚未开工时：S = 30 分、半天 = 240 分、一天 = 480 分，区间取中值，
小时和分钟按单位换算；无法解析的 estimate 使用 120 分。
全部做完取依赖关键路径与总工作量 / 可用并发名额的较大值，向上取整到小时。
关键路径以当前子 DAG 为主，图外卡使用台账依赖。零可用名额或依赖环返回未知。
机器可用名额取本机配置减去已持有的 worker 槽，以及仍获授权、hello 新鲜且未暂停的
peer 余位，peer 两个家族之和还受共享 maxOpen 余量约束。

## 浏览器验证

使用 V1h collabLoader 的 2 秒指数重试、30 秒封顶与 AbortController。
请求失败保留上次数据，以旋转的 lucide refresh-cw 表示重试；页面隐藏时不刷新，
恢复前台立即补拉。成功后每 30 秒刷新。切换项目时旧项目数据不显示。

`WORK_BOARD_BROWSER=1 bun test tests/web-work-board-browser.test.ts`
使用真实 headless Chromium 和随机端口的独立服务，不连接生产 bridge。
截图写入 `ledger/reviews/i28-WB1-shots/`；390 宽验证分段切换，1400 宽验证三栏。
