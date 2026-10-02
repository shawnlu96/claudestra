/**
 * i28-UIQ1：ui 规格必填「## 复用对象」「## 对照基准」；「无，新界面」要引用 owner 已批准的同项目同卡 ask。
 * start_node 的预检（preflightStart）拒 / 放；自动开卡走同一个预检，见 tests/scheduler-autostart-run.test.ts 的 i28-UIQ1 一条。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerAsk, openAskFull } from "../src/lib/ledger-asks.js";
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
  test("ui-head-drift：标题前的声明不能绕过标题后的 ui 必填检查", () => {
    expect(lintUiSpec("模板：code\n# T\n模板：ui\n## 目标\n", no)).toContain("「## 复用对象」「## 对照基准」");
    expect(lintUiSpec("模板：ui\n# T\n模板：code\n## 目标\n", no)).toBeNull();
  });
  test("new-ui-variant：无复用与新页面的常见写法都要求批准", () => {
    for (const reuse of ["无", "无(新界面)", "新界面,无可复用", "无。新界面", "新页面", "无复用", "无需复用", "没有可复用对象", "不复用,全新 UI", "N/A", "-"]) {
      const body = `# T\n模板：ui\n## 复用对象\n${reuse}\n## 对照基准\n/tmp/base.png\n`;
      expect(lintUiSpec(body, no)).toContain("请 PM 发 ask");
      expect(lintUiSpec(body.replace(reuse, `${reuse}，ask_good`), (id) => id === "ask_good")).toBeNull();
    }
    expect(lintUiSpec(`# T\n模板：ui\n## 复用对象\n现有团队视图，无需新增页面\n## 对照基准\n/tmp/base.png`, no)).toBeNull();
  });

  test("new-ui-variant：明确复用且否定新页面时不要求批准", () => {
    const body = "# T\n模板：ui\n## 复用对象\n复用现有组件,不做新页面\n## 对照基准\n/tmp/base.png";
    expect(lintUiSpec(body, no)).toBeNull();
  });

  test("reuse-dash-bullet：复用列表和行内连字符不要求批准", () => {
    for (const reuse of ["- 复用现有团队视图 src/web/TeamView.tsx", "- TeamView 组件\n- 状态徽章", "复用 TeamView - 卡片列表"]) {
      const body = `# T\n模板：ui\n## 复用对象\n${reuse}\n## 对照基准\n/tmp/b.png`;
      expect(lintUiSpec(body, no)).toBeNull();
    }
  });

  test("section-loose：仅精确二级节名算必填，子标题不算内容", () => {
    const bodies = [
      "## 目标\n### 不写复用对象\nfoo\n### 不写对照基准\nbar",
      "## 复用对象\n### 待定\n## 对照基准\n/tmp/base.png",
      "## 不写复用对象\nfoo\n## 对照基准\n/tmp/base.png",
    ];
    for (const body of bodies) expect(lintUiSpec(`# T\n模板：ui\n${body}`, no)).toContain("「## 复用对象」");
    expect(lintUiSpec(`# T\n模板：ui\n## 复用对象\n### 组件\n团队视图\n## 对照基准\n/tmp/base.png`, no)).toBeNull();
  });

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

  test("「无，新界面」：没有批准 ask 拒；引用的不是 owner 批准 ask 拒；是就放", () => {
    const text = (ref: string) => `# T\n模板：ui\n## 复用对象\n无，新界面${ref}\n## 对照基准\n手绘稿 /tmp/sketch.png\n`;
    expect(lintUiSpec(text(""), no)).toContain("请 PM 发 ask");
    expect(lintUiSpec(text("（owner 批：ask_wrong）"), (s) => s === "ask_good")).toContain("请 PM 发 ask");
    expect(lintUiSpec(text("（owner 批：ask_good）"), (s) => s === "ask_good")).toBeNull();
    expect(lintUiSpec(text("，见决定 #12"), () => true)).toContain("请 PM 发 ask");
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

  test("decision-binding：只放同项目同卡 owner 批准 ask，旧 decision 引用拒绝", async () => {
    const text = (ref: string) => `# 规格\n模板：ui\n## 复用对象\n无，新界面（${ref}）\n## 对照基准\n手绘稿\n`;
    const approval = (project: string, taskId: string, pick: string, owner: boolean) => {
      const a = openAskFull(db, { project, taskId, source: "system", kind: "authorize", title: "允许新界面吗",
        options: [{ type: "buttons", buttons: [{ id: "yes", label: "批准" }, { id: "no", label: "拒绝" }] }],
        bind: { action: "ui_new_interface", params: { taskId }, paramsHash: "fixture", approve: ["yes"] },
      }, 1_000).ask;
      answerAsk(db, a.id, { choices: [`[button:${pick}]`], labels: [pick], text: "", principal: "owner", via: "web_card", at: 1_100,
        ...(owner ? { owner: true as const } : {}) });
      return a.id;
    };
    const old = appendEvent(db, { actor: "owner", now: 700 }, { project: P, target: "", kind: "decision", text: "owner 批新界面" });
    const refs = [ `decision #${old.event.seq}`, approval("other", "i28-a", "yes", true), approval(P, "other-card", "yes", true),
      approval(P, "i28-a", "no", true), approval(P, "i28-a", "yes", false) ];
    for (const ref of refs) {
      spec(text(ref));
      expect(await preflightStart(env(), { featureId: "i28", key: "a" })).toMatchObject({ ok: false, code: "spec_lint" });
    }
    spec(text(approval(P, "i28-a", "yes", true)));
    expect(await preflightStart(env(), { featureId: "i28", key: "a" })).toMatchObject({ ok: true });
  });
});
