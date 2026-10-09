/** Typed UI takeover diagnostic, recomputed by the writer; no caller-controlled note text or policy bypass. */
import { getLendOrder } from "../lib/ledger-lend.js";
import { LedgerError } from "../lib/ledger-store.js";
import { takeoverRefusal } from "../lib/lend-pr-takeover-ledger.js";
import { uiTakeoverRefusal } from "../lib/lend-pr-takeover-refusal.js";
import { writeTakeoverRefusal } from "../lib/lend-pr-takeover-refusal-diagnostic.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import type { TakeoverDeps } from "../lib/lend-pr-takeover-ledger.js";

export function takeoverRefusalCommands(make: () => TakeoverDeps): Record<string, CommandSpec> {
  return { "lend-takeover-refusal": {
    valued: ["head", "pr"], bools: [], usage: "lend-takeover-refusal <orderId> --head <sha> [--pr <n>]（当前 UI 接管阻塞诊断）",
    async run(c) {
      const orderId = c.p.pos[1] ?? "", head = c.need("head"), pr = intFlag(c.p, "pr") ?? null;
      if (!/^[0-9a-f]{40}$/.test(head) || (pr !== null && (!Number.isSafeInteger(pr) || pr < 1))) throw new LedgerError("invalid", "诊断要完整 head 与有效 PR 号");
      const o = getLendOrder(c.db, orderId);
      if (!o) throw new LedgerError("not_found", "没有该出借单");
      if (c.deps.actor !== "scheduler") c.requireRealPm(o.project, "记录出借接管阻塞诊断");
      c.deps.assertLease?.();
      if (takeoverRefusal(c.db, orderId, c.deps.now()) !== null) return { ok: true, message: null };
      if (head === o.head) return { ok: true, message: null };
      const deps = make();
      const remote = await deps.remoteHead(o.repo, o.branch as string);
      if (!remote.ok) throw new LedgerError("conflict", "诊断远端 head 无法核验");
      if (remote.head !== head) return { ok: true, message: null };
      const r = uiTakeoverRefusal(c.db, orderId, head, deps.uiPort);
      const message = r ? writeTakeoverRefusal(c.db, orderId, head, pr, r, c.deps.now, () => c.deps.assertLease?.()) : null;
      return { ok: true, message };
    },
  } };
}
