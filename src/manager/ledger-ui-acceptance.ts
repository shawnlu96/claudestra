/**
 * 项目整页验收 CLI（UIACW）：开关、状态、一张 owner 卡批多个 feature、owner 答后 PM 消费、只读核单个 feature。
 * 逻辑在 lib/ui-acceptance-batch.ts（源）与 lib/ui-acceptance-batch-wiring.ts（开关 / 完成闸）；这里只解析参数。
 * owner 卡的答复回投发起 PM（fromChannelId 取 registry 里调用者的频道），PM 收到后跑 ui-page-verify。
 */
import { readFileSync } from "node:fs";
import { appendEvent } from "../lib/ledger-write.js";
import { LedgerError } from "../lib/ledger-store.js";
import { UiAcceptanceBatch } from "../lib/ui-acceptance-batch.js";
import { batchContext, currentPageSource, installPageBatchCheck, PAGE_MODES, readPageMode, writePageMode, type PageMode } from "../lib/ui-acceptance-batch-wiring.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

// feature-set 的完成闸经它查源（wiring 不能直接导入 batch，否则与 ledger-feature-write 成环）
installPageBatchCheck((db, c, featureId) => new UiAcceptanceBatch(db).check(c, featureId));

function intFlag(c: LedgerCli, flag: string): number {
  const raw = c.need(flag);
  if (!/^\d+$/.test(raw)) throw new LedgerError("invalid", `--${flag} 要是非负整数`);
  return Number(raw);
}

type Requests = Parameters<UiAcceptanceBatch["propose"]>[2];
/** --evidence 是私有 json 文件：{ "<featureId>": { evidence: {...}, verdict?: "approve" | "reject" } }，键必须与 --features 一一对应 */
function requests(c: LedgerCli): Requests {
  const ids = c.need("features").split(",").map((s) => s.trim()).filter(Boolean);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(c.need("evidence"), "utf-8")); }
  catch (e) { throw new LedgerError("invalid", `--evidence 读不出 json：${(e as Error).message}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LedgerError("invalid", "--evidence 要是 featureId → {evidence, verdict} 的对象");
  const map = raw as Record<string, { evidence?: unknown; verdict?: unknown } | null>;
  const extra = Object.keys(map).filter((k) => !ids.includes(k));
  if (extra.length) throw new LedgerError("invalid", `--evidence 里有不在 --features 的 feature：${extra.join("、")}`);
  return ids.map((featureId) => {
    const x = map[featureId];
    if (!x || typeof x !== "object") throw new LedgerError("invalid", `--evidence 缺 feature ${featureId}`);
    return { featureId, evidence: x.evidence, verdict: x.verdict } as Requests[number];
  });
}

async function context(c: LedgerCli) {
  const project = c.project();
  const reg = await c.deps.loadRegistry();
  return batchContext(project, c.deps.actor, c.deps.now(), reg.agents[c.deps.actor]?.channelId || null);
}

const sourceView = (s: ReturnType<UiAcceptanceBatch["verify"]>) => ({
  sourceId: s.sourceId, revision: s.revision, askId: s.askId, state: s.state,
  features: s.entries.map((e) => ({ featureId: e.scope.featureId, verdict: e.verdict, dagVersion: e.scope.dagVersion, ui: e.scope.ui.map((n) => n.taskId) })),
});

export const UI_PAGE_BATCH_CMDS: Record<string, CommandSpec> = {
  "ui-page-mode": {
    valued: ["project", "dedup"], bools: [],
    usage: "ui-page-mode on|observe|off [--project]（项目整页验收开关；缺省 observe = 原单 feature PAGEOK 闸；PM / master / owner，记 note）",
    run(c) {
      const mode = c.p.pos[1] as PageMode;
      if (!PAGE_MODES.includes(mode)) throw new LedgerError("invalid", "ui-page-mode on|observe|off");
      const project = c.project();
      c.requireManager(project, "切项目整页验收开关");
      const previous = writePageMode(project, mode);
      const r = appendEvent(c.db, c.ctx(), { project, target: "", kind: "note", text: `项目整页验收开关 ${previous} → ${mode}（ui-page-mode）` });
      return { ok: true, project, mode, previous, event: r.event, duplicate: r.duplicate };
    },
  },
  "ui-page-status": {
    valued: ["project"], bools: [],
    usage: "ui-page-status [--project]（开关、当前验收源 revision / state、observe 诊断；只读）",
    run(c) {
      const project = c.project();
      const { mode, diagnostic } = readPageMode(project);
      const batch = new UiAcceptanceBatch(c.db);
      const diagnostics = [...(diagnostic ? [diagnostic] : []), ...batch.diagnostics({ ...batchContext(project, c.deps.actor), mode })];
      return { ok: true, project, mode, source: currentPageSource(c.db, project), diagnostics };
    },
  },
  "ui-page-propose": {
    valued: ["project", "features", "expect-rev", "evidence"], bools: [],
    usage: "ui-page-propose --features <f1,f2,...> --expect-rev <n> --evidence <私有 json：featureId→{evidence,verdict}> [--project]（仅 on；一张 owner 卡绑全部 feature）",
    async run(c) {
      const ctx = await context(c);
      const s = new UiAcceptanceBatch(c.db).propose(ctx, intFlag(c, "expect-rev"), requests(c));
      const next = s.state === "pending" ? `待 owner 在卡上批（ask ${s.askId}）：答复会投回你，收到后跑 ui-page-verify --rev ${s.revision} --ask ${s.askId}` : "已 verified";
      return { ok: true, project: ctx.project, ...sourceView(s), next };
    },
  },
  "ui-page-verify": {
    valued: ["project", "rev", "ask"], bools: [],
    usage: "ui-page-verify --rev <n> --ask <askId> [--project]（owner 答后 PM 跑；消费前任何漂移整笔拒）",
    async run(c) {
      const ctx = await context(c);
      const s = new UiAcceptanceBatch(c.db).verify(ctx, intFlag(c, "rev"), c.need("ask"));
      return { ok: true, project: ctx.project, ...sourceView(s) };
    },
  },
  "ui-page-check": {
    valued: ["project"], bools: [],
    usage: "ui-page-check <featureId> [--project]（只读核单个 feature 能否凭项目验收源放行）",
    async run(c) {
      const featureId = c.p.pos[1];
      if (!featureId) throw new LedgerError("invalid", "ui-page-check <featureId>");
      const ctx = await context(c);
      const r = new UiAcceptanceBatch(c.db).check(ctx, featureId);
      return { ok: true, project: ctx.project, featureId, mode: ctx.mode, pass: r.ok, ...(r.reason ? { reason: r.reason } : {}) };
    },
  },
};
