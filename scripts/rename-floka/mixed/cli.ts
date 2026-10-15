#!/usr/bin/env bun
/**
 * 三机混版本矩阵的入口（说明见同目录 README.md）。只读显式给的 --config 文件，不读真实状态目录：
 *   plan       [--config f] [--order a,b,c]            observe（缺省）/ on 出滚动计划；off 什么都不出
 *   preflight  [--center-proof f] [--topology f]        开工前核；没有证据的项是 unverified，ready=false 时退出码 1
 *   run        --mode on | --config f  [--order a,b,c] [--tmp dir] [--keep]
 *              只在系统临时目录（--tmp 只能选其下的目录，缺省 /tmp）下新建的目录里起三实例 + 本机假中心跑矩阵；有违例退出码 1
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitRun, parseRollout, rolloutPlan, upgradeOrders, type RolloutMode } from "./rollout.ts";
import { cardMerges, preflight } from "./preflight.ts";
import { closeWorld, MACHINES, runOrder, summarize } from "./matrix.ts";
import { CENTER } from "./wire.ts";

type Out = { code: number; out: unknown };

function flags(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`多余的参数：${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) m.set(a.slice(2), "true");
    else m.set(a.slice(2), argv[++i]!);
  }
  return m;
}

const readJson = (path: string | undefined): unknown => (path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8")));

function orders(f: Map<string, string>): string[][] {
  const o = f.get("order");
  return o && o !== "all" ? [o.split(",")] : upgradeOrders(MACHINES);
}

/** git 历史：只读本仓 HEAD 的合入提交标题 */
function gitMerges(repo: string): { sha: string; subject: string }[] {
  const r = Bun.spawnSync(["git", "-C", repo, "log", "--merges", "--format=%h%x09%s", "HEAD"]);
  if (r.exitCode !== 0) throw new Error("读不了 git 历史");
  return r.stdout.toString().split("\n").filter(Boolean).map((l) => {
    const [sha, ...rest] = l.split("\t");
    return { sha: sha!, subject: rest.join("\t") };
  });
}

async function run(f: Map<string, string>): Promise<Out> {
  const mode: RolloutMode = f.has("mode") ? parseRollout({ rename: { rollout: f.get("mode") } }).mode : parseRollout(readJson(f.get("config"))).mode;
  if (mode !== "on") return { code: 0, out: { mode, ran: false, reason: `rename.rollout=${mode}：只出计划，不执行` } };
  // 缺省 /tmp：macOS 的 $TMPDIR 很长，会被事务日志的凭据遮蔽误认成密钥（STATE 迁移因此拒绝）
  const tmpRoots = [...new Set([tmpdir(), "/tmp"].filter((p) => existsSync(p)).map((p) => realpathSync(p)))];
  const tmp = realpathSync(f.get("tmp") ?? tmpRoots.at(-1)!);
  // 建目录之前先核父目录：--tmp 指到临时目录之外时一个字节都不写
  const pre = admitRun(mode, { base: join(tmp, "floka-mixed-"), tmpRoots, roots: [], center: CENTER });
  if (!pre.ok) return { code: 1, out: { mode, ran: false, reason: pre.reason } };
  const base = realpathSync(mkdtempSync(join(tmp, "floka-mixed-")));
  const reports: unknown[] = [];
  let ok = true;
  try {
    const list = orders(f);
    const roots = list.flatMap((o) => MACHINES.map((m) => join(base, o.join("-"), m)));
    const gate = admitRun(mode, { base, tmpRoots, roots, center: CENTER });
    if (!gate.ok) return { code: 1, out: { mode, ran: false, reason: gate.reason } };
    for (const order of list) {
      const w = await runOrder(join(base, order.join("-")), order);
      try {
        const s = summarize(w);
        ok &&= s.ok;
        reports.push({ order, ok: s.ok, stages: s.stages });
      } finally {
        closeWorld(w);
      }
    }
  } finally {
    if (f.get("keep") !== "true") rmSync(base, { recursive: true, force: true });
  }
  return { code: ok ? 0 : 1, out: { mode, ran: true, ok, orders: reports } };
}

export async function mixedCommand(argv: string[], repo: string): Promise<Out> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (cmd === "plan") {
    const config = readJson(f.get("config"));
    return { code: 0, out: orders(f).map((o) => rolloutPlan(config, o)) };
  }
  if (cmd === "preflight") {
    const r = preflight({ merged: cardMerges(gitMerges(repo)), centerProof: readJson(f.get("center-proof")), topology: readJson(f.get("topology")) });
    return { code: r.ready ? 0 : 1, out: r };
  }
  if (cmd === "run") return run(f);
  return { code: 2, out: { error: "usage: plan | preflight | run（见 scripts/rename-floka/mixed/README.md）" } };
}

if (import.meta.main) {
  const r = await mixedCommand(process.argv.slice(2), join(import.meta.dir, "..", "..", ".."));
  console.log(JSON.stringify(r.out, null, 2));
  process.exit(r.code);
}
