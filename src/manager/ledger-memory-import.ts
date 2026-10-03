/** Local JSONL import; dry-run opens a reader connection via DRY_RUN_READS and cannot migrate the source schema. */
import { readFileSync } from "node:fs";
import { applyMemoryImport, IMPORT_ISSUES, planMemoryImport, type ImportPlan } from "../lib/memory-import.js";
import { writeMemoryImportReport } from "../lib/memory-import-report.js";
import { importVectors } from "../lib/memory-import-vectors.js";
import { pickEmbedder, readEmbedConfig, type Embedder } from "../lib/memory-embed.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const LABELS = ["格式 / 长度错误", "脱敏命中（只报字段位置）", "重复", "锚点不存在或不一致", "memoryLint 拒绝"];

export function renderMemoryImportReport(plan: ImportPlan): string {
  const lines = ["# 项目记忆导入检查", "", `清单摘要：${plan.digest}`,
    `可导入：${plan.rows.filter((r) => !r.replay).length}；已导入：${plan.rows.filter((r) => r.replay).length}；问题：${plan.issues.length}`, ""];
  IMPORT_ISSUES.forEach((kind, i) => {
    lines.push(`## ${i + 1}. ${LABELS[i]}`, "");
    const issues = plan.issues.filter((p) => p.kind === kind);
    lines.push(...(issues.length ? issues.map((p) => `- 行 ${p.line}：${p.reason}`) : ["无。"]), "");
  });
  const anchored = plan.rows.filter((r) => r.memory.taskId);
  if (anchored.length) {
    lines.push("## 卡锚点解析版本", "");
    for (const r of anchored) {
      lines.push(`- 行 ${r.line}（${r.replay ? "已导入历史版本" : "本次解析"}）：head=${r.memory.head}, specRev=${r.memory.specRev}`);
    }
    lines.push("");
  }
  const home = plan.rows.filter((r) => r.memory.visibility === "home");
  if (home.length) lines.push(`仅留本机的行：${home.map((r) => r.line).join(", ")}（不会共享）。`, "");
  return lines.join("\n");
}

/** Inject an embedder for isolated tests; production selects only the configured providers. */
export async function memoryImportCmd(c: LedgerCli, embedder?: Embedder | null) {
  const dry = c.p.bools.has("dry-run");
  if (!dry && c.p.flags.out !== undefined) throw new LedgerError("invalid", "--out 只随 --dry-run 使用");
  const project = c.project();
  if (!dry) c.requireRealPm(project, "记忆导入");
  const raw = readFileSync(c.need("file"), "utf8");
  const ctx = { actor: c.deps.actor === "unknown" ? "reader" : c.deps.actor, now: c.deps.now() };
  const was = (c.db.query("PRAGMA query_only").get() as { query_only: number }).query_only;
  let vectors;
  let plan: ImportPlan;
  c.db.exec("PRAGMA query_only = ON");
  try {
    const first = planMemoryImport(c.db, ctx, project, raw);
    vectors = await importVectors(c.db, first, embedder === undefined ? await pickEmbedder(readEmbedConfig()) : embedder);
    plan = planMemoryImport(c.db, ctx, project, raw, vectors);
  } finally {
    c.db.exec(`PRAGMA query_only = ${was ? "ON" : "OFF"}`);
  }
  if (!dry) {
    c.requireRealPm(project, "记忆导入");
    return { ok: true, ...applyMemoryImport(c.db, ctx, project, raw, vectors, () => c.requireRealPm(project, "记忆导入")) };
  }
  const markdown = renderMemoryImportReport(plan);
  const out = c.p.flags.out;
  if (out) writeMemoryImportReport(out, c.db.filename, markdown);
  return { ok: true, dryRun: true, clean: plan.issues.length === 0, issues: plan.issues,
    writes: plan.rows.filter((r) => !r.replay).length, replayed: plan.rows.filter((r) => r.replay).length,
    ...(out ? { report: out } : { markdown }) };
}

export const MEMORY_IMPORT_CMDS: Record<string, CommandSpec> = {
  "memory-import": {
    valued: ["file", "out", "project"], bools: ["dry-run"],
    usage: "memory-import --file <清单.jsonl> [--dry-run [--out <报告.md>]] [--project <id>]（正式导入仅 PM / owner，先备份、单事务）",
    run: memoryImportCmd,
  },
};
