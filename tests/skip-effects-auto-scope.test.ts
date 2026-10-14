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
import { readScopeGit, SCOPE_DIFF_MAX_BYTES, SCOPE_OBJECT_MAX_BYTES, scopeBytesIn, scopeRunIn, type ScopeDiff, type ScopeRun, type ScopeRunBytes } from "../src/lib/order-deliver-scope-git.js";
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
/** 从 base（或 from）切一个 head：edit 只改工作副本，提交后回到 base */
function commit(edit: (file: (rel: string, f: (s: string) => string) => void) => void, from = base): string {
  git(["checkout", "-q", "--detach", from]);
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
/** blob 不可变：同一 blob 在各 head 间只真读一次（几百个文件逐个起 git，测试要快）；commit:path → blob id 每次照实查 */
const sizes = new Map<string, string>(), blobs = new Map<string, Uint8Array>(), trees = new Map<string, Map<string, string>>();
async function blobId(commit: string, file: string): Promise<string | undefined> {
  if (!trees.has(commit)) {
    const rows = (await gitAsync(["ls-tree", "-r", "-z", commit])).split("\0").filter(Boolean).map((r) => r.match(/^\S+ blob (\S+)\t([\s\S]+)$/)!);
    trees.set(commit, new Map(rows.map((m) => [m[2]!, m[1]!])));
  }
  return trees.get(commit)!.get(file);
}
async function revParse(spec: string): Promise<string> {
  const id = /^[0-9a-f]{40}:/.test(spec) ? await blobId(spec.slice(0, 40), spec.slice(41)) : undefined;
  return id ? `${id}\n` : gitAsync(["rev-parse", "--verify", spec]);
}
async function catSize(id: string): Promise<string> {
  if (!sizes.has(id)) sizes.set(id, await gitAsync(["cat-file", "-s", id]));
  return sizes.get(id)!;
}
/** 原始字节端口（生产是 scopeBytesIn）：按 blob id 缓存 */
const bytesRun: ScopeRunBytes = async (_cmd, args) => {
  if (args[0] === "diff") return Bun.spawnSync(["git", ...args], { cwd: repo }).stdout;
  const id = args[2]!;
  if (!blobs.has(id)) blobs.set(id, Bun.spawnSync(["git", "cat-file", "blob", id], { cwd: repo }).stdout);
  return blobs.get(id)!;
};
/** gh 只答 PR 的 base / head；heads 依次返回（漂移测试第二次换成别的 head） */
const ghRun = (heads: string[]): ScopeRun => {
  let n = 0;
  return async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: base, headRefOid: heads[Math.min(n++, heads.length - 1)] })
    : args[0] === "rev-parse" && args[1] === "--verify" ? revParse(args[2]!) : args[0] === "cat-file" && args[1] === "-s" ? catSize(args[2]!) : gitAsync(args);
};
const reader = (heads?: string[]) => async (_db: Database, _t: unknown, head: string): Promise<ScopeDiff> => {
  const run = ghRun(heads ?? [head]);
  return readScopeGit("o/r", "1", head, run, run, bytesRun);
};
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
  const production = (head: string, prBase = base) => async (): Promise<ScopeDiff> => {
    const git = scopeRunIn(repo, 300_000);
    const run: ScopeRun = async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: prBase, headRefOid: head }) : git(cmd, args);
    return readScopeGit("o/r", "1", head, run, run, scopeBytesIn(repo, 300_000));
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
    const pass = (await revParse(`${pure}:src/lib/scheduler-pass.ts`)).trim();
    await register(pure, "on", async () => {
      const truncate: ScopeRunBytes = async (cmd, args, max) => {
        const out = await bytesRun(cmd, args, max);
        return args[2] === pass ? out.subarray(0, out.length >> 1) : out;
      };
      const run = ghRun([pure]);
      return readScopeGit("o/r", "1", pure, run, run, truncate);
    });
    expect(auto(pure)).toMatchObject({ eligible: false, granted: false });
    expect(auto(pure)!.error).toContain("读取不完整");
    expect(listed(pure)).not.toContain(GRANTED);
  }, 120_000);
});

describe("[r2 byte-integrity-1] 字节端口等长改字节", () => {
  test("读到的字节与对象等长但不同（有损解码再编码）：对象 id 复算不符，不核准", async () => {
    const inv = (await revParse(`${pure}:${INV}`)).trim();
    await register(pure, "on", async () => {
      const lossy: ScopeRunBytes = async (cmd, args, max) => {
        const out = Buffer.from(await bytesRun(cmd, args, max));
        if (args[2] === inv) out[out.length - 2] ^= 1;
        return out;
      };
      const run = ghRun([pure]);
      return readScopeGit("o/r", "1", pure, run, run, lossy);
    });
    expect(auto(pure)).toMatchObject({ eligible: false, granted: false });
    expect(auto(pure)!.error).toContain("与 Git 对象不一致");
    expect(listed(pure)).not.toContain(GRANTED);
  }, 120_000);
});

describe("[r2 object-cap-1] 旧规则版本的核准证据升级后不沿用", () => {
  // 第 1、2 轮（87a421e0635c / 987348ca698c）进程写进事件的规则版本原值：那两版读取端口会截断 / 有损解码，它们的 eligible=true 不可信
  const R1_RULE = "skip-effects-auto-scope/1:3b1897bed9851cee";
  test("先红后绿：台账里是旧版本写的 eligible=true，重启后审查单不再授权、写明规则版本已变，重复登记不重读也不复活", async () => {
    db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [pure]);
    await register(pure, "on");
    expect(auto(pure)!.eligible).toBe(true);
    // 合成台账里把这条事件还原成旧版进程写的样子（事件表只追加：临时摘掉触发器改一次）
    db.run("DROP TRIGGER events_no_update");
    db.run("UPDATE events SET data = json_set(data, '$.skipEffectsAutoScope.rule', ?) WHERE dedupKey LIKE 'deliver-scope:T1:%'", [R1_RULE]);
    closeLedger(path); db = openLedger(path);
    expect(auto(pure)!.rule).toBe(R1_RULE);
    expect(AUTO_SCOPE_RULE).not.toBe(R1_RULE);
    await register(pure, "on", async () => { throw new Error("must not reread"); });
    const text = listed(pure);
    expect(text).not.toContain(GRANTED);
    expect(text).toContain("规则版本已变");
    const r = reviewOrderOf(db, { task: getTask(db, "T1")!, orderId: "T1:review:r1", node: "review", head: pure, auto: false });
    expect(r.ok && r.order.inputs.join("\n")).not.toContain(GRANTED);
  }, 120_000);
});

describe("[r2 byte-integrity-1] 读取须与 Git blob 字节一致", () => {
  const production = (head: string, prBase: string) => async (): Promise<ScopeDiff> => {
    const git = scopeRunIn(repo, 300_000);
    const run: ScopeRun = async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: prBase, headRefOid: head }) : git(cmd, args);
    return readScopeGit("o/r", "1", head, run, run, scopeBytesIn(repo, 300_000));
  };
  const raw = (rel: string, f: (b: Buffer) => Buffer) => { const p = join(repo, rel); writeFileSync(p, f(readFileSync(p))); };
  const replaceBytes = (b: Buffer, from: Buffer, to: Buffer) => {
    const i = b.indexOf(from);
    expect(i).toBeGreaterThan(-1);
    return Buffer.concat([b.subarray(0, i), to, b.subarray(i + from.length)]);
  };
  const readBlob = (head: string) => Bun.spawnSync(["git", "cat-file", "blob", `${head}:${INV}`], { cwd: repo }).stdout;
  const FFFD = Buffer.from([0xef, 0xbf, 0xbd]), BAD = Buffer.from([0xf0, 0x90, 0x80]);
  test("先红后绿：清单注释里合法 U+FFFD 换成等长非法 UTF-8（F0 90 80）+ 合法 proc=1→2：不核准", async () => {
    const prBase = commit(() => raw(INV, (b) => Buffer.concat([b, Buffer.from("// marker \ufffd\n")])));
    const head = commit((file) => {
      file(PROBE, (s) => s + EFFECT);
      raw(INV, (b) => replaceBytes(Buffer.from(b.toString("utf8").replace(ENTRY, ENTRY.replace("1", "2"))), FFFD, BAD));
    }, prBase);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(readBlob(head))).toThrow();
    await register(head, "on", production(head, prBase));
    const a = auto(head)!;
    expect(a).toMatchObject({ eligible: false, granted: false });
    expect(a.reasons).toContain("Git 对象读取或解析失败");
    expect(listed(head)).not.toContain(GRANTED);
  }, 300_000);
  test("清单开头的 BOM 被删（其他字节都是纯计数）：不核准", async () => {
    const prBase = commit(() => raw(INV, (b) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b])));
    const head = commit((file) => { file(PROBE, (s) => s + EFFECT); raw(INV, (b) => Buffer.from(b.subarray(3).toString("utf8").replace(ENTRY, ENTRY.replace("1", "2")))); }, prBase);
    await register(head, "on", production(head, prBase));
    expect(auto(head)).toMatchObject({ eligible: false, granted: false });
    expect(listed(head)).not.toContain(GRANTED);
  }, 300_000);
});

describe("[r3 object-cap-1] 变更文件清单须完整读到", () => {
  const SCAN = "src/lib/skip-effects-auto-scope-scan.ts", PAD = "src/lib/skip-a-pad", ALIGN = "src/lib/skip-a-0";
  /** 生产读取端口（同上）；bytes 可换成收紧上限的真实字节端口 */
  const production = (head: string, prBase: string, bytes: ScopeRunBytes = scopeBytesIn(repo, 300_000)) => async (): Promise<ScopeDiff> => {
    const git = scopeRunIn(repo, 300_000);
    const run: ScopeRun = async (cmd, args) => cmd === "gh" ? JSON.stringify({ baseRefOid: prBase, headRefOid: head }) : git(cmd, args);
    return readScopeGit("o/r", "1", head, run, run, bytes);
  };
  const rawDiff = (from: string, to: string) => Bun.spawnSync(["git", "diff", "--numstat", "-z", "--no-renames", `${from}...${to}`, "--"], { cwd: repo }).stdout;
  test("先红后绿：base 多 10,000 个占位文件（head 删掉）使 numstat 超 1 MiB、截断落在 NUL 记录边界；扫描器改动在截断之后：不核准", async () => {
    // 每条删除记录正好 128 字节（"0\t1\t" + 123 字节路径 + NUL），占位文件按字典序落在清单与扫描器之间
    const pad = (i: number) => `${PAD}/${String(i).padStart(5, "0")}`.padEnd(123, "x");
    // 只用 Git 底层命令造对象（不落一万个工作区文件）：prBase = base 树 + 占位文件；head = 普通改动的树，父提交是 prBase
    const plumb = (args: string[], input?: string, env: Record<string, string> = {}) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdin: input === undefined ? "ignore" : Buffer.from(input),
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env } });
      if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    const blob = plumb(["hash-object", "-w", "--stdin"], "p\n"), index = { GIT_INDEX_FILE: join(repo, ".git", "pad-index") };
    plumb(["read-tree", base], undefined, index);
    plumb(["update-index", "--index-info"], Array.from({ length: 10_000 }, (_, i) => `100644 ${blob}\t${pad(i)}\n`).join(""), index);
    const prBase = plumb(["commit-tree", plumb(["write-tree"], undefined, index), "-p", base, "-m", "pads"]);
    const edit = (align: string | null) => plumb(["commit-tree", `${commit((file) => {
      file(PROBE, (s) => s + EFFECT);
      file(INV, (s) => s.replace(ENTRY, '"scheduler-ui-carry-proof.ts": "proc=2"'));
      file(SCAN, (s) => s + "\nEFFECTS.proc = /skip_auto_never_matches/g;\n");
      if (align) file(align, () => "a\n");
    })}^{tree}`, "-p", prBase, "-m", "head"]);
    // 对齐：占位记录之前的字节数补成 128 的倍数，1 MiB 截断点就落在记录边界
    const probe = edit(null), out = Buffer.from(rawDiff(prBase, probe));
    const at = (b: Buffer) => b.indexOf(Buffer.from(`\t${PAD}/`)) - 4;
    // 对齐记录 "1\t0\t" + 路径 + NUL 排在占位记录之前
    let len = (((-(at(out) + 5)) % 128) + 128) % 128;
    while (len < ALIGN.length + 2) len += 128;
    const head = edit(`${ALIGN}/`.padEnd(len, "a"));
    const full = Buffer.from(rawDiff(prBase, head));
    expect(full.length).toBeGreaterThan(1024 * 1024);
    expect(full.toString("utf8")).toContain(SCAN);
    // runBounded 的截断点随管道分块而变：把真实 scopeRunIn 的输出确定地截在 1 MiB 内最后一个 NUL 处（即落在记录边界的那种截断），
    // 旧实现拿它当完整清单：清单仍在、扫描器已丢，于是核准（红）；新实现用字节端口完整读清单（绿）
    const real = scopeRunIn(repo, 300_000);
    const cut: ScopeRun = async (cmd, args) => {
      if (cmd === "gh") return JSON.stringify({ baseRefOid: prBase, headRefOid: head });
      const out = await real(cmd, args);
      if (args[0] !== "diff") return out;
      const b = Buffer.from(out);
      return b.subarray(0, b.lastIndexOf(0, 1024 * 1024 - 1) + 1).toString("utf8");
    };
    const truncated = await cut("git", ["diff", "--numstat", "-z", "--no-renames", `${prBase}...${head}`, "--"]);
    expect(truncated).toContain(INV);
    expect(truncated).not.toContain(SCAN);
    await register(head, "on", async () => readScopeGit("o/r", "1", head, cut, cut, scopeBytesIn(repo, 300_000)));
    expect(auto(head)).toMatchObject({ eligible: false, granted: false });
    expect(auto(head)!.reasons.join("；")).toContain(`改了扫描规则 / 判定器（${SCAN}）`);
    expect(listed(head)).not.toContain(GRANTED);
    restart();
    // 全走生产端口（gh 除外）同样拒
    await register(head, "on", production(head, prBase));
    const a = auto(head)!;
    expect(a).toMatchObject({ eligible: false, granted: false });
    expect(a.reasons.join("；")).toContain(`改了扫描规则 / 判定器（${SCAN}）`);
    expect(listed(head)).not.toContain(GRANTED);
  }, 600_000);

  test("清单超过字节上限（真实字节端口显式失败）：一般范围登记照旧，自动例外写明清单不完整、不核准", async () => {
    const real = scopeBytesIn(repo, 300_000);
    const tight: ScopeRunBytes = (cmd, args, max) => real(cmd, args, args[0] === "diff" ? 64 : max);
    expect(SCOPE_DIFF_MAX_BYTES).toBeGreaterThan(SCOPE_OBJECT_MAX_BYTES);
    await register(pure, "on", production(pure, base, tight));
    const a = auto(pure)!;
    expect(a).toMatchObject({ eligible: false, granted: false });
    expect(a.reasons.join("；")).toContain("变更文件清单未能完整读到");
    expect(event(pure)!.data.files).toEqual([{ path: INV, added: 1, deleted: 1, sharedWith: ["T2"] }]);
    expect(listed(pure)).not.toContain(GRANTED);
  }, 300_000);
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
    await rejected(commit((file) => file(INV, (s) => s.replace(`    ${ENTRY},\n`, ""))), other);
    const stale = '"scheduler-review-stale.ts": "sql=1 stmt=1",';
    await rejected(commit((file) => file(INV, (s) => s.replace(`    ${ENTRY},\n`, "").replace(stale, `${stale}\n    ${ENTRY},`))), other);
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
    await rejected(pure, /读不到 Git 对象/, async () => { const d = await reader()(db, null, pure); return { base: d.base, files: d.files, filesComplete: d.filesComplete }; });
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
