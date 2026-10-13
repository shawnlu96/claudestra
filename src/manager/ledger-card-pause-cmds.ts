/** UXPAUSE1 · card-level pause / resume: the scheduler sends a paused card no new action until it is resumed (lib/card-pause*.ts). */
import { pauseCard, resumeCard } from "../lib/card-pause-write.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const CARD_PAUSE_CMDS: Record<string, CommandSpec> = {
  "card-pause": {
    valued: ["reason"], bools: [],
    usage: "card-pause <task> --reason <一句话>（暂停调度：调度器不再给这张卡发新动作；spec / restate / build / review / fix 阶段可用，card-resume 继续）",
    run: (c: LedgerCli) => ({ ok: true, ...pauseCard(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, reason: c.need("reason") }) }),
  },
  "card-resume": {
    valued: [], bools: [],
    usage: "card-resume <task>（解除 card-pause：下一轮调度按当前阶段原样接上；开关关着也能用）",
    run: (c: LedgerCli) => ({ ok: true, ...resumeCard(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id }) }),
  },
};
