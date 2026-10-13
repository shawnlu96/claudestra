// merge-arch-SKIPAUTO1：效果点清单纯计数改动的机器核准。真实交付范围登记 / 审查单路径 + 临时 Git 仓（本仓 src/lib 的副本）+ 合成台账；
// PR 侧（head）源码只经 readScopeGit 的对象端口当字符串读。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { ensureDeliverScope, scopeInputs } from "../src/lib/order-deliver-scope.js";
import { readScopeGit, SCOPE_OBJECT_MAX_BYTES, scopeRunIn, type ScopeDiff, type ScopeRun } from "../src/lib/order-deliver-scope-git.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { AUTO_SCOPE_RULE, autoScopeNow, judgeCountOnly, SKIP_EFFECTS_INVENTORY, type SkipEffectsAutoScope } from "../src/lib/skip-effects-auto-scope.js";

const ROOT = join(import.meta.dir, "..");
const INV = SKIP_EFFECTS_INVENTORY, PROBE = "src/lib/scheduler-ui-carry-proof.ts";
const ENTRY = '"scheduler-ui-carry-proof.ts": "proc=1"';
// 本卡代码给既有条目加一个真实效果点（proc 1 → 2）；顺带一句顶层赋值，证明 PR 源码从没被执行
const EFFECT = "\nexport function skipAutoProbe(): void { Bun.spawnSync([\"true\"]); }\n(globalThis as Record<string, unknown>).__skipAutoRan = true;\n";
const GRANTED = "纯计数机器核准，无需再 ask PM";

let repo: string, base: string;
const git = (args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
/** 从 base 切一个 head：edit 只改工作副本，提交后回到 base */
function commit(edit: (file: (rel: string, f: (s: string) => string) => void) => void): string {
  git(["checkout", "-q", "--detach", base]);
  edit((rel, f) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, f((() => { try { return readFileSync(p, "utf8"); } catch { return ""; } })())); });
  git(["add", "-A"]); git(["commit", "-q", "-m", "head"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-q", "--detach", base]);
  return sha;
}
const countOnly = (to = "proc=2", code = true) => commit((file) => {
  if (code) file(PROBE, (s) => s + EFFECT);
  file(INV, (s) => s.replace(ENTRY, `"scheduler-ui-carry-proof.ts": "${to}"`));
});

let pure: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "skip-auto-repo-"));
  git(["init", "-q"]);
  cpSync(join(ROOT, "src", "lib"), join(repo, "src", "lib"), { recursive: true });
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  base = git(["rev-parse", "HEAD"]).trim();
  pure = countOnly();
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

let db: Database, path: string, dir: string;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const gitAsync = async (args: string[]): Promise<string> => {
  const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err}`);
  return out;
};
const sizes = new Map<string, string>();
async function blobId(commit: string, file: string): Promise<string | undefined> {
  if (!trees.has(commit)) {
    const rows = (await gitAsync(["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean).map((r) => r.match(/^\S+ blob (\S+)\t([\s\S]+)$/)!);
    trees.set(commit, new Map(rows.map((m) => [m[2]!, m[1]!])));
  }
  return trees.get(commit)!.get(file);
}
async function catSize(spec: string): Promise<string> {
  const id = await blobId(spec.slice(0, 40), spec.slice(41));
  if (!id) return gitAsync(["cat-file", "-s", spec]);
  if (!sizes.has(id)) sizes.set(id, await gitAsync(["cat-file", "-s", id]));
  return sizes.get(id)!;
}
/** blob 不可变：同一 blob 在各 head 间只真读一次（几百个文件逐个起 git，测试要快）；commit:path → blob id 每次照实查 */
const blobs = new Map<string, string>(), trees = new Map<string, Map<string, string>>();
async function catBlob(spec: string): Promise<string> {
  const id = await blobId(spec.slice(0, 40), spec.slice(41));
  if (!id) return gitAsync(["cat-file", "blob", spec]);
  if (!blobs.has(id)) blobs.set(id, await gitAsync(["cat-file", "blob", id]));
  return blobs.get(id)!;
}
/** gh 只答 PR 的 base / head；heads 依次返回（漂移测试第二次换成别的 head） */
const ghRun = (heads: string[]): ScopeRun => {
  let n = 0;
  return async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: base, headRefOid: heads[Math.min(n++, heads.length - 1)] })
    : args[0] === "cat-file" && args[1] === "blob" ? catBlob(args[2]!) : args[0] === "cat-file" && args[1] === "-s" ? catSize(args[2]!) : gitAsync(args);
};
const reader = (heads?: string[]) => async (_db: Database, _t: unknown, head: string): Promise<ScopeDiff> => readScopeGit("o/r", "1", head, ghRun(heads ?? [head]));
/** 项目当前策略（生产 recoveryPolicy 读的文件，测试状态目录是临时的）：审查单出单时按它现算 */
const setMode = (mode: RecoveryMode) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { skipEffectsAutoScope: mode } } } }));
const register = (head: string, mode: RecoveryMode, read = reader()) => { setMode(mode); return ensureDeliverScope(db, getTask(db, "T1")!, head, read, Date.now(), policy(mode)); };
const event = (head: string) => listEvents(db, { target: "T1" }).find((e) => e.data.op === "deliver_scope" && e.data.head === head);
const auto = (head: string) => event(head)?.data.skipEffectsAutoScope as SkipEffectsAutoScope | undefined;
const listed = (head: string) => scopeInputs(db, getTask(db, "T1")!, head).join("\n");

function fresh(): void {
  dir = mkdtempSync(join(tmpdir(), "skip-auto-ledger-")); path = join(dir, "ledger.db"); db = openLedger(path);
  const spec = join(dir, "T1.md"); writeFileSync(spec, "# test\n## 验收线\n逐条核对\n");
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "加效果点", kind: "code", spec, extra: { fileGlobs: [PROBE] } });
  createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "共改清单", kind: "code", extra: { fileGlobs: [INV] } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T2'");
  db.run("UPDATE tasks SET stage = 'review', round = 1, pr = 'https://github.com/o/r/pull/1' WHERE id = 'T1'");
}
const drop = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); };
/** 换一本空台账（同一 head 再登记一次，换模式比对） */
const restart = () => { drop(); fresh(); };
beforeEach(fresh);
afterEach(drop);

describe("[验收 1] 纯计数改动：on 机器核准，事实照列", () => {
  test("先红后绿：既有条目随本卡代码加一个真实效果点，on 下审查单写明纯计数机器核准、免逐卡批准；文件 / 行数 / 共改照列", async () => {
    db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [pure]);
    await register(pure, "on");
    const a = auto(pure)!;
    expect(a).toMatchObject({ path: INV, base, head: pure, rule: AUTO_SCOPE_RULE, mode: "on", eligible: true, granted: true, reasons: [],
      entries: [{ file: "scheduler-ui-carry-proof.ts", gate: "pace", from: "proc=1", to: "proc=2", scanned: "proc=2" }] });
    expect(a.mergeBase).toBe(base);
    const text = listed(pure);
    expect(text).toContain(GRANTED);
    expect(text).toContain("本例外只覆盖这一个文件");
    // 事实保留：核准的文件仍在清单里，行数与共改都在；fileGlobs 不扩
    expect(text).toContain(`${JSON.stringify(INV)}：+1 / -1（2 行）；与 T2 共改`);
    expect(event(pure)!.data.files).toEqual([{ path: INV, added: 1, deleted: 1, sharedWith: ["T2"] }]);
    expect(getTask(db, "T1")!.extra?.fileGlobs).toEqual([PROBE]);
    const local = reviewOrderOf(db, { task: getTask(db, "T1")!, orderId: "T1:review:r1", node: "review", head: pure, auto: false });
    expect(local.ok && local.order.inputs.join("\n")).toContain(GRANTED);
    // PR 源码零执行：head 里那句顶层赋值从没跑过
    expect((globalThis as Record<string, unknown>).__skipAutoRan).toBeUndefined();
  }, 120_000);

  test("其他规格外文件仍逐条报出，例外不覆盖它们", async () => {
    const head = commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, '"scheduler-ui-carry-proof.ts": "proc=2"')); file("docs/x.md", () => "x\n"); });
    await register(head, "on");
    const text = listed(head);
    expect(text).toContain(GRANTED);
    expect(text).toContain('"docs/x.md"：+1 / -0（1 行）');
    expect((event(head)!.data.files as { path: string }[]).map((f) => f.path).sort()).toEqual(["docs/x.md", INV]);
  }, 120_000);
});

describe("[验收 3] off / observe 不产生授权；证据按 head 不串用", () => {
  test("off 原样：不核、无结构化结果；observe 记「本可自动核准」但审查单与 off 逐字相同", async () => {
    await register(pure, "off");
    const offText = listed(pure);
    expect(auto(pure)).toBeUndefined();
    expect(offText).not.toContain("机器核准");
    restart();
    await register(pure, "observe");
    expect(auto(pure)).toMatchObject({ mode: "observe", eligible: true, granted: false, base, head: pure });
    expect(listed(pure)).toBe(offText);
  }, 120_000);

  test("重复登记与重启不重核；新 head 另核，旧 head 的核准不串到新 head", async () => {
    await register(pure, "on");
    closeLedger(path); db = openLedger(path);
    await register(pure, "on", async () => { throw new Error("must not reread"); });
    expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope")).toHaveLength(1);
    const forged = countOnly("proc=3");
    await register(forged, "on");
    expect(auto(forged)!.granted).toBe(false);
    expect(listed(forged)).not.toContain(GRANTED);
    expect(listed(pure)).toContain(GRANTED);
  }, 120_000);
});

describe("[r1 mode-stale-1] 正式授权按出单时的策略现算", () => {
  const review = () => {
    const r = reviewOrderOf(db, { task: getTask(db, "T1")!, orderId: "T1:review:r1", node: "review", head: pure, auto: false });
    expect(r.ok).toBe(true);
    return r.ok ? r.order.inputs.join("\n") : "";
  };
  test("on 核准后切 off / observe：审查单不再授权、与 off 原样逐字相同，不重读；切回 on 恢复；重启后同样按当前策略", async () => {
    db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [pure]);
    await register(pure, "on");
    expect(review()).toContain(GRANTED);
    const noReread = async () => { throw new Error("must not reread"); };
    setMode("off");
    await register(pure, "off", noReread);
    const offText = listed(pure);
    expect(offText).not.toContain("机器核准");
    expect(offText).not.toContain("自动例外");
    expect(offText).toContain(`${JSON.stringify(INV)}：+1 / -1（2 行）`);
    expect(review()).not.toContain(GRANTED);
    await register(pure, "observe", noReread);
    expect(listed(pure)).toBe(offText);
    expect(review()).not.toContain(GRANTED);
    // 核对证据留在事件里
    expect(auto(pure)).toMatchObject({ eligible: true, head: pure });
    closeLedger(path); db = openLedger(path);
    setMode("on");
    expect(review()).toContain(GRANTED);
    setMode("observe");
    expect(review()).not.toContain(GRANTED);
    rmSync(RECOVERY_POLICY_PATH, { force: true }); // 缺省 observe
    expect(listed(pure)).toBe(offText);
    expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope")).toHaveLength(1);
  }, 120_000);

  test("规则版本变了（重启后换了扫描器）不沿用旧核准", () => {
    const a = { path: INV, base, mergeBase: base, head: pure, rule: AUTO_SCOPE_RULE, mode: "on" as const, eligible: true, granted: true, entries: [], reasons: [] };
    expect(autoScopeNow(a, "on").granted).toBe(true);
    expect(autoScopeNow(a, "off").granted).toBe(false);
    expect(autoScopeNow(a, "observe").granted).toBe(false);
    const stale = autoScopeNow({ ...a, rule: "skip-effects-auto-scope/1:other" }, "on");
    expect(stale.granted).toBe(false);
    expect(stale.reasons.join()).toContain("规则版本已变");
    expect(autoScopeNow({ ...a, eligible: false, granted: false }, "on").granted).toBe(false);
  });
});

describe("[r1 object-cap-1] 对象读取不完整回人工", () => {
  /** 生产读取端口：git 走 scopeRunIn（runBounded，有 1 MiB 输出上限），只有 gh 元数据是 fixture */
  const production = (head: string) => async (): Promise<ScopeDiff> => {
    const git = scopeRunIn(repo, 300_000);
    const run: ScopeRun = async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: base, headRefOid: head }) : git(cmd, args);
    return readScopeGit("o/r", "1", head, run);
  };
  test("前两个效果点 + 2 MiB 注释 + 尾部第三个，清单写 proc=2（完整扫描是 3）：不核准", async () => {
    const head = commit((file) => {
      file(PROBE, (s) => s + EFFECT + `// ${"x".repeat(2 * 1024 * 1024)}\n` + "export function skipAutoTail(): void { Bun.spawnSync([\"true\"]); }\n");
      file(INV, (s) => s.replace(ENTRY, '"scheduler-ui-carry-proof.ts": "proc=2"'));
    });
    await register(head, "on", production(head));
    const a = auto(head)!;
    expect(a).toMatchObject({ eligible: false, granted: false });
    expect(a.reasons).toContain("Git 对象读取或解析失败");
    expect(a.error).toContain(`超过对象读取上限 ${SCOPE_OBJECT_MAX_BYTES}`);
    expect(listed(head)).not.toContain(GRANTED);
    expect(listed(head)).toContain("未获纯计数自动例外");
  }, 300_000);

  test("读到的字节数与对象大小不符（截断）：不核准", async () => {
    await register(pure, "on", async () => {
      const truncate: ScopeRun = async (cmd, args) => {
        const out = await ghRun([pure])(cmd, args);
        return args[0] === "cat-file" && args[1] === "blob" && args[2]!.endsWith("scheduler-pass.ts") ? out.slice(0, out.length >> 1) : out;
      };
      return readScopeGit("o/r", "1", pure, truncate);
    });
    expect(auto(pure)).toMatchObject({ eligible: false, granted: false });
    expect(auto(pure)!.error).toContain("读取不完整");
    expect(listed(pure)).not.toContain(GRANTED);
  }, 120_000);
});

describe("[验收 2] 一律退回原人工规则", () => {
  const rejected = async (head: string, reason: RegExp, read = reader()) => {
    await register(head, "on", read);
    const a = auto(head)!;
    expect(a.granted).toBe(false);
    expect(a.eligible).toBe(false);
    expect(a.reasons.join("；")).toMatch(reason);
    const text = listed(head);
    expect(text).not.toContain(GRANTED);
    expect(text).toContain("未获纯计数自动例外");
    expect(text).toContain(`${JSON.stringify(INV)}：`);
  };

  test("计数造假（代码没加效果点 / 数值不符）", async () => {
    await rejected(countOnly("proc=2", false), /与受信扫描 "proc=1" 不符/);
    await rejected(countOnly("proc=3"), /与受信扫描 "proc=2" 不符/);
  }, 120_000);

  test("新增 / 删除 / 移组条目、同数值改注释、混入代码", async () => {
    const other = /除既有条目的计数外还有改动/;
    await rejected(commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, `${ENTRY.replace("1", "2")}, "zz-new.ts": "fs=1"`)); }), other);
    await rejected(commit((file) => file(INV, (s) => s.replace(`${ENTRY}, `, ""))), other);
    const stale = '"scheduler-review-stale.ts": "sql=1 stmt=1",';
    await rejected(commit((file) => file(INV, (s) => s.replace(`${ENTRY}, `, "").replace(stale, `${stale} ${ENTRY},`))), other);
    await rejected(commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, ENTRY.replace("1", "2")).replace("card work run", "card work ran")); }), other);
    await rejected(commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, ENTRY.replace("1", "2")) + "export const extra = 1;\n"); }), other);
  }, 240_000);

  test("PR 改了扫描器 / 判定器", async () => {
    await rejected(commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, ENTRY.replace("1", "2"))); file("scripts/skip-effects.ts", () => "export {};\n"); }),
      /改了扫描规则 \/ 判定器（scripts\/skip-effects\.ts）/);
    await rejected(commit((file) => { file(PROBE, (s) => s + EFFECT); file(INV, (s) => s.replace(ENTRY, ENTRY.replace("1", "2"))); file("src/lib/scheduler-v2-skip-paths.ts", (s) => s + "\n"); }),
      /scheduler-v2-skip-paths\.ts/);
  }, 120_000);

  test("缺完整对象、读失败、head 漂移、私仓", async () => {
    await rejected(pure, /读不到 Git 对象/, async () => { const d = await reader()(db, null, pure); return { base: d.base, files: d.files }; });
    restart();
    await rejected(pure, /Git 对象读取或解析失败/, async () => {
      const d = await reader()(db, null, pure);
      return { ...d, objects: { ...d.objects!, show: async (c, p) => { if (p.endsWith("scheduler-pass.ts")) throw new Error(`fatal: bad object ${c}`); return d.objects!.show(c, p); } } };
    });
    // 原始报错只进事件数据，审查单不带完整 SHA
    expect(auto(pure)!.error).toContain(pure);
    expect(listed(pure)).not.toContain(pure);
    const drift = countOnly("proc=2");
    await rejected(drift, /PR head 已漂移/, reader([drift, base]));
  }, 120_000);
});

describe("judgeCountOnly（纯判定）", () => {
  const inv = (body: string) => `export const SKIP_EFFECT_FILES = {\n  pace: {\n${body}\n  },\n  infra: {\n    "z.ts": "fs=1",\n  },\n};\n`;
  const B0 = inv('    "a.ts": "proc=1", "b.ts": "fs=2",');
  const scan = new Map([["a.ts", "proc=2"], ["b.ts", "fs=2"], ["z.ts", "fs=1"]]);
  test("纯计数且与扫描逐项相等才过；未登记 / 多余 / 重复都拒", () => {
    expect(judgeCountOnly(B0, inv('    "a.ts": "proc=2", "b.ts": "fs=2",'), scan)).toEqual({ reasons: [],
      entries: [{ file: "a.ts", gate: "pace", from: "proc=1", to: "proc=2", scanned: "proc=2" }] });
    expect(judgeCountOnly(B0, inv('    "a.ts": "proc=2", "b.ts": "fs=2",'), new Map([...scan, ["n.ts", "fs=1"]])).reasons.join()).toContain("未登记的效果文件：n.ts");
    expect(judgeCountOnly(B0, inv('    "a.ts": "proc=2", "b.ts": "fs=2",'), new Map([["a.ts", "proc=2"], ["z.ts", "fs=1"]])).reasons.join()).toContain("扫描里没有的登记：b.ts");
    expect(judgeCountOnly(B0, inv('    "a.ts": "proc=2", "b.ts": "fs=2",'), new Map([...scan, ["b.ts", "fs=3"]])).reasons.join()).toContain("未改动却与扫描不符的登记：b.ts");
    expect(judgeCountOnly(B0, inv('    "a.ts": "proc=2", "a.ts": "fs=2",'), scan).reasons.join()).toContain("登记了两次");
    expect(judgeCountOnly(B0, B0, scan).reasons).toEqual(["清单没有计数改动"]);
  });
});
