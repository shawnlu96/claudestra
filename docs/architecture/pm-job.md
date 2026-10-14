# PM 处理员：规格内的问题不叫醒 PM（agents-PMJOB1，PMJOB2 放宽白名单）

执行者的 blocker 提问每条都会让当班 PM 带着几十万 token 的上下文跑一轮。处理员是一次性的本机 Codex 会话：只带这张卡的规格、问题原文、批准路径和固定权限说明，回答规格里已经写明的问题；答不了的连同草稿交回 PM。它没有消息发送、规格修改、台账或配置权限，答复由代码核对后投递。

## 开关

- `ledger pm-job-mode off|observe|on --project <id>`：项目真 PM / master / owner 才能切，缺省 `observe`。
- 开关和模式世代放在 PMDIG 的 `pm-digest-mode.json`（`jobProjects` / `jobGens`），PMDIG、PMROUTE 的键原样保留，没有新增恢复键。每切一次世代加一。
- `off`：不读不写任何处理员状态，信封路径和顺序与改前逐字相同。
- `observe`：原通知立刻照常送给 PM，末尾附一行草稿路径（待生成，完成后进摘要）；草稿写好后覆盖同一个文件，再往 PM 摘要队列里记一行（id `pm-job-draft:<askId>`，带 ask 编号、结论和草稿路径），不单独叫醒 PM（agents-PMJOB2 改了 PMJOB1 PM 定 4 的「补一条关联提示」）。不发给执行者。
- `on`：没命中硬门、白名单内、有依据、各项重核都过的才直接回给提问者，PM 不被叫醒，只在 PM 摘要队列里多一行（卡号、问题类型、结论、草稿路径）；其余把原问题和草稿交给 PM。
- `ledger pm-job --project <id>`：只读，最近 24 小时的单数、各状态、直回 / 升级 / 失败、处理员的 Codex 请求数 / 用时 / 字符量、队列等待。对照 PMCOST1 同窗口的 PM 叫醒成本时，这部分 Codex 成本要一起算。

## 接哪些

入口是 `src/bridge/pm-digest.ts` 的 `deliver()`，在 PMROUTE1 分类之后一行调用 `pmJob.intake`（`src/bridge/pm-job.ts`）。只接同时满足下面几条的信封：

- 收件人是项目当班 PM，发送方是 bridge 的台账通知，messageId 是 `ledger-ask:<askId>`；
- asks 表里这条提问还开着，是执行者经 ask 工具开的、挂卡的 blocker 提问（本机执行者或出借池的 `worker@peer`）；
- PMROUTE1 的纯分类结果是 judge（owner 类原路）；
- 找得到规格文件和项目仓库目录（材料缺就不接，PM 照旧处理）。

审查单的提问当场回规则，不到这里。design / scope 带默认做法的提问和测试类扩围有自己的 15 分钟自动定，处理员不碰。人类消息、非 PM 收件人、别的 agent 冒用编号都不接。非提问的 judge 推送首版不接：它们没有可回的提问者。

## 白名单与升级（`src/lib/pm-job-rules.ts`）

可直回的有四类，模型不能自己加：规格已明定的验收编号 / 范围解释（`acceptance`）、已有标准答复的查证（`standard`）、相关文件实现位置的查证（`location`）、规格已定（`specDecided`，agents-PMJOB2：当前规格含「PM 补」已经写明了答案）。

接单时代码按问题原文和候选项判（`gatesOf`），不靠模型自报。匹配前先做 NFKC 归一并去掉零宽字符。门分两种，中文和英文问法都认：

- 硬门：权限、删数据、release、tag、中心限流、schema、改额度线、owner 决策、凭据安全。命中就永远升级，任何类型都越不过。
- 软门：改规格、改范围、要人点头的问法（「可以…吗」「能不能」「要不要」「can I」「should we」「is it ok to」之类）。只命中软门的单子，只能按 `specDecided` 答。

问题正文过全部门；候选项只过硬门（「批准 / 不批准」「扩围」这类候选不挡单，「删掉台账记录」照样挡）。单子记 `forbiddenAll`（全部命中）和 `hard`；`forbidden` 仍是第一个命中，旧单子照常读（没有 `forbiddenAll` 的旧单子，`forbidden` 一律按硬门算）。接单时 `direct = on && !hard`。

PMJOB1 的第三道门「问题要像查证」（问的对象 + 问事实的问法）已去掉：执行者的提问多是「情况说明 + 请定」，这道门几乎挡下所有单子。把关交给下面的输出核对。

- 模型输出要是约定的 JSON、类型在白名单（`toString` 这类继承键不算）、自称有把握、模型自己的答复里没有批准口吻（approved / go ahead / 已批准 / 你可以…）、每条依据都是批准路径里真实存在的 `文件:行`（规格文件本身，或卡的 fileGlobs / 规格和问题里提到的仓库相对路径；越出仓库、软链到仓库外、行号不存在都不算）。任何一条不满足就升级。
- 按接单时的命中分三种：命中硬门，升级；只命中软门，类型必须是 `specDecided`；一道门都没命中，四类都行。
- `specDecided` 的依据只能是规格文件本身（`job.specPath`）的行。答复由代码拼：每条依据一行「规格第 N 行：『<该行原文，截 200 字>』」，后面接模型的一句说明。批准口吻只查模型那句说明，不查代码引用的规格原文，所以「PM 补 已批准」这类原话能原样转给提问方。
- 文件读取范围靠三层：只读沙箱、prompt 只列批准路径、代码拒收批准路径外的依据。Codex 的只读沙箱本身不限制读哪些文件，所以前两层挡不住模型去读别的文件，只有第三层是硬约束。

## 落盘与状态（`src/lib/pm-job-store.ts`）

每单一个文件 `statePath("pm-job/<askId>.json")`，原子写；草稿是同目录的 `drafts/<askId>.md`。字段含项目、卡、ask 编号、原 messageId、规格版本和哈希、规格原文快照 `spec`（≤ 64KB，超过不存）、命中的门（`forbidden` / `forbiddenAll` / `hard`）、提问者、接单时的当班 PM、模式和模式世代、状态、租约、结果、用量。

状态：`queued → running → drafted → sending → sent`；另有 `unknown`（发了但结果不明）、`escalated`、`observed`、`dropped`（提问已不在等回答）。所有迁移在目录锁里读-核-写，bridge 和 worker 谁先迁走谁算。

先落盘再认领：单子和草稿占位都写下了，`on` 才把原通知压下。写不下就按旧路送原通知。

## worker（`src/lib/pm-job-worker.ts`，入口 `src/manager/pm-job-worker.ts`）

独立于 bridge 的一次性进程，由调度服务（`src/scheduler.ts` 的 `runScheduler` 循环，每轮一次，启动后第一轮就扫）经 `pmJobWorkerTick()`（`src/lib/pm-job-spawn.ts`）起成脱离父进程的子进程；bridge 不起 worker、不跑模型。

1. 认领最早一单并发租约。已有一单在跑且租约没过期就不领，所以并发上限是 1，第二个 worker 领不到同一单。
2. 额度门（`pm-job-quota.ts`）：有效线是 `min(70, 项目既有线)`，已用达到线不启动；读不到、未知、过期、应已重置未确认的读数都不算有预算。不改项目额度线，不换 Claude，不借额度。
3. 共享 Codex 槽位（`pm-job-slots.ts`）：`ask_codex`（`src/bridge.ts` 的入口经 `withCodexSlot("ask_codex", …)`，原来的进程内计数已删）和处理员合计不超过 3。槽位文件记 pid 和到期时间，持有者死了或过期就回收。槽位满时把单放回队列。
4. 有规格快照就用快照跑（PM 答问时在规格末尾追加「PM 补」不再让草稿落空）；没有快照的旧单子照旧读文件，哈希对不上就按「规格在提问之后改过」升级。`on` 档投递前的重核不变：提问之后规格变了照样升级。
5. 一次全新的 `runCodex`：不带 thread（不 resume）、只读沙箱、`isolateMcp`（`-c mcp_servers={}`，不加载全局 MCP）。
6. 代码核对输出，草稿和结果原子落盘为 `drafted`。超时、失败、额度异常不重试，写成要升级的草稿。worker 中途死掉的单在下次认领时记成中断，也不重跑。

## 投递与重启（`src/bridge/pm-job.ts` 的 `sweep`）

bridge 启动时扫一次，之后每 30 秒扫一次，不靠新流量。它只做三件事：

- `drafted`：直回候选在锁里重核——提问还开着、单没结清、规格没变、当班 PM 没换、开关还是 on 且模式世代没变、单子与提问的绑定对得上——核过才写 `sending`，然后发一次。本机提问者走台账通知的原投递路径，`worker@peer` 走 PM 回远端的同一条路。确认送达后写 `sent`，以 `system:pm-job` 结案（只答这张单绑定的那一个 ask）。正文开头是「处理员代答，依据 文件:行；有异议回 PM」，带 ask 编号。
- `sending`：本进程没在发的，就是上次发到一半进程没了。标 `unknown`，原问题和草稿交 PM，不重发，也不把提问标成已答。远端没明确收下或网络出错同样是 `unknown`。
- 排队或运行超过 20 分钟没出结果：bridge 接手升级，worker 之后写的结果落空。状态一直写不进时，原问题也会照样交给 PM 一次。

`system:pm-job` 不是新凭据，只是沿用自动定（`system:ask-default`）的系统代答惯例换了一个标签。`recordDefaultPmReply` 没有改，冒充它的发送方过不了原有的 PM 回答校验。跨进程做不到网络层面的 exactly-once：靠 `sending` 先落盘、结果不明不重发来保证最多发一次。

## 已知限制

- 调度服务没在跑时没有进程起 worker：`on` 下的直回候选在 20 分钟时限后由 bridge 升级给 PM，`observe` 的草稿停在「待生成」。
- `ask_codex` 拿不到槽位（满了，或槽位文件读写不了 / 锁被占）都回「Codex 并发已满」，不放行。
- `src/scheduler.ts` 不经 `scheduler-pass.ts` 可达，worker 启动和槽位文件没有进 `SKIP_EFFECT_FILES`；哪天把 tick 挪进 pass，要先定 gate 再登记。
- `-c mcp_servers={}` 是否真的关掉全局 MCP，只核对了参数构造，没有对着真实 Codex CLI 验证。
- PM 在长回合里时，提问通知先进押后队列，回合结束才到投递口，处理员也是那时才接单。
- PM 摘要开关不是 `on` 的项目，摘要队列里的那一行会在下一次定时摘要时单独送出。

## 测试

`tests/pm-job-direct.test.ts`（验收线 1–3）、`tests/pm-job-recovery.test.ts`（4–5）、`tests/pm-job-limits.test.ts`（6）、`tests/pm-job-wiring.test.ts`（起真实的调度服务子进程验证 worker 接线；`ask_codex` 入口与处理员共用槽位；继承键与英文决策问），`tests/pm-job-widen.test.ts`（agents-PMJOB2 验收线 1–4：硬软门、specDecided、规格快照、草稿进摘要），共用 `tests/pm-job-world.test.ts`：真实台账、真实 `openOrderAsk` 和 `deliverPmLocal`，模型、额度和远端发送是可控桩，状态都在临时目录。
