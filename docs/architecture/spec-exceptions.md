# 规格「精准例外」与执行者提问的默认定（ASKDEF1）

## 精准例外是什么

精准例外 = PM 在规格里点名允许改、但**不进本卡 fileGlobs** 的文件，每个带一句限制（例如「只加一行」「只透传 level」）。
执行者问「能不能改 X 一行」时，系统按规格里列的例外机读答复，不再叫醒 PM。

解析：`src/lib/spec-exceptions.ts`（`parseSpecExceptions`），纯函数。

## 格式

推荐写独立一节，**每行一个文件 + 限制**：

```markdown
## 精准例外

- `src/lib/recovery-keys.ts` 按字母序插 `askDefaultAll` 一行
- `src/bridge/ask-expire.ts` 注入 sendLedgerNotice 的那一处只加 level 透传（不超过 3 行）
- `src/lib/scheduler-v2-skip-effects.ts` 只登记本卡新增副作用模块，交付前 `bun run skip-effects --check` 退出 0
```

规则：

- 节标题必须是二级标题、正文就是 `## 精准例外`；到下一个一级 / 二级标题为止（三级子标题算在本节内）；代码块里的行不算。
- 文件路径写在反引号里，或者直接写在行内（行内写法要带 `/`；仓库根下的文件如 `package.json` 请放进反引号）。
- 只认**仓库相对路径**：不认通配（`*` `?` `[]` `{}`）、绝对路径、`.` / `..` 段。写了通配的条目会被列成解析失败，不会放行。
- 反引号里的标识符（`askDefaultAll`、`SweepDeps.notify`）不当成路径；一行里没有路径的整行记为解析失败。
- 一行里写了多个文件，每个文件都按这一行的限制登记。

兼容现有写法：`## 范围…` 节内以「精准例外」开头的段落，冒号后按顶层分号（`；` / `;`，括号里的不算）拆成多条：

```markdown
## 范围（DAG globs）

- src/lib/order-ask.ts

精准例外（不进 fileGlobs，交付说明逐条列）：src/lib/recovery-keys.ts 按字母序插一行；src/lib/scheduler-v2-skip-effects.ts 只登记新增模块。
```

## spec-lint（非阻断）

`lintSpecExceptions(text, fileGlobs)`（`src/lib/spec-lint.ts`）只出提示、不拦开卡：

- 精准例外里的文件又被本卡 fileGlobs 盖住了（例外就没意义了）：提示 PM 二选一；
- 解析不出来的行（没有路径 / 写了通配）逐条列出行号。

生产接线：`askDefaultAll` 不是 off 时，写单上的提问开出（`openOrderAsk` 读本卡规格时）顺带跑一次，有提示就在卡上记一条 note（op `spec_exceptions_lint`，同一卡同一组提示只记一次）给 PM。开卡预检（`dag-tools-start.ts`）不在本卡文件范围内，暂不接。

## 执行者提问怎么处理（恢复键 `askDefaultAll`）

档位走 recovery-policy（缺省 observe，上线后按「上线后 PM」的自动转正行转 on）：

- **off**：与改前逐字一致。
- **observe**：行为照旧；每条本会被自动处理的提问在卡上记一条 note（`op: recovery_observe`，`mechanism: askDefaultAll`，`would: default | blocker | exception`）。
- **on**：
  - 远端出借写单（`lend_orders.step` = write / fix）上 class=design / scope、带 default 的提问：和本机写单一样不阻塞，PM 拿到通知 15 分钟没回就按默认定，结论经 `tell` 发给远端执行者。
  - class=blocker：必须带 default，否则 `invalid_wire`（「blocker 也要写你打算怎么做」）；仍阻塞执行者，15 分钟没回按 default 定并告诉执行者（远端经 `tell`，本机经 notify 发给执行者本人）。
  - class=scope 带 files、files 全部在本卡规格的精准例外里：当场答「规格精准例外已列：<文件>，按规格写的限制改，交付说明逐条列」，不等 15 分钟、不通知 PM；部分命中 / 没命中照上面 15 分钟默认。
  - 每次自动定 / 自动答在卡上记一条 note（`op: ask_default_all`）。

永远等 PM（结构化判断，不看正文）：提问标了 `risk`（`delete_data` / `permission` / `security` / `schema`）；卡首 `模板：security`；读不到本卡规格；没写 class 的旧版提问。其中 risk 与 security 模板（没写 class 但带 risk / files 的提问同样判）开出时记进 `extra.held`，扫描对这类提问的所有自动定 / 自动批准一律不碰——包括 i28-ASK4 的 tests/ 扩围自动批准（off 档不记，与改前一致）。

PM 在 15 分钟内回（`send_to_agent` 正文带 `ask <id>`，或网页作答）以 PM 为准；晚于自动定的回复按现有「已按默认定」回执处理，不翻案。i28-ASK4 的 tests/ 扩围自动批准、审查单自动答不变。

远端出借：借方 `lend-tools.ts` askPeer 把 class / default / risk 有值时发给出借方（旧版出借方不认、回 invalid 时去掉这三项重发）；出借方 `lend-wire-v2.ts` parseAsk 宽松收：不认识的值丢掉当没写，default 截断到 600 字，不因这三项拒掉整条提问。

## 通知级别

`SweepDeps.notify` 必填 level：补投的不阻塞提问、自动定的结论 = `info`；blocker / risk 提问、追加失败告警 = `action`。

测试：`tests/spec-exceptions.test.ts`、`tests/spec-lint-exceptions.test.ts`、`tests/order-ask-default-all.test.ts`、`tests/order-wire-ask-default-all.test.ts`。
