/**
 * i28-UIQ1：ui 规格必填「## 复用对象」「## 对照基准」；「无，新界面」要引用 owner 记的台账 decision。
 * start_node 的预检（preflightStart）拒 / 放；自动开卡走同一个预检，见 tests/scheduler-autostart-run.test.ts 的 i28-UIQ1 一条。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, setMeta } from "../src/lib/ledger-write.js";
import { lintUiSpec } from "../src/lib/spec-lint.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const BOTH = "## 复用对象\n团队视图（web/app/team）\n## 对照基准\n/tmp/base.png\n";
const no = () => false;

describe("lintUiSpec", () => {
  test("ui 规格缺哪节就点名哪节；空节也算缺", () => {
    expect(lintUiSpec("# T\n模板：ui\n## 目标\n", no)).toContain("「## 复用对象」「## 对照基准」");
    expect(lintUiSpec("# T\n模板：ui\n## 复用对象\n团队视图\n", no)).toContain("「## 对照基准」");
    const emptyReuse = lintUiSpec("# T\n模板：ui\n## 复用对象\n\n## 对照基准\n/tmp/a.png\n", no) as string;
    expect(emptyReuse).toContain("「## 复用对象」");
    expect(emptyReuse).not.toContain("「## 对照基准」");
    expect(lintUiSpec(`# T\n模板：ui\n${BOTH}`, no)).toBeNull();
  });

  test("code / security / 没写模板行的规格不受影响", () => {
    for (const head of ["", "模板：code\n", "模板：security\n", "模板：web\n"]) expect(lintUiSpec(`# T\n${head}## 目标\n`, no)).toBeNull();
    expect(lintUiSpec("# T\n## 目标\n模板：ui\n", no)).toBeNull();
  });

  test("「无，新界面」：没有 owner 决定引用拒；引用的不是 owner decision 拒；是就放", () => {
    const text = (ref: string) => `# T\n模板：ui\n## 复用对象\n无，新界面${ref}\n## 对照基准\n手绘稿 /tmp/sketch.png\n`;
    expect(lintUiSpec(text(""), no)).toContain("decision #<seq>");
    expect(lintUiSpec(text("（owner 批：decision #12）"), (s) => s === 7)).toContain("decision #12");
    expect(lintUiSpec(text("（owner 批：decision #12）"), (s) => s === 12)).toBeNull();
    expect(lintUiSpec(text("，见决定 #12"), (s) => s === 12)).toBeNull();
  });
});

describe("start_node 预检", () => {
  let dir: string, dbPath: string, db: Database;
  const env = (): StartEnv => ({
    db, caller: PM, ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [join(dir, "repo")],
    agentNames: () => [], exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null,
  });
  const spec = (text: string) => writeFileSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"), text);
  const run = (actor: string, ...args: string[]) => runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P],
    loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => 2_000,
  }) as Promise<Record<string, any>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "uiq1-lint-"));
    dbPath = join(dir, "ledger.sqlite");
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    db = openLedger(dbPath);
    db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
    expect((await run(PM, "feature-new", "i28", "--title", "团队视图")).ok).toBe(true);
    expect((await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", JSON.stringify([{ key: "a", oneLine: "a", fileGlobs: ["src/lib/a*.ts"] }]))).ok).toBe(true);
  });
  afterEach(() => {
    closeLedger(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("规格卡文件缺节：拒（spec_lint，写出缺的节）；补上后照常过", async () => {
    spec("# 规格\n模板：ui\n## 复用对象\n团队视图\n");
    const bad = await preflightStart(env(), { featureId: "i28", key: "a", template: "ui" });
    expect(bad).toMatchObject({ ok: false, code: "spec_lint" });
    expect((bad as { error: string }).error).toContain("「## 对照基准」");
    spec(`# 规格\n模板：ui\n${BOTH}`);
    expect(await preflightStart(env(), { featureId: "i28", key: "a", template: "ui" })).toMatchObject({ ok: true });
  });

  test("spec 参数给的正文同样检查；code 规格不受影响", async () => {
    expect(await preflightStart(env(), { featureId: "i28", key: "a", spec: "# 规格\n模板：ui\n## 目标\n" })).toMatchObject({ ok: false, code: "spec_lint" });
    expect(await preflightStart(env(), { featureId: "i28", key: "a", spec: "# 规格\n模板：code\n## 目标\n" })).toMatchObject({ ok: true });
  });

  test("「无，新界面」：引用 owner 记的 decision 才放行", async () => {
    const text = (seq: number) => `# 规格\n模板：ui\n## 复用对象\n无，新界面（decision #${seq}）\n## 对照基准\n手绘稿\n`;
    const pmSaid = appendEvent(db, { actor: PM, now: 600 }, { project: P, target: "", kind: "decision", text: "PM 说新界面" });
    const ownerSaid = appendEvent(db, { actor: "owner", now: 700 }, { project: P, target: "", kind: "decision", text: "owner 批新界面" });
    spec(text(pmSaid.event.seq));
    expect(await preflightStart(env(), { featureId: "i28", key: "a" })).toMatchObject({ ok: false, code: "spec_lint" });
    spec(text(ownerSaid.event.seq));
    expect(await preflightStart(env(), { featureId: "i28", key: "a" })).toMatchObject({ ok: true });
  });
});
