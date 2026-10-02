import type { Database } from "bun:sqlite";
import { projectNodes } from "./ledger-feature.js";
import { bucketOf } from "./ledger-feature-migrate.js";
import { getTask } from "./ledger-store.js";
import type { SplitPlan } from "./ledger-feature-split-plan.js";

export function renderSplitReport(db: Database, plan: SplitPlan): string {
  const lines = [`# feature-split ${plan.source.id} v${plan.source.currentVersion}`, "", "## 拒绝原因",
    ...(plan.rejected.length ? plan.rejected.map((s) => `- ${s}`) : ["无"]), "", "## feature 依赖",
    ...plan.deps.map((d) => `- ${d.from} → ${d.to} ${d.note ?? ""}`)];
  for (const g of plan.groups) {
    const views = projectNodes(db, g.nodes);
    const done = views.filter((v) => v.satisfied).length;
    const active = g.nodes.filter((n) => {
      const t = n.taskId ? getTask(db, n.taskId) : null;
      return t && bucketOf(t) === "active";
    }).length;
    lines.push("", `## ${g.title} (${g.id})`, `total ${g.nodes.length} / done ${done} / active ${active}`);
    for (const v of views) lines.push(`- ${v.key} / ${v.status} / ${v.taskId ?? "无卡"}${v.droppedDeps?.length ? `；已满足依赖移除：${v.droppedDeps.join(", ")}` : ""}`);
  }
  lines.push("", "## 副本演练（PM 执行）", "",
    "导出到隔离状态目录后，以 CLAUDESTRA_STATE_DIR 指向副本目录执行以下命令；勿指向生产。",
    "先保存进行中卡的 scheduler-observe 输出，再拆分并比对同卡的输出。",
    "```sh", "bun src/manager.ts ledger export --sqlite <副本>",
    `bun src/manager.ts ledger feature-split ${plan.source.id} \\`, "  --plan <映射.json> --dry-run --out <报告.md>",
    `bun src/manager.ts ledger feature-split ${plan.source.id} \\`, "  --plan <映射.json> --dedup <唯一迁移键>",
    "bun src/manager.ts ledger dag-show <feature>", "bun src/manager.ts ledger scheduler-observe <卡>", "```",
    "在隔离 sandbox 的 GET /ledger/:project/dag 核对产品图，报告及调度对比附 PR。");
  return lines.join("\n") + "\n";
}
