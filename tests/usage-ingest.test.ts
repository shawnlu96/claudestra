/**
 * token 账导入（src/lib/usage-ingest.ts + usage-store / usage-query）：去重、切轮、增量幂等、跨文件副本、归属、30 天清理。
 * fixture 用 Claude Code 会话记录的真实形状（一次响应拆成多行、channel 消息 isMeta、忙时的 queued_command 附件）。
 */
import { describe, test, expect } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rollupJsonl } from "../src/lib/jsonl-cost.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { ingestLocked, ingestUsage, type IngestOptions } from "../src/lib/usage-ingest.js";
import { turnsFor, usageSummary } from "../src/lib/usage-query.js";
import { openUsageDb, retentionCutoff } from "../src/lib/usage-store.js";

const H = 3600_000;
const NOW = Date.now();
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
const human = (text: string, at: number) => ({ type: "user", uuid: `h${++seq}`, timestamp: iso(at), origin: { kind: "human" }, message: { role: "user", content: text } });
const chan = (text: string, at: number, id: string) => ({
  type: "user", uuid: `c${++seq}`, isMeta: true, origin: { kind: "channel" }, timestamp: iso(at),
  message: { role: "user", content: `<channel source="claudestra" message_id="${id}">\n${text}\n</channel>` },
});
const queued = (text: string, at: number, id: string) => ({
  type: "attachment", uuid: `q${++seq}`, timestamp: iso(at),
  attachment: { type: "queued_command", commandMode: "prompt", prompt: `<channel source="claudestra" message_id="${id}">\n${text}\n</channel>` },
});
const userBlocks = (prefix: string, at: number, content: object[]) => ({ type: "user", uuid: `${prefix}${++seq}`, timestamp: iso(at), message: { role: "user", content } });
const toolResult = (at: number, text = "ok") => userBlocks("r", at, [{ type: "tool_result", tool_use_id: "x", content: text }]);
const interrupted = (at: number) => userBlocks("i", at, [{ type: "text", text: "[Request interrupted by user for tool use]" }]);

/** 一次 API 响应：每个内容块一行、各带一份 usage；最后一行的 output 才完整（流式先写的行偏小） */
function resp(id: string, at: number, ctx: number, out: number, tools: string[] = []): object[] {
  const blocks: object[] = [{ type: "thinking", thinking: "" }, { type: "text", text: "嗯" }, ...tools.map((n, k) => ({ type: "tool_use", id: `toolu_${id}_${k}`, name: n }))];
  return blocks.map((b, k) => ({
    type: "assistant", uuid: `a${id}_${k}`, timestamp: iso(at), requestId: `req_${id}`,
    message: {
      id: `msg_${id}`, model: "claude-opus-5-5", content: [b],
      usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: ctx - 102, output_tokens: k === blocks.length - 1 ? out : 1 },
    },
  }));
}

function fx() {
  const root = mkdtempSync(join(tmpdir(), "usage-ingest-"));
  const projects = join(root, "projects");
  const archive = join(root, "archive");
  mkdirSync(join(projects, "-work"), { recursive: true });
  mkdirSync(archive, { recursive: true });
  const db = openUsageDb(":memory:");
  const registry = [{ name: "agent-a", sessionId: S1, cwd: join(root, "nope") }];
  const opts = (now = NOW, extra: IngestOptions = {}): IngestOptions => ({ projectsRoot: projects, archiveRoot: archive, codexRoot: null, registry, now, ...extra });
  const run = (now = NOW, chunkBytes?: number, extra: IngestOptions = {}) => ingestUsage(db, opts(now, { chunkBytes, ...extra }));
  const write = (p: string, recs: object[]) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const append = (p: string, recs: object[]) => appendFileSync(p, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, projects, archive, db, opts, run, write, append, main: join(projects, "-work", `${S1}.jsonl`) };
}

const T = NOW - 2 * H;

describe("去重与数字", () => {
  test("一次响应拆成多行只算一次，output 取完整那行；与 cost 的 rollupJsonl 一致", async () => {
    const f = fx();
    f.write(f.main, [human("做 T83", T), ...resp("1", T + 1000, 5000, 300, ["Bash"]), toolResult(T + 2000), ...resp("2", T + 3000, 6000, 40)]);
    f.run();
    const [t] = turnsFor(f.db, "agent-a");
    expect(t).toMatchObject({ calls: 2, input: 4, cacheCreation: 200, cacheRead: 5000 - 102 + 6000 - 102, output: 340, contextSeen: 6000, toolCalls: 1, tools: { Bash: 1 } });
    const [cost] = await rollupJsonl(f.main);
    const [sum] = usageSummary(f.db, 0);
    expect({ input: sum.input, cacheCreation: sum.cacheCreation, cacheRead: sum.cacheRead, output: sum.output, calls: sum.calls })
      .toEqual({ input: cost.input, cacheCreation: cost.cacheCreation, cacheRead: cost.cacheRead, output: cost.output, calls: cost.requests });
  });

  test("重复导入不翻倍；同一会话的归档副本不重复计，副本早于原件读到也一样", () => {
    const f = fx();
    f.write(f.main, [human("做", T), ...resp("1", T + 1000, 5000, 300)]);
    copyFileSync(f.main, (mkdirSync(join(f.archive, "agent-a"), { recursive: true }), join(f.archive, "agent-a", `${S1}.jsonl`)));
    f.run();
    f.run();
    const rows = usageSummary(f.db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "agent-a", calls: 1, output: 300 });
    expect(usageSummary(f.db)[0]).toMatchObject({ agent: "agent-a", calls: 1, output: 300 });
  });
});

describe("切轮", () => {
  test("两条外来输入各一轮；工具结果不切；channel 消息切", () => {
    const f = fx();
    f.write(f.main, [
      human("第一件", T), ...resp("1", T + 1, 1000, 10, ["Read"]), toolResult(T + 2), ...resp("2", T + 3, 1500, 10),
      chan("第二件", T + 10_000, "m1"), ...resp("3", T + 10_001, 2000, 10),
    ]);
    f.run();
    const turns = turnsFor(f.db, "agent-a");
    expect(turns.map((t) => [t.kind, t.trigger, t.calls])).toEqual([["human", "第一件", 2], ["channel", "第二件", 1]]);
  });

  test("忙时插进本轮的 channel 消息（queued_command）另起一轮", () => {
    const f = fx();
    f.write(f.main, [human("长任务", T), ...resp("1", T + 1, 1000, 10, ["Bash"]), toolResult(T + 2), queued("插一句", T + 3, "m9"), ...resp("2", T + 4, 1200, 10)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => [t.trigger, t.calls])).toEqual([["长任务", 1], ["插一句", 1]]);
  });

  test("中断：打断标记归被打断的那一轮，之后的新输入另起一轮", () => {
    const f = fx();
    f.write(f.main, [
      human("跑测试", T), ...resp("1", T + 1, 1000, 10, ["Bash"]), toolResult(T + 2, "interrupted"), interrupted(T + 3),
      human("先停，改看日志", T + 4), ...resp("2", T + 5, 1100, 10),
    ]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => [t.trigger, t.calls])).toEqual([["跑测试", 1], ["先停，改看日志", 1]]);
  });

  test("同一条 channel 消息既进队列附件又落 user 记录：算一轮", () => {
    const f = fx();
    f.write(f.main, [queued("同一条", T, "m5"), ...resp("1", T + 1, 1000, 10), chan("同一条", T + 2, "m5"), ...resp("2", T + 3, 1000, 10)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => t.calls)).toEqual([2]);
  });

  test("文件从一轮中间开始（fork 副本）：开头那段单独一轮", () => {
    const f = fx();
    f.write(f.main, [...resp("1", T, 1000, 10), human("新", T + 5), ...resp("2", T + 6, 1000, 10)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => t.kind)).toEqual(["continued", "human"]);
  });
});

describe("增量导入", () => {
  test("追加的行接着上次的轮；文件尾的半行等写完再读；小块读取跨行拼接", () => {
    const f = fx();
    f.write(f.main, [human("长".repeat(3000), T), ...resp("1", T + 1, 1000, 10, ["Bash"])]);
    f.run(NOW, 1024);
    const half = JSON.stringify(toolResult(T + 2));
    appendFileSync(f.main, half.slice(0, 20));
    f.run(NOW, 1024);
    appendFileSync(f.main, half.slice(20) + "\n");
    f.append(f.main, resp("2", T + 3, 2000, 20));
    f.run(NOW, 1024);
    f.run(NOW, 1024);
    const turns = turnsFor(f.db, "agent-a");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ calls: 2, output: 30, contextSeen: 2000 });
  });

  test("文件被重写得更短：从头重读，数字不变", () => {
    const f = fx();
    f.write(f.main, [human("a", T), ...resp("1", T + 1, 1000, 10), ...resp("2", T + 2, 1000, 10)]);
    f.run();
    f.write(f.main, [human("a", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    expect(usageSummary(f.db, 0)[0].calls).toBe(2);
  });
});

describe("归属", () => {
  test("认不出主人的记 unowned；子 agent 记到父会话主人并标 sidechain", () => {
    const f = fx();
    f.write(join(f.projects, "-other", `${S2}.jsonl`), [human("终端里开的", T), ...resp("9", T + 1, 1000, 10)]);
    f.write(f.main, [human("主会话", T), ...resp("1", T + 1, 1000, 10)]);
    f.write(join(f.projects, "-work", S1, "subagents", "agent-x1.jsonl"), [human("子任务 prompt", T + 2), ...resp("s1", T + 3, 800, 5)]);
    f.run();
    const agents = Object.fromEntries(usageSummary(f.db, 0).map((r) => [r.agent, r]));
    expect(agents.unowned.calls).toBe(1);
    expect(agents["agent-a"]).toMatchObject({ calls: 2, sidechainTokens: 805 });
    expect(turnsFor(f.db, "agent-a").find((t) => t.sidechain)?.kind).toBe("subagent");
  });

  test("先记成 unowned，之后归档目录认出主人：改过去，daily 跟着重算", () => {
    const f = fx();
    const p = join(f.projects, "-other", `${S2}.jsonl`);
    f.write(p, [human("被 kill 的执行者", T), ...resp("9", T + 1, 1000, 10)]);
    f.run();
    expect(usageSummary(f.db)[0].agent).toBe("unowned");
    mkdirSync(join(f.archive, "agent-t9"), { recursive: true });
    copyFileSync(p, join(f.archive, "agent-t9", `${S2}.jsonl`));
    f.run();
    expect(usageSummary(f.db).map((r) => [r.agent, r.calls])).toEqual([["agent-t9", 1]]);
  });
});

describe("30 天保留", () => {
  test("明细清掉、daily 永久；清理后再读到副本不重复计入", () => {
    const f = fx();
    f.write(f.main, [human("老活", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    const later = NOW + 40 * 24 * H;
    const tick = f.run(later); // 10 分钟一趟的增量不清理
    expect(tick.pruned).toBe(0);
    expect(turnsFor(f.db, "agent-a")).toHaveLength(1);
    const r = f.run(later, undefined, { prune: true });
    expect(r.pruned).toBe(1);
    expect(turnsFor(f.db, "agent-a")).toHaveLength(0);
    expect(usageSummary(f.db)).toMatchObject([{ agent: "agent-a", calls: 1, output: 10 }]);
    mkdirSync(join(f.archive, "agent-a"), { recursive: true });
    const copy = join(f.archive, "agent-a", `${S1}.jsonl`);
    copyFileSync(f.main, copy);
    utimesSync(copy, later / 1000, later / 1000); // kill 时才拷的快照：文件是新的，里面的记录是老的
    const again = f.run(later, undefined, { prune: true });
    expect(again.read).toBe(1);
    expect(usageSummary(f.db)).toMatchObject([{ agent: "agent-a", calls: 1, output: 10 }]);
  });

  test("保留期之前的记录导入时直接跳过", () => {
    const f = fx();
    const old = retentionCutoff(NOW) - H;
    f.write(f.main, [human("很久以前", old), ...resp("1", old + 1, 1000, 10), human("今天", T), ...resp("2", T + 1, 1000, 10)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => t.trigger)).toEqual(["今天"]);
    expect(usageSummary(f.db)[0].calls).toBe(1);
  });
});

describe("导入锁", () => {
  test("别的进程拿着锁：这趟不导、返回 null；锁放了再导，导完把锁还掉", async () => {
    const f = fx();
    f.write(f.main, [human("一", T), ...resp("1", T + 1, 1000, 10)]);
    const lockPath = join(f.root, "usage.sqlite.ingest.lock");
    const other = await acquireLock(lockPath, 0);
    expect(await ingestLocked(f.db, lockPath, f.opts(), 0)).toBeNull();
    expect(usageSummary(f.db)).toHaveLength(0);
    other!.release();
    expect((await ingestLocked(f.db, lockPath, f.opts(), 0))?.read).toBe(1);
    expect(usageSummary(f.db)).toMatchObject([{ agent: "agent-a", calls: 1, output: 10 }]);
    expect(await acquireLock(lockPath, 0)).not.toBeNull(); // 导完锁已释放
  });

  test("导到一半失锁就停；没读的文件下一趟接着读，数字不重不漏", () => {
    const f = fx();
    f.write(f.main, [human("一", T), ...resp("1", T + 1, 1000, 10)]);
    f.write(join(f.projects, "-work", `${S2}.jsonl`), [human("二", T), ...resp("2", T + 1, 1000, 20)]);
    let n = 0;
    const first = f.run(NOW, undefined, { keepAlive: () => n++ < 1 });
    expect(first.read).toBe(1);
    const rest = f.run();
    expect(rest.read).toBe(1);
    expect(usageSummary(f.db).reduce((s, r) => s + r.output, 0)).toBe(30);
  });
});

// ── 第 1 轮审查（T83-r1）的回归：每条对应一个 P1 / P2，改之前都是红的 ──

describe("r1 回归：切轮", () => {
  test("P1-1 没有 origin 的老格式 channel 消息（只有 isMeta）也各开一轮", () => {
    const f = fx();
    const old = (text: string, at: number, id: string) => {
      const { origin: _o, ...r } = chan(text, at, id);
      return r;
    };
    f.write(f.main, [old("第一条", T, "m1"), ...resp("1", T + 1, 1000, 10), old("第二条", T + 2000, "m2"), ...resp("2", T + 2001, 1000, 20)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => [t.kind, t.trigger, t.calls])).toEqual([["channel", "第一条", 1], ["channel", "第二条", 1]]);
  });

  test("P1-2 同一张卡片上的两次选择共用 message_id，正文不同：两轮", () => {
    const f = fx();
    f.write(f.main, [chan("[select:menu:one]", T, "card1"), ...resp("1", T + 1, 1000, 10), chan("[select:menu:two]", T + 2000, "card1"), ...resp("2", T + 2001, 1000, 20)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => [t.trigger, t.calls])).toEqual([["[select:menu:one]", 1], ["[select:menu:two]", 1]]);
  });

  test("P1-2 两条输入连条目 uuid 都撞了，正文不同照样两轮", () => {
    const f = fx();
    const same = (text: string, at: number) => ({ ...chan(text, at, "card1"), uuid: "dup" });
    f.write(f.main, [same("[select:menu:one]", T), ...resp("1", T + 1, 1000, 10), same("[select:menu:two]", T + 2000), ...resp("2", T + 2001, 1000, 20)]);
    f.run();
    expect(turnsFor(f.db, "agent-a").map((t) => [t.trigger, t.calls])).toEqual([["[select:menu:one]", 1], ["[select:menu:two]", 1]]);
  });
});

describe("r1 回归：文件被换掉 / 截断后又长回来", () => {
  const byTrigger = (f: ReturnType<typeof fx>) => turnsFor(f.db, "agent-a").map((t) => [t.trigger, t.calls]);

  test("P1-3 原路径换成等长的新文件：新文件的调用照样入库", () => {
    const f = fx();
    f.write(f.main, [human("first", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    renameSync(f.main, join(f.root, "rotated.jsonl"));
    f.write(f.main, [human("other", T + 5000), ...resp("2", T + 5001, 1000, 10)]);
    f.run();
    expect(byTrigger(f)).toEqual([["first", 1], ["other", 1]]);
  });

  test("P1-3 原路径换成更长的新文件：从头读，不从旧偏移切进半行", () => {
    const f = fx();
    f.write(f.main, [human("first", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    renameSync(f.main, join(f.root, "rotated.jsonl"));
    f.write(f.main, [human(`second ${"z".repeat(2000)}`, T + 5000), ...resp("2", T + 5001, 1000, 10)]);
    f.run();
    expect(byTrigger(f).map(([t, n]) => [String(t).slice(0, 6), n])).toEqual([["first", 1], ["second", 1]]);
  });

  test("P1-3 同一个 inode 截断重写、又长过旧偏移：认出来从头读；再跑一趟不翻倍", () => {
    const f = fx();
    f.write(f.main, [human("first", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    writeFileSync(f.main, [human(`second ${"z".repeat(2000)}`, T + 5000), ...resp("2", T + 5001, 1000, 10)].map((r) => JSON.stringify(r)).join("\n") + "\n");
    f.run();
    f.run();
    expect(byTrigger(f).map(([t, n]) => [String(t).slice(0, 6), n])).toEqual([["first", 1], ["second", 1]]);
    expect(usageSummary(f.db, 0)[0]).toMatchObject({ calls: 2, output: 20 });
  });
});

describe("r1 回归：数字与脱敏", () => {
  test("P1-4 AWS secret、引号里带空格的密码不落库", () => {
    const f = fx();
    const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // AWS 文档里的示例值
    f.write(f.main, [human(`请使用 AWS 密钥 ${key}`, T), ...resp("1", T + 1, 1000, 10), human('password="alpha beta gamma"', T + 2000), ...resp("2", T + 2001, 1000, 10)]);
    f.run();
    const stored = (f.db.prepare("SELECT trigger FROM turns").all() as { trigger: string }[]).map((r) => r.trigger).join("\n");
    expect(stored).not.toContain("EXAMPLEKEY");
    expect(stored).not.toContain("beta");
    expect(stored).toContain("[redacted]");
  });

  test("P1-5 一次响应跨午夜：summary 今天与 cost --today 一致（按最后一行的时间）；分两趟读到也把昨天那条挪走", async () => {
    const f = fx();
    const day = new Date(NOW).setHours(0, 0, 0, 0);
    const [first, last] = [resp("x", day - 1000, 1000, 1), resp("x", day + 1000, 1000, 100)].map((r) => r[r.length - 1]);
    f.write(f.main, [human("跨夜", day - 2000), first]);
    f.run();
    expect(usageSummary(f.db, day)).toHaveLength(0);
    f.append(f.main, [last]);
    f.run();
    const [cost] = await rollupJsonl(f.main, day);
    const [sum] = usageSummary(f.db, day);
    expect({ calls: sum.calls, output: sum.output }).toEqual({ calls: cost.requests, output: cost.output });
    expect(turnsFor(f.db, "agent-a")[0].endedAt).toBe(day + 1000);
    const days = f.db.prepare("SELECT day, calls, output FROM daily").all() as { day: string; calls: number; output: number }[];
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ calls: 1, output: 100 });
  });
});

describe("r1 回归：失锁", () => {
  test("P2-1 失锁后不再清理：明细还在", () => {
    const f = fx();
    f.write(f.main, [human("留着", T), ...resp("1", T + 1, 1000, 10)]);
    f.run();
    const r = f.run(NOW + 40 * 24 * H, undefined, { prune: true, keepAlive: () => false });
    expect(r).toMatchObject({ pruned: 0, aborted: true });
    expect(turnsFor(f.db, "agent-a")).toHaveLength(1);
  });

  test("P2-1 同一个文件读到一半失锁：后面的块不读了，下一趟接着读完", () => {
    const f = fx();
    f.write(f.main, [human("长文件", T), ...resp("1", T + 1, 1000, 10), ...resp("2", T + 2, 1000, 10), ...resp("3", T + 3, 1000, 10)]);
    let n = 0;
    const r = f.run(NOW, 256, { keepAlive: () => n++ < 2 });
    expect(r.aborted).toBe(true);
    expect(usageSummary(f.db, 0).reduce((s, x) => s + x.calls, 0)).toBeLessThan(3);
    f.run();
    expect(usageSummary(f.db, 0)[0]).toMatchObject({ calls: 3, output: 30 });
  });
});
