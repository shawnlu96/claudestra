/** 记忆写入函数（pmem-M1 验收线 4：每次写入追加一条 memory 事件）+ 结构校验、锚点、脱敏两类、幂等 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getMemory, listMarks, markMemory, memoryDigest, memoryState, recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { isAskEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";

const P = "demo";
let db: Database;
const ctx = (actor = "agent-r", now = 1_000) => ({ actor, now });
const memEvents = () => listEvents(db, { project: P }).filter((e) => e.kind === "memory");

const PIT: MemoryInput = {
  project: P, kind: "pitfall", title: "事务回调里不能 await", symptom: "事务提前提交", rule: "事务内只做同步写",
  files: ["src/lib/widget-store.ts"], family: "widget-tx", fixable: true, via: "tool", authorRole: "reviewer",
  taskId: "N2", head: "abc1234", specRev: 1, sources: [{ origin: "ab12", originSeq: 7 }],
};

beforeEach(() => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  db.prepare("INSERT INTO features (id, project, title, status, createdBy, createdAt, updatedAt) VALUES ('ab12-fx', ?, 'gadget 改版', 'active', 'pm', 1, 1)").run(P);
  for (const id of ["N1f", "N2"]) createTask(db, { actor: "owner", now: 1 }, { project: P, id, title: id, kind: "code" });
  createTask(db, { actor: "owner", now: 1 }, { project: "other", id: "X1", title: "x", kind: "code" });
  db.prepare("UPDATE tasks SET featureId = 'ab12-fx' WHERE id = 'N2'").run();
});
afterEach(() => closeLedger(":memory:"));

describe("recordMemory", () => {
  test("写一行 + 追加一条 memory 事件（target = 锚点卡，data 不复制正文）；id 带本机前缀与序号；featureId 取卡当时的", () => {
    const w = recordMemory(db, ctx(), PIT);
    expect(w.memory).toMatchObject({
      id: "ab12-m1", origin: "ab12", originSeq: 1, featureId: "ab12-fx", taskId: "N2", author: "agent-r", visibility: "team",
      body: { symptom: "事务提前提交", rule: "事务内只做同步写" }, fixable: true, files: ["src/lib/widget-store.ts"], redactionVersion: 1,
    });
    expect(w.memory.digest).toBe(memoryDigest(PIT.title, JSON.stringify({ symptom: "事务提前提交", rule: "事务内只做同步写" }), PIT.files as string[]));
    expect(w.event).toMatchObject({ kind: "memory", target: "N2", actor: "agent-r", data: { memoryId: "ab12-m1", kind: "pitfall" } });
    expect(JSON.stringify(w.event?.data)).not.toContain("同步写");
    expect(recordMemory(db, ctx(), PIT).memory.id).toBe("ab12-m2");
    expect(memEvents().length).toBe(2);
  });

  test("memory 事件不算卡的「最近一条」（isAskEvent 排除）", () => {
    const { event } = recordMemory(db, ctx(), PIT);
    expect(isAskEvent(event as { kind: string; data: Record<string, unknown> })).toBe(true);
  });

  test("项目级坑（无锚点）target 为空；锚 feature 时 target = featureId", () => {
    const base = { ...PIT, taskId: undefined, head: undefined, specRev: undefined };
    expect(recordMemory(db, ctx(), base).event?.target).toBe("");
    expect(recordMemory(db, ctx(), { ...base, featureId: "ab12-fx", nodeKey: "N1" }).event?.target).toBe("ab12-fx");
  });

  test("结构校验：长度超限直接拒不截断、坑要 fixable 与两段、总结要锚卡、锚卡要 head / specRev、family 字符集、files 仓库相对", () => {
    const bad = (patch: Partial<MemoryInput>, re: RegExp) => expect(() => recordMemory(db, ctx(), { ...PIT, ...patch })).toThrow(re);
    bad({ title: "长".repeat(30) }, /title 超过 80 字节/);
    bad({ symptom: "x".repeat(301) }, /symptom 超过 300/);
    bad({ fixable: undefined }, /坑要给 fixable/);
    bad({ rule: undefined }, /rule 必填/);
    bad({ body: "x" }, /不收 body/);
    bad({ kind: "summary", fixable: undefined, symptom: undefined, rule: undefined, body: "x", taskId: undefined }, /总结要锚在卡上/);
    bad({ head: undefined }, /head 与 specRev/);
    bad({ family: "有空格 的" }, /family/);
    bad({ files: ["/abs/path.ts"] }, /仓库相对/);
    bad({ files: ["../x.ts"] }, /仓库相对/);
    bad({ files: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }, /最多 20 项/);
    bad({ sources: [{ origin: "AB", originSeq: 1 } as never] }, /sources\[0\]/);
    bad({ via: "import", sources: [], sourceNote: undefined }, /sourceNote/);
    bad({ taskId: "X1" }, /没有卡 X1/);
    bad({ featureId: "ab12-other" }, /不一致/);
    expect(memEvents()).toEqual([]);
  });

  test("脱敏一（密钥 / 地址 / 个人信息形状）：拒绝写入，什么都不落，报错只说字段位置", () => {
    const token = "ghp_" + "a".repeat(30);
    for (const patch of [{ title: `别泄露 ${token}` }, { rule: "连 10.1.2.3:8080 前先" }, { rule: "公网 8.8.8.8 不通时" }, { symptom: "见 /Users/someone/x" }, { files: ["a@b.example.com"] }]) {
      let msg = "";
      try {
        recordMemory(db, ctx(), { ...PIT, ...patch });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/脱敏闸命中/);
      expect(msg).not.toContain(token);
    }
    expect([db.query("SELECT COUNT(*) AS n FROM memories").get(), memEvents().length]).toEqual([{ n: 0 }, 0]);
  });

  test("脱敏一查原始 symptom / rule，不查序列化后的正文（body-redaction）：换行、制表符、引号字段名不能绕过", () => {
    const token = "ghp_" + "a".repeat(30);
    const base = { ...PIT, taskId: undefined, head: undefined, specRev: undefined };
    for (const patch of [{ rule: "details\n" + token }, { rule: "details\t" + token }, { symptom: "见\n" + token }, { rule: '{"password": "hunter2-correct-horse"}' }, { rule: "出口\n8.8.8.8 不通" }]) {
      expect(() => recordMemory(db, ctx(), { ...base, ...patch })).toThrow(/脱敏闸命中/);
    }
    expect([db.query("SELECT COUNT(*) AS n FROM memories").get(), memEvents().length]).toEqual([{ n: 0 }, 0]);
  });

  test("脱敏一覆盖所有调用方给的文本：project / 锚点 / head / actor 等元数据也拒（metadata-secrets）", () => {
    const token = "ghp_" + "a".repeat(30);
    const base = { ...PIT, taskId: undefined, head: undefined, specRev: undefined };
    for (const patch of [{ project: token }, { featureId: token }, { nodeKey: token }, { taskId: token, head: "abc1234", specRev: 1 }, { head: token }, { family: undefined, sourceNote: token }]) {
      expect(() => recordMemory(db, ctx(), { ...base, ...patch })).toThrow(/脱敏闸命中/);
    }
    expect(() => recordMemory(db, ctx(token), base)).toThrow(/拒绝写入：actor/);
    expect([db.query("SELECT COUNT(*) AS n FROM memories").get(), db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'memory'").get()]).toEqual([{ n: 0 }, { n: 0 }]);
  });

  test("任何 IP 都拒，含各种压缩位置的 IPv6（ipv6-gap）；代码里的 `::`、时间、MAC 不误伤", () => {
    // 拼接表示，免得测试源码本身含完整地址
    const v6 = [
      ["", "", "1"], ["2001", "", "1"], ["fe80", "", "1ff", "fe23", "4567", "890a"], ["2001", "db8", "", ""], ["", "", "ffff", "a01"],
      "2001 db8 85a3 0 0 8a2e 370 7334".split(" "),
    ].map((xs) => xs.join(":"));
    for (const addr of [...v6, `${v6[1]}:`, `[${v6[0]}]:8080`, `host:${v6[3]}1`]) {
      expect(() => recordMemory(db, ctx(), { ...PIT, rule: `connect to ${addr}` })).toThrow(/拒绝写入：rule/);
    }
    for (const rule of ["用 Vec::new 而不是 vec![]", "在 12:30:45 之后重试", "MAC aa:bb:cc:dd:ee:ff 不算", "C++ 的 :: 作用域", "std::vector<T>"]) {
      expect(recordMemory(db, ctx(), { ...PIT, rule }).memory.visibility).toBe("team");
    }
  });

  test("脱敏二（内部内容：feature / 节点标题、peer 名、调用方给的词）：照写但降为 home", () => {
    db.prepare("INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes) VALUES ('ab12-fx', 1, 'initial', 'pm', 1, ?)").run(
      JSON.stringify([{ key: "N1", oneLine: "widget 表加 CAS 写" }]),
    );
    db.prepare("UPDATE features SET currentVersion = 1 WHERE id = 'ab12-fx'").run();
    const plain = recordMemory(db, ctx(), PIT);
    expect([plain.memory.visibility, plain.homeReason]).toEqual(["team", null]);
    expect(recordMemory(db, ctx(), { ...PIT, rule: "改 gadget 改版 时先建事务" }).memory.visibility).toBe("home");
    const node = recordMemory(db, ctx(), { ...PIT, symptom: "widget 表加 CAS 写 那张卡读到跳号" });
    expect(node.memory.visibility).toBe("home");
    expect(node.homeReason).toMatch(/内部名字/);
    expect(recordMemory(db, ctx(), { ...PIT, title: "找 shawn-mini 借机器时", internalTerms: ["shawn-mini"] }).memory.visibility).toBe("home");
  });

  test("决定索引行：id 由来源事件定，同内容重放幂等（不再追加事件），内容不同报 dedup_mismatch；不占本机记忆序号", () => {
    const dec: MemoryInput = { project: P, kind: "decision", title: "台账只追加", body: "owner：不改历史", via: "decision_index", authorRole: "system", decisionOf: { origin: "cd34", originSeq: 7 } };
    const a = recordMemory(db, ctx("scheduler"), dec);
    expect([a.memory.id, a.duplicate, a.event?.kind]).toEqual(["cd34-d7", false, "memory"]);
    const b = recordMemory(db, ctx("scheduler", 2_000), dec);
    expect([b.memory.id, b.duplicate, b.event]).toEqual(["cd34-d7", true, null]);
    expect(() => recordMemory(db, ctx("scheduler"), { ...dec, body: "改了" })).toThrow(/digest/);
    expect(() => recordMemory(db, ctx(), { ...dec, decisionOf: undefined })).toThrow(/decisionOf/);
    expect(recordMemory(db, ctx(), { ...PIT }).memory.id).toBe("ab12-m1");
    const d7 = recordMemory(db, ctx("scheduler"), { ...dec, decisionOf: { origin: "ab12", originSeq: 1 } });
    expect(d7.memory.id).toBe("ab12-d1");
    expect(memEvents().length).toBe(3);
  });

  test("取不到本机前缀时拒绝（不拿随机值当全局 id）", () => {
    closeLedger(":memory:");
    db = openLedger(":memory:");
    createTask(db, { actor: "owner", now: 1 }, { project: P, id: "N2", title: "N2", kind: "code" });
    // 测试进程的 instance-id 在临时状态目录里，前缀照样取得到；这里换个取不到的库：删表模拟
    db.exec("DROP TABLE ledger_instance");
    expect(() => recordMemory(db, ctx(), PIT)).toThrow(/前缀/);
  });
});

describe("markMemory", () => {
  test("每条 mark 追加一条 memory 事件（data 带 mark）；状态随折叠走：§4.4 全流程含回滚再上线", () => {
    const id = recordMemory(db, ctx(), PIT).memory.id;
    const sm = (actor: string, now: number, input: Omit<Parameters<typeof markMemory>[2], "memoryId">) => markMemory(db, ctx(actor, now), { memoryId: id, ...input });
    expect(sm("agent-pm", 2_000, { mark: "link_fix", taskId: "N1f" }).event).toMatchObject({ kind: "memory", target: "N2", data: { memoryId: id, kind: "pitfall", mark: "link_fix" } });
    expect(memoryState(db, id)?.status).toBe("fixing");
    sm("scheduler", 3_000, { mark: "fixed", taskId: "N1f", source: { origin: "ab12", originSeq: 812 }, dedupKey: `auto:fixed:${id}:N1f:ab12/812` });
    expect(memoryState(db, id)?.status).toBe("fixed");
    sm("scheduler", 4_000, { mark: "reopen", taskId: "N1f", source: { origin: "ab12", originSeq: 900 }, dedupKey: `auto:reopen:${id}:N1f:ab12/900` });
    expect(memoryState(db, id)).toMatchObject({ status: "open", fixTask: "N1f" });
    sm("scheduler", 5_000, { mark: "fixed", taskId: "N1f", source: { origin: "ab12", originSeq: 950 }, dedupKey: `auto:fixed:${id}:N1f:ab12/950` });
    expect(memoryState(db, id)?.status).toBe("fixed");
    expect(listMarks(db, id).map((m) => [m.originSeq, m.mark])).toEqual([[1, "link_fix"], [2, "fixed"], [3, "reopen"], [4, "fixed"]]);
    expect(memEvents().length).toBe(5);
  });

  test("dedupKey：同一件事两端观察只记一条（duplicate、不再追加事件）；被别的动作用过报 dedup_mismatch", () => {
    const id = recordMemory(db, ctx(), PIT).memory.id;
    markMemory(db, ctx(), { memoryId: id, mark: "link_fix", taskId: "N1f" });
    const input = { memoryId: id, mark: "fixed" as const, taskId: "N1f", source: { origin: "ab12", originSeq: 812 }, dedupKey: `auto:fixed:${id}:N1f:ab12/812` };
    expect(markMemory(db, ctx("scheduler"), input).duplicate).toBe(false);
    const again = markMemory(db, ctx("scheduler", 9_000), input);
    expect([again.duplicate, again.event, again.mark.ts]).toEqual([true, null, 1_000]);
    expect(() => markMemory(db, ctx("scheduler"), { ...input, mark: "reopen" })).toThrow(/dedupKey/);
    expect(memEvents().length).toBe(3);
  });

  test("校验：dispute / retract 要 reason、修复类只给 fixable 坑、supersede 要指向已有别的记忆、自动 mark 要 source、reason 过脱敏闸", () => {
    const id = recordMemory(db, ctx(), PIT).memory.id;
    const rule = recordMemory(db, ctx(), { ...PIT, fixable: false }).memory.id;
    const bad = (input: Parameters<typeof markMemory>[2], re: RegExp) => expect(() => markMemory(db, ctx(), input)).toThrow(re);
    bad({ memoryId: id, mark: "dispute" }, /reason 必填/);
    bad({ memoryId: id, mark: "retract", reason: "x".repeat(301) }, /reason 超过/);
    bad({ memoryId: rule, mark: "link_fix", taskId: "N1f" }, /fixable/);
    bad({ memoryId: id, mark: "fixed" }, /taskId/);
    bad({ memoryId: id, mark: "supersede" }, /by/);
    bad({ memoryId: id, mark: "supersede", by: id }, /自己/);
    bad({ memoryId: id, mark: "supersede", by: "ab12-m99" }, /没有记忆/);
    bad({ memoryId: id, mark: "confirm", dedupKey: "auto:x" }, /source/);
    bad({ memoryId: "ab12-m99", mark: "confirm" }, /没有记忆/);
    bad({ memoryId: id, mark: "dispute", reason: "见 /Users/someone/notes" }, /脱敏闸/);
    const token = "ghp_" + "a".repeat(30);
    bad({ memoryId: id, mark: "confirm", dedupKey: token, source: { seq: 1 } }, /拒绝写入：dedupKey/);
    bad({ memoryId: id, mark: "link_fix", taskId: token }, /拒绝写入：taskId/);
    expect(() => markMemory(db, ctx(token), { memoryId: id, mark: "confirm" })).toThrow(/拒绝写入：actor/);
    expect(memEvents().length).toBe(2);
  });

  test("team 记忆上 reason 含内部名字的 mark 拒写（internal-mark）；home 记忆照写", () => {
    const team = recordMemory(db, ctx(), PIT).memory.id;
    const home = recordMemory(db, ctx(), { ...PIT, rule: "改 gadget 改版 时先建事务" }).memory;
    expect(home.visibility).toBe("home");
    expect(() => markMemory(db, ctx(), { memoryId: team, mark: "dispute", reason: "见 gadget 改版 的讨论" })).toThrow(/内部名字/);
    expect(() => markMemory(db, ctx(), { memoryId: team, mark: "retract", reason: "shawn-mini 上复现不了", internalTerms: ["shawn-mini"] })).toThrow(/内部名字/);
    expect(markMemory(db, ctx(), { memoryId: home.id, mark: "dispute", reason: "见 gadget 改版 的讨论" }).mark.reason).toBe("见 gadget 改版 的讨论");
    expect(listMarks(db, team)).toEqual([]);
    expect(memEvents().length).toBe(3);
  });

  test("观察乱序：再上线后晚到的旧回滚不重开（来源事件定先后）；回滚后 unlink_fix 清关联", () => {
    const id = recordMemory(db, ctx(), PIT).memory.id;
    const sm = (mark: "link_fix" | "fixed" | "reopen" | "unlink_fix", now: number, originSeq?: number) =>
      markMemory(db, ctx("scheduler", now), { memoryId: id, mark, taskId: "N1f", source: originSeq ? { origin: "ab12", originSeq } : null });
    sm("link_fix", 2);
    sm("fixed", 10, 812);
    sm("fixed", 20, 950);
    sm("reopen", 30, 900);
    expect(memoryState(db, id)).toMatchObject({ status: "fixed", fixTask: "N1f" });
    sm("reopen", 40, 960);
    sm("unlink_fix", 50);
    expect(memoryState(db, id)).toMatchObject({ status: "open", fixTask: null });
    sm("fixed", 60, 970);
    expect(memoryState(db, id)?.status).toBe("open");
  });

  test("状态对不上照记不拒（折叠决定生效与否）：open 上 fixed 记一行但仍 open；retract 后的 mark 记录不生效", () => {
    const id = recordMemory(db, ctx(), PIT).memory.id;
    markMemory(db, ctx(), { memoryId: id, mark: "fixed", taskId: "N1f" });
    expect(memoryState(db, id)?.status).toBe("open");
    markMemory(db, ctx("agent-pm", 2_000), { memoryId: id, mark: "retract", reason: "记错了" });
    markMemory(db, ctx("agent-pm", 3_000), { memoryId: id, mark: "confirm" });
    expect(memoryState(db, id)?.status).toBe("retracted");
    expect(listMarks(db, id).length).toBe(3);
    expect(getMemory(db, id)?.title).toBe(PIT.title);
  });
});
