# i28-ASK2 自查（含 PM 补充 A–E）

1. design/scope：本机写/修单必填 default，按 Unicode 字符计数≤600；返回 blocking=false/“按默认继续”，通知 PM，明确 ask id。缺默认拒收；通知失败仍登记，可同参补投。派单共享提示及工具 schema 已更新。
2. blocker、旧本机报文行为保留。按 PM E：出借池远端 ask 一律 blocker，lend-tools.ts / local-api/lend.ts 未改、远端协议未扩字段；ASK1 审查单分级答复保留。
3. 按 PM C/D：唯一 15 分钟常量，扫描接 bridge ask 到期定时器。route_to_agent 仅用 callerOf 已验证身份，核对卡 PM、执行者目标及正文明确 ask id；无 id 不关闭。网页作答也抑制自动定。自动决定与待追加任务先落库，追加前持久化原文件字节位置/摘要；部分写入、写完未记账、重启、重复扫描均不重复追加。
4. 按 PM A/B：order-deliver 交付后登记；review-order、scheduler-work-order、ledger-lend 三处共用“未登记则补登记”入口及同一去重键。实际 PR base...head numstat，列增删行数，二进制注明无行数，重命名两端均检查。规格外共改记录运行卡号及“两边保留”，理由不足按 P2。对象缺失先 fetch，失败写未能登记事件且不挡派审；后续可补齐。长列表完整保存在事件，审查单按 wire 容量带列表/引用，避免溢出阻塞。
5. 规格只以 append 模式写、fsync；恢复前核对原前缀，永不覆盖已有字节。追加“自动定(时间)”、问题、默认方案，并按 PM D 写“PM 若已另行答复，以规格里 PM 定为准”。
6. 最新定向回归 85/85 通过（10 文件、599 断言）；tsc、以订单起点为基准的 strict guard、6 个入口 build 通过。bun run check 已运行，但本机全量未绿（身份、DAG、usage-cache、ACP 子进程等）；DAG 规格路径的 5 个失败在起点独立复现。全量运行中修订过的通知失败/长列表案例已用新进程定向复验通过。未把其它本机失败归因为已证实的基线问题，也未宣称 CI 通过；全量最终以服务创建 PR 后 head 上 CI 三项为准。

规格例外：按 PM A–D 接线；scheduler-auto-tick 仅透传 db 给审查构造，无登记扫描。实际工具 schema 位于 src/lib/order-tools.ts，共享写单模板位于 order-standard-answers.ts；同步调整它们及旧提示断言。summary.txt/selfcheck.md 为本单要求的交付材料。

通信：PM 补充已落实；worker 的 reply 帧被本机 bridge 拒绝，因此通过本次交付回执回报。
