/**
 * LENDUI2 worker 交截图（src/lib/lend-ui-submit.ts，`lend submit ... --ui-shots-file`）：真 submitWorkWithUi（CLI 走的就是它）+ 临时工作副本 + 内存 journal。
 * 拒交一律核「不拷贝、journal 不变」。开关 lendUiUpload 的读法（src/lib/lend-key-mode.ts）用临时 projects / 策略文件。
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { explicitLendKeyMode, lendUiUploadMode } from "../src/lib/lend-key-mode.js";
import type { SubmitterDeps } from "../src/lib/lend-submit.js";
import { UI_COPY_DIR, uiCopyPath } from "../src/lib/lend-ui-send.js";
import { submitWorkWithUi, UI_OFF_NOTE } from "../src/lib/lend-ui-submit.js";
import { usageReportMode } from "../src/lib/lend-usage-report.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── PNG 夹具 ──
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return b;
}
function ihdr(w: number, h: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  return chunk("IHDR", d);
}
const END = chunk("IEND", Buffer.alloc(0));
const png = (seed: string, w = 390, h = 844): Buffer => Buffer.concat([SIG, ihdr(w, h), chunk("IDAT", Buffer.from(seed)), END]);
/** tEXt、iCCP（配置名带设备名）和 IEND 之后的尾巴：拷贝里三样都不该在 */
const dirty = (seed: string): Buffer => Buffer.concat([SIG, ihdr(780, 1688), chunk("iCCP", Buffer.from("Alice-MacBook-Display\0\0x")),
  chunk("tEXt", Buffer.from("Comment\0SECRET-NOTE")), chunk("IDAT", Buffer.from(seed)), END, Buffer.from("TRAILING-ZIP")]);
const clean = (seed: string): Buffer => Buffer.concat([SIG, ihdr(780, 1688), chunk("IDAT", Buffer.from(seed)), END]);

function lab(mode: RecoveryMode = "on") {
  const root = mkdtempSync(join(tmpdir(), "lend-ui-sub-"));
  const dir = join(root, "work", "o1");
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "ui-shots"));
  const db = openLendJournal(":memory:");
  recordAsked(db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview: {} }, 0);
  advance(db, "o1", "asked", "claimed", { wire: { order: { orderId: "o1", head: BASE, taskId: "T93", step: "write", specRev: 2, round: 0 }, text: "x",
    write: { branch: "lend/T93-abcd", base: "main" } }, leaseGen: 3 });
  advance(db, "o1", "claimed", "cloned", { dir });
  advance(db, "o1", "cloned", "started", { agent: "agent-lend-x", sessionId: "thr-1" });
  const deps: SubmitterDeps = { cwd: dir, pid: 500, agentSession: () => "thr-1", panePid: async () => 100, ancestors: async () => [400, 100, 1], headOf: async () => HEAD };
  const privacy = { home: "/Users/alice", lendRoot: join(root, "lend-root"), copy: dir, user: "alice", host: "alicebox.local" };
  const shotsDir = join(dir, "ui-shots");
  const put = (name: string, b: Uint8Array) => writeFileSync(join(shotsDir, name), b);
  const manifest = (m: unknown, at = join(shotsDir, "manifest.json")) => { writeFileSync(at, typeof m === "string" ? m : JSON.stringify(m)); return at; };
  const submit = (file: string | undefined, m: RecoveryMode = mode) =>
    submitWorkWithUi(db, "o1", { summary: "改了首页", selfCheck: "逐条对了" }, file, deps, { mode: () => m, privacy });
  const copies = () => (existsSync(join(dir, ".git", UI_COPY_DIR)) ? readdirSync(join(dir, ".git", UI_COPY_DIR)) : []);
  return { root, dir, db, deps, shotsDir, put, manifest, submit, copies, row: () => getOrder(db, "o1")! };
}
const lstatOrNull = (p: string) => { try { return lstatSync(p); } catch { return null; } };
const pair = (view = "home", size = "390x844") => [
  { view, size, phase: "before", file: `before-${view}.png` }, { view, size, phase: "after", file: `after-${view}.png` }];

describe("[验收线 1] 交图：合法清单", () => {
  test("work.ui 写入；拷贝 = 去过元数据（tEXt / iCCP / 尾巴）的字节、按拷贝算 sha256、0600 / 0700；重交同一份幂等", async () => {
    const l = lab();
    l.put("before-home.png", dirty("before"));
    l.put("after-home.png", png("after"));
    const m = l.manifest({ v: 1, summary: "首页前后", shots: [...pair()].reverse() });
    const r = await l.submit(m);
    expect(r).toMatchObject({ ok: true, duplicate: false });
    const ui = l.row().work!.ui!;
    const kept = clean("before");
    expect(ui).toEqual({ summary: "首页前后", shots: [
      { view: "home", size: "390x844", phase: "before", sha256: sha(kept), bytes: kept.length, width: 780, height: 1688 },
      { view: "home", size: "390x844", phase: "after", sha256: sha(png("after")), bytes: png("after").length, width: 390, height: 844 },
    ] });
    const copy = readFileSync(uiCopyPath(l.dir, sha(kept)));
    expect(copy.equals(kept)).toBe(true);
    expect([copy.includes("SECRET-NOTE"), copy.includes("TRAILING-ZIP"), copy.includes("iCCP"), copy.includes("Alice")]).toEqual([false, false, false, false]);
    expect(statSync(uiCopyPath(l.dir, sha(kept))).mode & 0o777).toBe(0o600);
    expect(statSync(join(l.dir, ".git", UI_COPY_DIR)).mode & 0o777).toBe(0o700);
    expect(l.copies().sort()).toEqual([`${sha(kept)}.png`, `${sha(png("after"))}.png`].sort());
    const again = await l.submit(m);
    expect(again).toEqual({ ok: true, duplicate: true, sha: (r as { sha: string }).sha });
    expect(l.row().work!.ui).toEqual(ui);
  });

  test("先红的依据：CLI 认 --ui-shots-file（main 上是不认识的参数，回 usage）", async () => {
    const { cmdLendSubmit } = await import("../src/manager/lend-submit.js");
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try { await cmdLendSubmit(["o1", "--summary-file", "s.txt", "--self-check-file", "c.md", "--ui-shots-file", "ui-shots/manifest.json"]); } finally { console.log = log; }
    const r = JSON.parse(out[0]!);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("usage");
    expect(r.error).toContain("出借 journal");
  });
});

describe("[验收线 1] 交图：每一种都拒交，原因明确，不拷贝、journal 不变", () => {
  const cases: [string, (l: ReturnType<typeof lab>) => string, string][] = [
    ["软链", (l) => {
      const out = join(l.root, "outside.png");
      writeFileSync(out, png("b"));
      symlinkSync(out, join(l.shotsDir, "before-home.png"));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "软链"],
    ["副本内的软链", (l) => {
      l.put("real.png", png("b"));
      symlinkSync(join(l.shotsDir, "real.png"), join(l.shotsDir, "before-home.png"));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "软链不收"],
    ["硬链", (l) => {
      const out = join(l.root, "outside.png");
      writeFileSync(out, png("b"));
      linkSync(out, join(l.shotsDir, "before-home.png"));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "硬链接"],
    ["清单在副本外", (l) => {
      const outDir = mkdtempSync(join(tmpdir(), "lend-ui-out-"));
      writeFileSync(join(outDir, "before-home.png"), png("b"));
      writeFileSync(join(outDir, "after-home.png"), png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() }, join(outDir, "manifest.json"));
    }, "不在这张单的工作副本里"],
    ["file 带斜杠", (l) => l.manifest({ v: 1, summary: "s", shots: [{ ...pair()[0]!, file: "sub/before-home.png" }, pair()[1]] }), "裸文件名"],
    ["不是 PNG", (l) => {
      l.put("before-home.png", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "只收 PNG"],
    ["原始字节超过 1 MiB", (l) => {
      l.put("before-home.png", Buffer.concat([png("b"), Buffer.alloc(1024 * 1024)]));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "超过 1048576"],
    ["不成对", (l) => { l.put("before-home.png", png("b")); return l.manifest({ v: 1, summary: "s", shots: [pair()[0]] }); }, "2–16"],
    ["缺 after", (l) => {
      l.put("before-home.png", png("b")); l.put("before-list.png", png("c")); l.put("after-list.png", png("d"));
      return l.manifest({ v: 1, summary: "s", shots: [pair()[0], ...pair("list")] });
    }, "缺 after"],
    ["超过 16 张", (l) => l.manifest({ v: 1, summary: "s", shots: Array.from({ length: 9 }, (_, i) => pair(`v${i}`)).flat() }), "2–16"],
    ["view 重复", (l) => l.manifest({ v: 1, summary: "s", shots: [...pair(), { ...pair()[0]!, file: "before-home-2.png" }] }), "重复"],
    ["summary 多行", (l) => l.manifest({ v: 1, summary: "第一行\n第二行", shots: pair() }), ".summary"],
    ["summary 超长", (l) => l.manifest({ v: 1, summary: "x".repeat(501), shots: pair() }), ".summary"],
    ["summary 带 /Users/", (l) => l.manifest({ v: 1, summary: "见 /Users/bob/shot", shots: pair() }), "绝对路径片段"],
    ["view 带本机用户名", (l) => l.manifest({ v: 1, summary: "s", shots: pair("ALICE-home") }), "本机用户名或主机名"],
    ["summary 带主机名", (l) => l.manifest({ v: 1, summary: "在 alicebox 上截的", shots: pair() }), "本机用户名或主机名"],
    ["summary 带副本路径", (l) => l.manifest({ v: 1, summary: `存在 ${l.dir}`, shots: pair() }), "绝对路径片段"],
    ["宽度不是 size 的 1 / 2 / 3 倍", (l) => {
      l.put("before-home.png", png("b", 400));
      l.put("after-home.png", png("a"));
      return l.manifest({ v: 1, summary: "s", shots: pair() });
    }, "1 / 2 / 3 倍"],
    ["清单多键", (l) => l.manifest({ v: 1, summary: "s", shots: pair(), path: "/x" }), "只认"],
  ];
  for (const [what, build, why] of cases) {
    test(what, async () => {
      const l = lab();
      const m = build(l);
      for (const [name, b] of [["before-home.png", png("b")], ["after-home.png", png("a")]] as const) {
        if (!existsSync(join(l.shotsDir, name)) && !lstatOrNull(join(l.shotsDir, name))) l.put(name, b);
      }
      const before = JSON.stringify(l.row());
      const r = await l.submit(m);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toContain(why);
      if (what.includes("用户名") || what.includes("主机名") || what.includes("路径")) expect((r as { error: string }).error).not.toMatch(/alice|\/Users\/bob/i);
      expect(l.copies()).toEqual([]);
      expect(JSON.stringify(l.row())).toBe(before);
    });
  }
});

describe("[验收线 1][验收线 5] 开关 off", () => {
  test("不读图（清单不存在也不报错），代码照交，work 里没有 ui，提示一句", async () => {
    const l = lab("off");
    const r = await l.submit(join(l.shotsDir, "nope.json"));
    expect(r).toMatchObject({ ok: true, duplicate: false, note: UI_OFF_NOTE });
    expect(l.row().work).toEqual({ head: HEAD, summary: "改了首页", selfCheck: "逐条对了" });
    expect(l.copies()).toEqual([]);
  });

  test("没传 --ui-shots-file：work 和改动前一样", async () => {
    const l = lab();
    expect(await l.submit(undefined)).toMatchObject({ ok: true });
    expect(l.row().work).toEqual({ head: HEAD, summary: "改了首页", selfCheck: "逐条对了" });
  });
});

describe("[验收线 5] lendUiUpload 的读法", () => {
  function files(policy: string | null) {
    const d = mkdtempSync(join(tmpdir(), "lend-key-"));
    const repoRoot = join(d, "repo");
    mkdirSync(repoRoot);
    const projectsPath = join(d, "projects.json");
    writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "claude-orchestrator", name: "c", dirs: [repoRoot] }] }));
    const policyPath = join(d, "recovery-policy.json");
    if (policy !== null) writeFileSync(policyPath, policy);
    return { projectsPath, policyPath, repoRoot };
  }
  const doc = (p: Record<string, unknown>) => JSON.stringify({ projects: { "claude-orchestrator": p } });
  test("没配键 / 策略文件坏了 / 只配了项目 mode = on → off；显式 observe / on 照读；lendUsageReport 用同一个读法", () => {
    expect(lendUiUploadMode(files(null))).toBe("off");
    expect(lendUiUploadMode(files("{ 坏的"))).toBe("off");
    expect(lendUiUploadMode(files(doc({ mode: "on" })))).toBe("off");
    expect(lendUiUploadMode(files(doc({ keys: { lendUiUpload: "observe" } })))).toBe("observe");
    expect(lendUiUploadMode(files(doc({ mode: "off", keys: { lendUiUpload: "on" } })))).toBe("on");
    const both = files(doc({ keys: { lendUiUpload: "on", lendUsageReport: "observe" } }));
    expect([explicitLendKeyMode("lendUiUpload", both), usageReportMode(both), explicitLendKeyMode("lendUsageReport", both)]).toEqual(["on", "observe", "observe"]);
  });
});
