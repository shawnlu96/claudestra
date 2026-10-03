import type { Database } from "bun:sqlite";
import { isManager } from "./ledger-checks.js";
import { resolveFeature } from "./ledger-feature.js";
import { storedOrigin } from "./ledger-origin.js";
import { LedgerError } from "./ledger-store.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";

const edge = { type: "object", required: ["from", "to"], additionalProperties: false,
  properties: { from: { type: "string" }, to: { type: "string" }, note: { type: "string", maxLength: 60 } } };
export const FEATURE_DEPS_TOOL = {
  name: "set_feature_deps",
  description: "PM / master / owner: add or remove multiple product feature dependencies. from is the prerequisite; to waits for from. Same project only; cycles rejected.",
  inputSchema: { type: "object" as const, properties: {
    add: { type: "array", items: edge, maxItems: 200 }, remove: { type: "array", items: edge, maxItems: 200 },
  }, additionalProperties: false },
};
interface Deps {
  db(): Database | null;
  manager(args: string[], channelId: string): Promise<any>;
}

/** The verified channel supplies CLI identity; this module only reads the bridge connection. */
export async function setFeatureDeps(deps: Deps, call: VerifiedCall, args: unknown): Promise<OrderToolResult> {
  const db = deps.db();
  if (!db) return refuse("no_ledger", "台账库打不开");
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new LedgerError("invalid", "参数要是对象");
    const a = args as Record<string, unknown>;
    const ops: { cmd: string; from: string; to: string; note: string }[] = [];
    for (const key of ["remove", "add"] as const) {
      const entries = a[key] ?? [];
      if (!Array.isArray(entries) || entries.length > 200) throw new LedgerError("invalid", "add / remove 要是 ≤200 项数组");
      for (const raw of entries) {
        if (!raw || typeof raw !== "object" || typeof raw.from !== "string" || typeof raw.to !== "string") throw new LedgerError("invalid", "缺 from / to");
        const from = resolveFeature(db, raw.from, storedOrigin(db)), to = resolveFeature(db, raw.to, storedOrigin(db));
        if (!isManager(db, call.agent, { project: from.project, agent: null })) return refuse("forbidden", "只有 PM / master / owner 能改 feature 依赖");
        if (from.project !== to.project) throw new LedgerError("invalid", "feature 依赖只能连同一个项目");
        const note = raw.note ?? "";
        if (typeof note !== "string" || [...note].length > 60) throw new LedgerError("invalid", "note 要是 ≤60 字文字");
        ops.push({ cmd: key === "add" ? "feature-dep-add" : "feature-dep-rm", from: from.id, to: to.id, note });
      }
    }
    if (!ops.length) throw new LedgerError("invalid", "至少带一项 add / remove");
    const results = [];
    for (const op of ops) {
      const r = await deps.manager(["ledger", op.cmd, op.from, op.to, ...(op.cmd === "feature-dep-add" ? [`--note=${op.note}`] : [])], call.channelId);
      if (!r?.ok) return refuse(r?.code ?? "ledger", `${r?.error ?? "写入失败"}（已完成 ${results.length} 项）`);
      results.push(r);
    }
    return { ok: true, results };
  } catch (e) {
    return refuse(e instanceof LedgerError ? e.code : "invalid", (e as Error).message);
  }
}
