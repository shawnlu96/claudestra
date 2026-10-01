/** UI screenshot gate CLI: PM accepts or rejects a UI card's before / after screenshots, and marks the cards the owner must see. */
import { recordUiVerdict, setOwnerVisual } from "../lib/ledger-ui-approve.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const UI_CMDS: Record<string, CommandSpec> = {
  "ui-approve": {
    valued: ["head", "digest", "text", "dedup"], bools: [],
    usage: "ui-approve <task> --head <完整 sha> --digest <截图摘要> [--text]（PM 看过前后截图、通过；绑定当前 head / 规格版本 / 轮次 / 摘要）",
    run(c) {
      const r = recordUiVerdict(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, verdict: "approve", head: c.need("head"), digest: c.need("digest"),
        text: c.p.flags.text });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
  "ui-reject": {
    valued: ["text", "head", "digest", "dedup"], bools: [],
    usage: "ui-reject <task> --text <意见> [--head <sha> --digest <摘要>]（PM 不通过前后截图：卡退回 fix，意见进下一轮修复单）",
    run(c) {
      const r = recordUiVerdict(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, verdict: "reject", text: c.need("text"),
        head: c.p.flags.head, digest: c.p.flags.digest });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
  "ui-owner-visual": {
    valued: ["dedup"], bools: [],
    usage: "ui-owner-visual <task> on|off（on = 改整体观感，合并前 owner 看截图；off = PM 验收）",
    run(c) {
      const v = c.p.pos[2];
      if (v !== "on" && v !== "off") throw new LedgerError("invalid", "ui-owner-visual <task> on|off");
      const r = setOwnerVisual(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, on: v === "on" });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
};
