/**
 * team-project-N8B8：DAG 新版本落库前先过和来源镜像推送相同的外发检查（src/lib/dag-write-scrub.ts）。
 * 夹具里的「路径」是编造的，只复刻 10-11 v141 的形状：35 个字符、不带空格，被随机串规则判中。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAG_WRITE_SCRUB_HINT, dagWriteBlocked, dagWriteScrubProbe } from "../src/lib/dag-write-scrub.js";
import { approveDag, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, LedgerError, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { commitQuery } from "../src/lib/peer-pr-github.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { pushSourceDagMirror, SOURCE_DAG_REASONS } from "../src/lib/shared-ledger-source-dag-push.js";
import { sharedLedgerDagVersion, sourceDagScrubView } from "../src/lib/shared-ledger-source-dag-push-version.js";
import type { SourceDagUpload } from "../src/lib/shared-ledger-contract-source-dag.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { cleanupMirrorState, commitJournal, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

/** 编造的路径，形状同 v141：35 个字符、无空格，文件名一段有大写、小写和数字 */
const BAD = "demo-project-ZETAQK-r13-20270102.md";
const REASON_HINT = `${DAG_WRITE_SCRUB_HINT}dag.reason`;

const setPolicy = (project: string, mode: RecoveryMode) => {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [project]: { keys: { dagWriteScrub: mode } } } }));
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  dagWriteScrubProbe.view = undefined;
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const c of cleanups.splice(0).reverse()) await c();
  cleanupMirrorState();
});

type Fixture = ReturnType<typeof integrationFixture>;
function fixture(): Fixture {
  const f = integrationFixture();
  cleanups.push(() => f.close());
  return f;
}
/** 真走一遍 `shared-mirror on`：模式文件 mirror=true，镜像状态里有这个 feature 的条目 */
async function mirrored(): Promise<Fixture> {
  const f = fixture();
  await commitJournal(f, "batch-n8b8");
  await serviceCredential();
  expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
  return f;
}
const rewrite = (f: Fixture, reasonText: string, extra: Record<string, unknown> = {}) => rewriteDag(f.db, { actor: f.actor }, {
  id: f.id, rev: f.feature().rev, reasonKind: "new_issue", reasonText, cancel: new Map(), scopeChange: false, askFrom: { agent: f.actor, channelId: null },
  nodes: [{ key: "existing", taskId: "c5-existing" }, { key: "next", oneLine: "New work", fileGlobs: ["src/lib/c5.ts"] }, { key: "more", oneLine: "More work", deps: ["next"], ...extra }],
});
const refusal = (run: () => unknown): LedgerError => {
  try { run(); } catch (e) { if (e instanceof LedgerError) return e; throw e; }
  throw new Error("没有被拒");
};
/** 推送一次当前版本，拿到 buildSourceDagUpload 交给中心的那份（中心装作不认识这个接口，不改状态） */
async function pushed(f: Fixture) {
  const uploads: SourceDagUpload[] = [], entry = readSharedLedgerMirrors()[f.id]!;
  const next = await pushSourceDagMirror(f.db, f.id, entry, { scrub: SCRUB, now: 5_000_000,
    client: { sourceDag: async (u) => { uploads.push(u); return { kind: "unsupported" }; } } });
  return { uploads, entry, next };
}

describe("来源镜像 feature", () => {
  test("夹具形状和 v141 一致；键登记一次，缺省 observe", () => {
    expect(BAD).toHaveLength(35);
    expect(BAD).not.toMatch(/\s/);
    expect(RECOVERY_KEYS.filter((k) => k === "dagWriteScrub")).toHaveLength(1);
    expect(recoveryPolicy("no-such-project", "dagWriteScrub").mode).toBe("observe");
  });

  test("[验收线 1] on：版本说明含 35 字符无空格路径，写入被拒，报错只有字段路径", async () => {
    const f = await mirrored();
    setPolicy(f.project, "on");
    const e = refusal(() => rewrite(f, `修第 13 轮的问题，证据见 ${BAD}`));
    expect(e.code).toBe("invalid");
    expect(e.message).toStartWith(REASON_HINT);
    expect(e.message).not.toContain(BAD);
    expect(e.message).not.toContain("ZETAQK");
    expect(e.current).toEqual({ dagWriteScrub: ["dag.reason"] });
    expect(f.feature().currentVersion).toBe(1);
    expect(getDagVersion(f.db, f.id, 2)).toBeNull();
    // CLI 同样：报错不回显内容
    const cli = await f.ledger(["dag-rewrite", f.id, "--rev", String(f.feature().rev), "--reason-kind", "new_issue", "--reason", `证据见 ${BAD}`,
      "--nodes", JSON.stringify([{ key: "existing", taskId: "c5-existing" }, { key: "next", oneLine: "New work", fileGlobs: ["src/lib/c5.ts"] }, { key: "more", oneLine: "More work" }])]);
    expect(cli).toMatchObject({ ok: false });
    expect(JSON.stringify(cli)).toContain("dag.reason");
    expect(JSON.stringify(cli)).not.toContain(BAD);
  });

  test("[验收线 1] observe（缺省）：写入成功，事件 data 和回给 PM 的话带『这一版推不出去』，不回显内容；推送确实被拦", async () => {
    const f = await mirrored();
    const r = rewrite(f, `修第 13 轮的问题，证据见 ${BAD}`);
    expect(f.feature().currentVersion).toBe(2);
    expect(r.event.data.dagWriteScrub).toBe(REASON_HINT);
    expect(r.row.inform).toEndWith(`\n${REASON_HINT}`);
    // 旧行为（main）：这一版照写、没有任何提示，推送才发现被拦——提示和推送的判定一致
    const { uploads, next } = await pushed(f);
    expect(uploads).toHaveLength(0);
    expect(next.dagError?.reason).toBe(SOURCE_DAG_REASONS.blocked);
  });

  test("off：和 main 一致，不检查、不提示", async () => {
    const f = await mirrored();
    setPolicy(f.project, "off");
    const r = rewrite(f, `证据见 ${BAD}`);
    expect(f.feature().currentVersion).toBe(2);
    expect(r.event.data).not.toHaveProperty("dagWriteScrub");
    expect(r.row.inform).not.toContain(DAG_WRITE_SCRUB_HINT);
  });

  test("[验收线 3] on：干净的版本照常写入；检查对象和落库后 buildSourceDagUpload 读出的一致", async () => {
    const f = await mirrored();
    setPolicy(f.project, "on");
    const views: unknown[] = [];
    dagWriteScrubProbe.view = (v) => views.push(v);
    const r = rewrite(f, "修第 13 轮的问题：补两处边界判断");
    expect(r.event.data).not.toHaveProperty("dagWriteScrub");
    expect(f.feature().currentVersion).toBe(2);
    expect(views).toHaveLength(1);
    const { uploads, entry, next } = await pushed(f);
    expect(next.dagError ?? null).toBeNull();
    expect(uploads).toHaveLength(1);
    // 推送从库里读出来的那份，和写入前检查的那份逐字段相同
    expect(views[0]).toEqual(sourceDagScrubView(uploads[0]!));
    const dag = getDagVersion(f.db, f.id, 2)!;
    expect(views[0]).toEqual(sourceDagScrubView({ projectId: entry.projectId, featureId: entry.centerFeatureId, sourceInstanceId: entry.sourceInstanceId,
      dag: sharedLedgerDagVersion(dag, effectiveNodes(f.db, dag)) }));
  });

  test("节点文字、fileGlobs 也查；只返回字段路径", async () => {
    const f = await mirrored();
    setPolicy(f.project, "on");
    const e = refusal(() => rewrite(f, "干净的说明", { oneLine: `看 ${BAD}`, fileGlobs: ["src/lib/a@b.ts"] }));
    expect(e.current).toEqual({ dagWriteScrub: ["dag.nodes[2].fileGlobs[0]", "dag.nodes[2].oneLine"] });
    expect(e.message).not.toContain(BAD);
    expect(f.feature().currentVersion).toBe(1);
    const dag = { version: 2, reasonText: `x ${BAD}`, nodes: getDagVersion(f.db, f.id, 1)!.nodes };
    expect(dagWriteBlocked(f.db, f.feature(), dag, { scrub: () => SCRUB })).toEqual(["dag.reason"]);
  });

  test("要 owner 批的重写：on 下提案前就拒；observe 下提案和批准生效的事件都带提示", async () => {
    const f = await mirrored();
    setPolicy(f.project, "on");
    const propose = (reason: string) => rewriteDag(f.db, { actor: f.actor }, { id: f.id, rev: f.feature().rev, reasonKind: "requirement_change", reasonText: reason,
      cancel: new Map(), scopeChange: true, askFrom: { agent: f.actor, channelId: null },
      nodes: [{ key: "existing", taskId: "c5-existing" }, { key: "next", oneLine: "New work", fileGlobs: ["src/lib/c5.ts"] }, { key: "more", oneLine: "More work" }] });
    expect(refusal(() => propose(`证据见 ${BAD}`)).current).toEqual({ dagWriteScrub: ["dag.reason"] });
    expect(f.db.query("SELECT COUNT(*) AS n FROM dag_proposals").get()).toEqual({ n: 0 });
    setPolicy(f.project, "observe");
    const p = propose(`证据见 ${BAD}`);
    expect(p.row.proposal?.state).toBe("pending");
    expect(p.event.data.dagWriteScrub).toBe(REASON_HINT);
    // owner 批了之后开关切到 on：生效那一刻再查一次，提案作废、不写版本
    f.db.prepare("UPDATE asks SET state = 'answered', answer = ? WHERE id = ?").run(JSON.stringify({ choices: ["[button:dag_rewrite_approve]"], labels: ["批准"],
      text: "", principal: "owner", at: Date.now(), owner: true }), p.row.ask!.id);
    setPolicy(f.project, "on");
    const a = approveDag(f.db, { actor: f.actor }, { id: f.id });
    if (a.row.applied) throw new Error("被拦的提案不该生效");
    expect(a.row.why).toStartWith(REASON_HINT);
    expect(a.row.why).not.toContain(BAD);
    expect(f.feature().currentVersion).toBe(1);
  });
});

describe("非来源镜像 feature", () => {
  test("[验收线 2] 同样内容写入成功、无提示，结果和 main 逐字一致（on 也一样）", async () => {
    for (const mode of ["on", "observe"] as const) {
      const f = fixture();
      setPolicy(f.project, mode);
      const views: unknown[] = [];
      dagWriteScrubProbe.view = (v) => views.push(v);
      const reason = `修第 13 轮的问题，证据见 ${BAD}`;
      const r = rewrite(f, reason);
      expect(views).toHaveLength(0);
      expect(f.feature().currentVersion).toBe(2);
      expect(getDagVersion(f.db, f.id, 2)!.reasonText).toBe(reason);
      expect(r.event.data).toEqual({ op: "dag-rewrite", version: 2, reasonKind: "new_issue", auto: true, uiPageCheck: true, rev: f.feature().rev });
      expect(r.row.inform).toBe(`Gate integration：子 DAG 已重写成 v2（new_issue：${reason}）。${r.event.text}`);
    }
  });
});

describe("三个落库点", () => {
  const ctx = { actor: "owner", now: 100 };
  const node = (key: string, deps: string[] = []) => ({ key, oneLine: `node ${key}`, deps });
  /** 落在文件上的台账（模式文件的发布要拿台账写锁）；镜像模式直接写进模式文件，没有镜像条目 */
  async function local(mirror: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "n8b8-write-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    db.exec("INSERT INTO ledger_instance VALUES ('origin','n8b8')");
    setMeta(db, ctx, { project: "n8b8p", key: "pms", value: ["pm"] });
    for (const id of mirror) await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: true, mirror: true }, undefined, path);
    cleanups.push(async () => {
      for (const id of mirror) await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: false }, undefined, path);
      closeLedger(path);
      rmSync(dir, { recursive: true, force: true });
    });
    return db;
  }
  const afterWrite = (db: ReturnType<typeof openLedger>, id: string) => {
    const dag = getDagVersion(db, id, getFeature(db, id)!.currentVersion)!;
    return sourceDagScrubView({ projectId: undefined, featureId: undefined, sourceInstanceId: undefined, dag: sharedLedgerDagVersion(dag, effectiveNodes(db, dag)) });
  };

  test("[验收线 3] initDag（ledger-feature-write.ts）：on 下被拦的拒写，干净的照常写入且检查对象一致；observe 带提示", async () => {
    const db = await local(["n8b8-init", "n8b8-watch"]);
    setPolicy("n8b8p", "on");
    for (const slug of ["init", "watch", "plain"]) createFeature(db, ctx, { project: "n8b8p", slug, title: slug });
    const e = refusal(() => initDag(db, ctx, { id: "n8b8-init", rev: 1, nodes: [node("A")], reasonText: `见 ${BAD}` }));
    expect(e.current).toEqual({ dagWriteScrub: ["dag.reason"] });
    expect(e.message).not.toContain(BAD);
    expect(getFeature(db, "n8b8-init")!.currentVersion).toBe(0);
    const views: unknown[] = [];
    dagWriteScrubProbe.view = (v) => views.push(v);
    const ok = initDag(db, ctx, { id: "n8b8-init", rev: 1, nodes: [node("A"), node("B", ["A"])], reasonText: "初版" });
    expect(ok.event.data).not.toHaveProperty("dagWriteScrub");
    expect(views).toEqual([afterWrite(db, "n8b8-init")]);
    // 非镜像的 feature：on 下同样内容照写，事件和 main 一样
    const plain = initDag(db, ctx, { id: "n8b8-plain", rev: 1, nodes: [node("A")], reasonText: `见 ${BAD}` });
    expect(plain.event.data).toEqual({ op: "dag-init", version: 1, uiPageCheck: true, nodes: ["A"], rev: 2 });
    setPolicy("n8b8p", "observe");
    const seen = initDag(db, ctx, { id: "n8b8-watch", rev: 1, nodes: [node("A")], reasonText: `见 ${BAD}` });
    expect(seen.event.data.dagWriteScrub).toBe(REASON_HINT);
    expect(getFeature(db, "n8b8-watch")!.currentVersion).toBe(1);
  });

  test("[验收线 3] applyFeatureSplit（ledger-feature-split.ts）：干净的照常写入且检查对象一致；被拦的 on 下整笔不写、observe 带提示", async () => {
    const LONG = "Demo-node-ZETAQK-r13-20270102-abcdef"; // 36 位的节点 key：split 的版本说明会带上它
    const db = await local(["n8b8-src", "n8b8-wide"]);
    for (const slug of ["src", "wide"]) createFeature(db, ctx, { project: "n8b8p", slug, title: slug });
    initDag(db, ctx, { id: "n8b8-src", rev: 1, nodes: [node("A"), node("B")] });
    setPolicy("n8b8p", "off"); // 先把带长 key 的初版写进去（on 下 initDag 自己就会拒）
    initDag(db, ctx, { id: "n8b8-wide", rev: 1, nodes: [node(LONG), node("B")] });
    setPolicy("n8b8p", "on");
    const views: unknown[] = [];
    dagWriteScrubProbe.view = (v) => views.push(v);
    const done = applyFeatureSplit(db, { ...ctx, dedupKey: "split-clean" }, "n8b8-src", { targets: [{ slug: "one", title: "One", nodes: ["A"] }], deps: [] }, () => null);
    expect(done.duplicate).toBe(false);
    expect(getFeature(db, "n8b8-src")!.currentVersion).toBe(2);
    expect(views).toEqual([afterWrite(db, "n8b8-src")]); // 新拆出的 n8b8-one 不是来源镜像，不检查
    const version = (id: string) => db.query("SELECT data FROM events WHERE target = ? AND json_extract(data,'$.op') = 'feature-split-version'").all(id)
      .map((r) => JSON.parse((r as { data: string }).data) as Record<string, unknown>);
    expect(version("n8b8-src")[0]).not.toHaveProperty("dagWriteScrub");
    const wide = { targets: [{ slug: "two", title: "Two", nodes: [LONG] }], deps: [] };
    const e = refusal(() => applyFeatureSplit(db, { ...ctx, dedupKey: "split-wide" }, "n8b8-wide", wide, () => null));
    expect(e.current).toEqual({ dagWriteScrub: ["dag.reason"] });
    expect(e.message).not.toContain("ZETAQK");
    expect(getFeature(db, "n8b8-wide")!.currentVersion).toBe(1);
    expect(getFeature(db, "n8b8-two")).toBeNull(); // 整笔回滚：新 feature 也没建
    setPolicy("n8b8p", "observe");
    const seen = applyFeatureSplit(db, { ...ctx, dedupKey: "split-wide" }, "n8b8-wide", wide, () => null);
    expect(getFeature(db, "n8b8-wide")!.currentVersion).toBe(2);
    expect(version("n8b8-wide")[0]!.dagWriteScrub).toBe(REASON_HINT);
    // 第 1 轮审查 split-observe-output：命令结果（CLI 原样展开 applyFeatureSplit 的返回值）和最终 feature-split 事件都带提示
    const line = `${REASON_HINT}（n8b8-wide v2）`; // 新拆出的 n8b8-two 不是来源镜像，没有它的行
    expect((seen as { dagWriteScrub?: string }).dagWriteScrub).toBe(line);
    expect(seen.event.data).toMatchObject({ op: "feature-split", dagWriteScrub: line });
    expect(JSON.stringify(seen.event.data.dagWriteScrub)).not.toContain("ZETAQK");
    const again = applyFeatureSplit(db, { ...ctx, dedupKey: "split-wide" }, "n8b8-wide", wide, () => null);
    expect(again).toMatchObject({ duplicate: true, dagWriteScrub: line }); // dedup 重放照样带
    expect(getFeature(db, "n8b8-wide")!.currentVersion).toBe(2);
    // 干净的那次：返回值和最终事件都没有这个字段，重放也没有
    expect(done).not.toHaveProperty("dagWriteScrub");
    expect(done.event.data).not.toHaveProperty("dagWriteScrub");
    expect(applyFeatureSplit(db, { ...ctx, dedupKey: "split-clean" }, "n8b8-src", { targets: [{ slug: "one", title: "One", nodes: ["A"] }], deps: [] }, () => null))
      .not.toHaveProperty("dagWriteScrub");
  });

  test("commitQuery（peer-pr-github.ts）：异步的 knownCommits 和写入前的同步核对用同一份参数与解析", () => {
    const a = "a".repeat(40), b = "B".repeat(64), q = commitQuery("/repo", [a, b, a, "not-a-sha", "c".repeat(39)]);
    expect(q.want).toEqual([a, b.toLowerCase()]);
    expect(q.argv).toEqual(["git", "-C", "/repo", "cat-file", "--batch-check"]);
    expect(q.stdin).toBe(`${a}\n${b.toLowerCase()}\n`);
    expect([...q.parse(`${a} commit 250\n${b.toLowerCase()} missing\n${"d".repeat(40)} commit 9\n${a} blob 3\n`)]).toEqual([a]);
    expect(commitQuery("/repo", Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(40, "0"))).want).toHaveLength(200);
  });
});
