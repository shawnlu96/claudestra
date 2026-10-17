/** The replay command always receives the manager's query-only ledger connection; all evidence reads are local. */
import { LedgerError } from "../lib/ledger-store.js";
import { replaySelectedHistory } from "../lib/ci-selected-replay.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const CI_SELECTED_REPLAY_CMDS: Record<string, CommandSpec> = {
  "ci-selected-replay": {
    valued: ["days"],
    usage: "ci-selected-replay <项目> --days <N>（只读：逐次回放退回前的完整证据，假设 on，不改变闸或阶段）",
    run: (c) => {
      const project = c.p.pos[1], raw = c.p.flags.days;
      if (!project || !c.deps.projectIds.includes(project)) throw new LedgerError("invalid", "要带已登记的项目 id");
      if (!raw || !/^[1-9]\d*$/.test(raw)) throw new LedgerError("invalid", "要带 --days <正整数>");
      return replaySelectedHistory(c.db, project, Number(raw), c.deps.now());
    },
  },
};
