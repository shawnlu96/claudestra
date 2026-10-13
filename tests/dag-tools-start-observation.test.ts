/**
 * merge-arch-SPECOBS1：开卡共用预检 preflightStart 核「## 上线后 PM」首行观察期（恢复键 specObservationHours）。
 * 临时规格 + 合成 DAG 走真实 preflightStart：手动 start_node 与自动开卡（autostartTick）在 on 档拒 spec_lint，不建卡、worktree、agent；
 * observe 只记不拦，off 照旧；UI 授权闸、已开卡幂等不变；postVerifyDefer=off 不影响本检查。纯 lint 见 tests/spec-lint-observation.test.ts。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { postVerifyDeferMode } from "../src/lib/scheduler-post-verify-defer.js";
import { statePath } from "../src/lib/paths.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28";
const PM_OK = "## 上线后 PM\n\n观察期：24 小时\n核对提醒是否按时发出\n";
const body = (head: string, pm = "") => `# 规格\n模板：${head}\n\n## 目标\n做事\n${pm}`;
const UI = "## 复用对象\n团队视图（web/app/team）\n## 对照基准\n/tmp/base.png\n";

let dir: string, db: Database, mode: RecoveryMode, calls: string[][], notes: string[];
const policy: RecoveryPolicyPort = () => ({ mode, manualAfterMs: null, source: "config" });
const specPath = join("ledger", "docs", "tasks", "i28-a.md");
const spec = (text: string) => {
  writeFileSync(join(dir, specPath), text);
  const t = new Date(Date.now() - 120_000);
  utimesSync(join(dir, specPath), t, t);
};
const startEnv = () => ({
  ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [join(dir, "repo")], agentNames: () => [],
  exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null, recoveryPolicy: policy,
});
const env = (): StartEnv => ({ ...startEnv(), db, caller: PM });
const start = (over: Record<string, string> = {}) => preflightStart(env(), { featureId: "i28", key: "a", ...over });
/** preflightStart 不注入 observeDir：读缺省 statePath("spec-observation")（测试进程是临时目录），按规格摘要挑本例的记录 */
const observed = (text: string) => {
  const d = statePath("spec-observation"), sha = createHash("sha256").update(text).digest("hex").slice(0, 24);
  return existsSync(d) ? readdirSync(d).map((f) => JSON.parse(readFileSync(join(d, f), "utf8"))).filter((r) => r.digest === sha) : [];
};

beforeEach(() => {
  mode = "on";
  calls = [];
  notes = [];
  dir = mkdtempSync(join(tmpdir(), "specobs-start-"));
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  createFeature(db, { actor: PM, now: 600 }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: 700 }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("手动 start_node：preflightStart", () => {
  test("on：code / security 缺首行观察期拒 spec_lint，不建卡、不建 worktree；补上后过", async () => {
    for (const head of ["code", "security"]) {
      spec(body(head));
      const bad = await start({ template: head });
      expect(bad).toMatchObject({ ok: false, code: "spec_lint" });
      expect((bad as { error: string }).error).toContain("缺「## 上线后 PM」");
      spec(body(head, "## 上线后 PM\n核对动作\n观察期：24 小时\n"));
      expect(await start({ template: head })).toMatchObject({ ok: false, code: "spec_lint" });
      spec(body(head, PM_OK));
      expect(await start({ template: head })).toMatchObject({ ok: true });
    }
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：inline spec 与正式文件同一检查；没有规格给缺规格原因", async () => {
    expect(await start({ spec: body("code") })).toMatchObject({ ok: false, code: "spec_lint" });
    expect(await start({ spec: body("code", PM_OK) })).toMatchObject({ ok: true });
    expect(await start()).toMatchObject({ ok: false, code: "spec_lint", error: expect.stringContaining("缺规格 / 缺观察期") });
  });

  test("on：缩进代码块里的观察期（四空格 / 制表符）inline 与正式文件、code / ui / security 都拒", async () => {
    for (const ind of ["    ", "\t"]) {
      const pm = `## 上线后 PM\n\n${ind}观察期：24 小时\n\n核对提醒是否按时发出\n`;
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + pm);
        const why = expect.stringContaining("首行缩进");
        expect(await start({ template: head, spec: text })).toMatchObject({ ok: false, code: "spec_lint", error: why });
        spec(text);
        expect(await start({ template: head })).toMatchObject({ ok: false, code: "spec_lint", error: why });
      }
    }
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：标记回归按行规则（引用定义是动作行），inline 与文件一致", async () => {
    for (const tail of ["- [ ]", "---", "<!-- TODO -->", ">", "-", "[ref]: https://example.com",
      "[ref]:\nhttps://example.com", "> [ref]: https://example.com", "[ref]: https://example.com\n\"reference title\""]) {
      const pm = `## 上线后 PM\n观察期：24 小时\n\n${tail}\n`;
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + pm);
        const expected = tail.includes("[ref]") ? { ok: true } : { ok: false, code: "spec_lint", error: expect.stringContaining("没有 PM 核对动作") };
        rmSync(join(dir, specPath), { force: true });
        expect(await start({ template: head, spec: text })).toMatchObject(expected);
        spec(text);
        expect(await start({ template: head })).toMatchObject(expected);
      }
    }
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：quoted-action-swallowed：无效引用标题保留可见核对动作（12 组真实 preflight）", async () => {
    for (const tail of ['[ref]: https://example.com\n"核对提醒" 并核对部署结果',
      '[ref]: https://example.com\n"未闭合标题\n核对部署结果']) {
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n观察期：24 小时\n\n${tail}\n`);
        rmSync(join(dir, specPath), { force: true });
        expect(await start({ template: head, spec: text })).toMatchObject({ ok: true });
        spec(text);
        expect(await start({ template: head })).toMatchObject({ ok: true });
      }
    }
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：title-crosses-block：引用标题不能吞掉后续列表或引用动作", async () => {
    const results = [];
    for (const tail of ['[ref]: https://example.com\n(见附录\n- 核对部署结果\n- 核对监控)',
      '[ref]: https://example.com\n"见文档\n- 核对部署结果\n"',
      '[ref]: https://example.com\n"见文档\n> 核对部署结果"',
      '[ref]: https://example.com "见文档\n- 核对部署结果"',
      '[ref]: https://example.com\n"见文档\n<div>\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n<details>\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n#\n核对部署结果"',
      '[ref]:\n> https://example.com\n> "标题"']) {
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n观察期：24 小时\n\n${tail}\n`);
        rmSync(join(dir, specPath), { force: true });
        results.push(await start({ template: head, spec: text }));
        spec(text);
        results.push(await start({ template: head }));
      }
    }
    expect(results).toHaveLength(48);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：title-boundary-overbreak：按行规则引用定义行算动作", async () => {
    const results = [];
    for (const tail of ['[ref]: https://example.com\n"见文档\n2. 核对部署结果"',
      '[ref]: https://example.com\n"见文档\n    - x\n核对部署结果"',
      '[ref]: https://example.com\n"见文档\n\t- 核对部署结果"',
      '> [ref]: https://example.com\n> "多行\n标题"']) {
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n观察期：24 小时\n\n${tail}\n`);
        rmSync(join(dir, specPath), { force: true });
        results.push(await start({ template: head, spec: text }));
        spec(text);
        results.push(await start({ template: head }));
      }
    }
    expect(results).toHaveLength(24);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });

  test("on：action-context-loss：保留观察期段落的缩进续行上下文", async () => {
    const results = [];
    for (const tail of ['    核对部署结果', '\t核对部署结果', '    - 核对部署结果\n    - 核对监控']) {
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n观察期：24 小时\n${tail}\n`);
        rmSync(join(dir, specPath), { force: true });
        results.push(await start({ template: head, spec: text }));
        spec(text);
        results.push(await start({ template: head }));
      }
    }
    expect(results).toHaveLength(18);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  test("on：first-line-trailing-space-bypass：行尾空白不改变按行动作判定", async () => {
    const results = [];
    for (const space of [' ', '  ', '\t', ' \r']) {
      for (const tail of ['### 子标题', '<!-- todo -->', '\n***', '```\n核对示例\n```', '\n![图片](https://example.com/a.png)']) {
        for (const head of ["code", "security", "ui"]) {
          const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n观察期:24 小时${space}\n${tail}\n`);
          rmSync(join(dir, specPath), { force: true });
          results.push({ result: await start({ template: head, spec: text }), image: tail.includes("![图片]") });
          spec(text);
          results.push({ result: await start({ template: head }), image: tail.includes("![图片]") });
        }
      }
    }
    expect(results).toHaveLength(120);
    expect(results.filter(({ result: r, image }) => image ? !r.ok : r.ok || r.code !== "spec_lint")).toEqual([]);
  });

  test("on：first-line-indent-pass：观察期首行任何空白缩进均拒", async () => {
    const results = [];
    for (const indent of [' ', '  ', '   ', '\t', '　']) {
      for (const head of ["code", "security", "ui"]) {
        const text = body(head, (head === "ui" ? UI : "") + `## 上线后 PM\n${indent}观察期:24 小时\n核对部署\n`);
        rmSync(join(dir, specPath), { force: true });
        results.push(await start({ template: head, spec: text }));
        spec(text);
        results.push(await start({ template: head }));
      }
    }
    expect(results).toHaveLength(30);
    expect(results.filter((r) => r.ok || r.code !== "spec_lint")).toEqual([]);
  });

  test("ui：观察期有效仍受原 UI 必填闸；UI 闸 off 档之外照旧", async () => {
    spec(body("ui", PM_OK));
    expect(await start({ template: "ui" })).toMatchObject({ ok: false, code: "spec_lint", error: expect.stringContaining("「## 复用对象」") });
    mode = "off";
    expect(await start({ template: "ui" })).toMatchObject({ ok: false, code: "spec_lint", error: expect.stringContaining("「## 复用对象」") });
    mode = "on";
    spec(body("ui", UI));
    expect(await start({ template: "ui" })).toMatchObject({ ok: false, code: "spec_lint", error: expect.stringContaining("上线后 PM") });
    spec(body("ui", UI + PM_OK));
    expect(await start({ template: "ui" })).toMatchObject({ ok: true });
  });

  test("observe 只记不拦（同一份规格只记一次、不写台账 note）；off 不跑", async () => {
    const text = body("code", `<!-- ${dir} -->\n`);
    spec(text);
    mode = "observe";
    const before = listEvents(db, { project: P }).length;
    expect(await start()).toMatchObject({ ok: true });
    expect(await start()).toMatchObject({ ok: true });
    expect(observed(text)).toHaveLength(1);
    expect(listEvents(db, { project: P })).toHaveLength(before);
    mode = "off";
    spec(body("security", `<!-- ${dir} -->\n`));
    expect(await start()).toMatchObject({ ok: true });
    expect(observed(body("security", `<!-- ${dir} -->\n`))).toEqual([]);
  });

  test("postVerifyDefer=off 时 on 仍独立拒格式错误", async () => {
    setAutostartSwitch(db, { actor: PM, now: 800 }, { project: P, on: true, postVerifyDefer: "off", reason: "测试" });
    expect(postVerifyDeferMode(db, P)).toBe("off");
    spec(body("code", "## 上线后 PM\n观察期：0 小时\n核对动作\n"));
    expect(await start()).toMatchObject({ ok: false, code: "spec_lint", error: expect.stringContaining("格式没认出") });
  });

  test("已开卡的节点幂等返回，不重判规格", async () => {
    createTask(db, { actor: PM, now: 900 }, { project: P, id: "i28-a", title: "a", kind: "code" });
    bindNode(db, { actor: PM, now: 901 }, { id: FID, rev: getFeature(db, FID)!.rev, key: "a", taskId: "i28-a" });
    spec(body("code"));
    expect(await start()).toEqual({ ok: true, already: { taskId: "i28-a", key: "a" } });
  });
});

describe("自动开卡复用同一预检", () => {
  const record = (tag: string) => async (args: string[]) => {
    calls.push([tag, ...args]);
    return tag === "git" ? { ok: true, out: "" } : { ok: true };
  };
  const tickEnv = (): StartTickEnv => ({
    db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 },
    ledger: async (...args: string[]) => {
      calls.push(args);
      return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }) as never,
        saveRegistry: async () => {}, now: Date.now, autoDispatch: () => true, autoProjects: () => [P] }) as Promise<Record<string, unknown>>;
    },
    plain: record("plain"), startEnv,
    stepIO: { git: (_cwd: string, a: string[]) => record("git")(a), exists: existsSync, read: () => null, write: (p: string) => void calls.push(["write", p]),
      remove: () => {}, symlink: () => {}, agentExists: () => false } as never,
    readSpec: () => ({ mtimeMs: statSync(join(dir, specPath)).mtimeMs, text: readFileSync(join(dir, specPath), "utf8") }),
    quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null,
      windows: [{ id: "7d", kind: "weekly", usedPct: 20, resetsAtMs: 9e12, resetPassed: false }] }) as never,
    notifyPm: async (_p, text) => void notes.push(text), memo: new Set(), now: Date.now, attempt: () => "a1",
  });

  test("on：缺首行观察期不开卡、不建 worktree / agent / 提示词，结 spec_lint 并通知 PM", async () => {
    spec(body("code"));
    await autostartTick(tickEnv());
    expect(getTask(db, "i28-a")).toBeNull();
    expect(calls.filter((c) => c[0] !== "ledger" || c[2] === "step")).toEqual([]);
    expect(listEvents(db, { target: FID }).find((e) => e.data.op === "autostart_settle")!.data.code).toBe("spec_lint");
    expect(notes.join("\n")).toContain("上线后 PM");
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
  });
});
