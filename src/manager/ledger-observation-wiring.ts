/**
 * agents-PMAUTO1 两组命令进 `ledger` 入口的接线：manager/ledger.ts 只展开 PMAUTO_CMDS、把 PMAUTO_SERVICE 并进调度身份的命令白名单。
 * 调度服务身份只多这两条：observation-due（到期核对，命令里要调度租约）和 p2-backlog-record（P2 入积压的写口，同样要租约）；
 * 登记 / 撤销 / 标误判 / 清标记 / 放回重核不在名单里，调度身份调不到，仍只有项目 PM / master / owner。
 * 只读的 observation-plans / p2-backlog 在 manager/write-commands.ts 的 LEDGER_READ_SUBS 里。tests/p2-backlog-entry.test.ts。
 */
import { observationCmds } from "./ledger-observation-cmds.js";
import { p2BacklogCmds } from "./ledger-p2-backlog-cmds.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const PMAUTO_CMDS: Record<string, CommandSpec> = { ...observationCmds(), ...p2BacklogCmds() };
export const PMAUTO_SERVICE: ReadonlySet<string> = new Set(["observation-due", "p2-backlog-record"]);
