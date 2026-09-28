/**
 * `ledger dep-add / dep-set / dep-rm / deps`：台账依赖边（docs 10-ledger §3「依赖边」）。写入与权限在 lib/ledger-deps-write.ts
 * （PM 名单 / master / owner，执行者被拒）；这里先按同一口径拦一次，报错能带上用法。
 */
import { DEP_KINDS, DEP_STATES, depViews, runnableTasks, type DepKind, type DepState } from "../lib/ledger-deps.js";
import { addDep, removeDep, setDep, type DepPatch } from "../lib/ledger-deps-write.js";
import { LedgerError, listDeps, listTasks } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function ends(c: LedgerCli): { from: string; to: string } {
  const from = c.task(c.p.pos[1]);
  const to = c.task(c.p.pos[2]);
  c.requireManager(from.project, "改依赖");
  return { from: from.id, to: to.id };
}

function kindFlag(c: LedgerCli): DepKind | undefined {
  const v = c.p.flags.kind;
  if (v !== undefined && !DEP_KINDS.includes(v as DepKind)) throw new LedgerError("invalid", `--kind 只能是 ${DEP_KINDS.join(" / ")}`);
  return v as DepKind | undefined;
}

/** --state auto = 清掉手动值、回到推导 */
function stateFlag(c: LedgerCli): DepState | null | undefined {
  const v = c.p.flags.state;
  if (v === undefined) return undefined;
  if (v === "auto") return null;
  if (!DEP_STATES.includes(v as DepState)) throw new LedgerError("invalid", `--state 只能是 ${DEP_STATES.join(" / ")} / auto`);
  return v as DepState;
}

function depAdd(c: LedgerCli): Result {
  const e = ends(c);
  const r = addDep(c.db, c.ctx(), { ...e, when: c.need("when"), kind: kindFlag(c), state: stateFlag(c) ?? null });
  return { ok: true, dep: r.row, event: r.event, duplicate: r.duplicate };
}

function depSet(c: LedgerCli): Result {
  const e = ends(c);
  const rev = intFlag(c.p, "rev");
  if (rev === undefined) throw new LedgerError("invalid", "改依赖要带 --rev（deps 里看当前 rev）");
  const patch: DepPatch = {};
  const kind = kindFlag(c);
  const state = stateFlag(c);
  if (kind !== undefined) patch.kind = kind;
  if (state !== undefined) patch.state = state;
  if (c.p.flags.when !== undefined) patch.when = c.p.flags.when;
  const r = setDep(c.db, c.ctx(), { ...e, rev, patch });
  return { ok: true, dep: r.row, event: r.event, duplicate: r.duplicate };
}

function depRm(c: LedgerCli): Result {
  const r = removeDep(c.db, c.ctx(), { ...ends(c), rev: intFlag(c.p, "rev") });
  return { ok: true, event: r.event, duplicate: r.duplicate };
}

/** 只读：项目全部边（带推导值与最终状态）+ 可执行任务；带任务 id 只看跟它相连的边 */
function deps(c: LedgerCli): Result {
  const id = c.p.pos[1];
  const project = id ? c.task(id).project : c.project();
  const tasks = listTasks(c.db, project);
  const views = depViews(listDeps(c.db, project), tasks);
  const shown = id ? views.filter((d) => d.from === id || d.to === id) : views;
  return { ok: true, project, deps: shown, runnable: runnableTasks(tasks, views).map((t) => t.id) };
}

export const DEP_CMDS: Record<string, CommandSpec> = {
  "dep-add": {
    valued: ["when", "kind", "state", "dedup"],
    usage: "dep-add <from> <to> --when <条件，≤60 字> [--kind blocks|branch] [--state waiting|active|done]",
    run: depAdd,
  },
  "dep-set": { valued: ["rev", "when", "kind", "state", "dedup"], usage: "dep-set <from> <to> --rev <n> [--when] [--kind] [--state waiting|active|done|auto]", run: depSet },
  "dep-rm": { valued: ["rev", "dedup"], usage: "dep-rm <from> <to> [--rev <n>]", run: depRm },
  deps: { valued: ["project"], usage: "deps [<task>]", run: deps },
};
