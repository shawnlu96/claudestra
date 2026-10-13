/** TEAMVIS8：会话页记录 → 查看器消息（纯模块），取页器的轮询 / 30 秒不回算主场离线 / 不自动重发 / 403 清缓存。 */
import { expect, test } from "bun:test";
import { maskCount, parseSessionRecord, sessionGroups } from "@/features/collab/team-session/team-session-model";
import { centerTaskOf, teamSessionStore, type SessionTiming } from "@/features/collab/team-session/team-session-source";
import { ApiError } from "@/lib/api/client";
import type { FeatureDetail } from "@/lib/api/shared-ledger";
import type { TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";
import { teamSessionFailure, type TeamSessionPoll, type TeamSessionTransport } from "@/lib/api/team-body-session";

const CARD = { featureId: "F1", taskId: "task-1" };
const MASK = "[已遮蔽:疑似密钥]";
const rec = (sourceKey: string, text: string, over: Partial<TeamBodyRecordWire> = {}): TeamBodyRecordWire =>
  ({ ...CARD, kind: "session-page", sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: "d".repeat(64), ...over });
const page = (records: TeamBodyRecordWire[], nextCursor: string | null = null): TeamSessionPoll =>
  ({ requestId: "req", status: "ready", expiresAt: 9e15, homeOnline: true, result: { kind: "page", records, nextCursor } });
const PENDING: TeamSessionPoll = { requestId: "req", status: "pending", expiresAt: 9e15, homeOnline: true, result: null };
const signal = () => new AbortController().signal;

/** 假时钟：sleep 只拨表，不真等；截止定时器不自己响，fire() 手动响（表拨过头由取页器自己看 now） */
function clock(): SessionTiming & { at: number; fire: () => void; armed: number } {
  let pending: (() => void) | null = null;
  const c = { at: 1000, armed: 0, pollMs: 1500, waitMs: 30_000, now: () => c.at, sleep: async (ms: number) => { c.at += ms; },
    deadline: (_ms: number, fire: () => void) => { pending = fire; c.armed++; return () => { pending = null; c.armed--; }; },
    fire: () => pending?.() };
  return c;
}
function fake(answers: { request?: () => Promise<never>; polls: (() => TeamSessionPoll | Promise<TeamSessionPoll>)[] }) {
  const calls = { request: [] as (string | null)[], poll: 0 };
  const transport: TeamSessionTransport = {
    request: async (_f, _t, cursor) => { calls.request.push(cursor); if (answers.request) await answers.request(); return { requestId: "req", expiresAt: 9e15 }; },
    poll: async () => { const next = answers.polls[Math.min(calls.poll, answers.polls.length - 1)]!; calls.poll++; return next(); },
  };
  const time = clock();
  const store = teamSessionStore(() => transport, async () => ({ tasks: [] }) as unknown as FeatureDetail, () => time);
  return { store, calls, time };
}
const fail = (status: number, code?: string) => () => { throw new ApiError("fake", status, code ? { code } : {}); };

test("记录正文拆成角色 / 文字 / 工具，顺序、角色、工具名和主场一致", () => {
  const m = parseSessionRecord(rec("sess-a:12", "[助手]\n先跑一遍测试\n\n再看结果\n[工具]\nBash: bun test tests/x.test.ts\nRead: src/lib/a.ts\nmcp__claudestra__reply: 回复用户"));
  expect(m).toMatchObject({ sessionId: "sess-a", seq: 12, role: "assistant", text: "先跑一遍测试\n\n再看结果", masked: 0 });
  expect(m.tools.map((t) => [t.name, t.summary])).toEqual([["Bash", "bun test tests/x.test.ts"], ["Read", "src/lib/a.ts"], ["mcp__claudestra__reply", "回复用户"]]);
  expect(parseSessionRecord(rec("sess-a:3", "[用户]\n把 [工具] 两个字写进文档")).tools).toEqual([]);
  // 只有工具、没有文字；序号带两位小数（check_inbox 取到的消息）
  const only = parseSessionRecord(rec("sess-a:7.02", "[助手]\n[工具]\nEdit: web/a.tsx"));
  expect(only).toMatchObject({ seq: 7.02, text: "", tools: [{ name: "Edit", summary: "web/a.tsx", masked: 0 }] });
  expect(parseSessionRecord(rec("sess-a:1", "[系统]\n上下文已压缩")).role).toBe("system");
  // 首行不是认得的角色：整段当系统消息，不丢内容
  expect(parseSessionRecord(rec("sess-a:2", "没有角色行的旧记录"))).toMatchObject({ role: "system", text: "没有角色行的旧记录" });
});

test("已遮蔽按占位符个数算：文字段和工具段分开数；整条被换成占位符也认", () => {
  const m = parseSessionRecord(rec("s:1", `[助手]\n配置如下\n\n${MASK}\n\n另一段\n\n${MASK}\n[工具]\nBash: cat .env\n${MASK}\nRead: a.ts`));
  expect(m.masked).toBe(2);
  expect(m.tools.map((t) => [t.name, t.masked])).toEqual([["Bash", 1], ["Read", 0]]);
  expect(parseSessionRecord(rec("s:2", `[用户]\n${MASK}`))).toMatchObject({ role: "user", text: MASK, masked: 1 });
  // 工具段整段被遮蔽：没有工具名，仍是一条工具输出
  expect(parseSessionRecord(rec("s:3", `[助手]\n[工具]\n${MASK}`)).tools).toEqual([{ name: "", summary: MASK, masked: 1 }]);
  expect(maskCount("[已遮蔽：疑似密钥] 和 [已遮蔽:疑似密钥]")).toBe(2);
});

test("分组：会话按主场给页的先后，会话内按序号从旧到新，同一条不重复", () => {
  const groups = sessionGroups([rec("author:9", "[助手]\n九"), rec("author:10", "[用户]\n十"), rec("author:4", "[用户]\n四"),
    rec("reviewer:2", "[助手]\n审"), rec("author:9", "[助手]\n九（后到）")]);
  expect(groups.map((g) => [g.sessionId, g.messages.map((m) => m.seq)])).toEqual([["author", [4, 9, 10]], ["reviewer", [2]]]);
  expect(groups[0]!.messages[1]!.text).toBe("九（后到）");
});

test("团队卡号 → 中心 taskId：按主场卡号对，重名后缀去掉后只有一张才算", () => {
  const tasks = [{ taskId: "t1", sourceTaskId: "R1" }, { taskId: "t2", sourceTaskId: "R2" }, { taskId: "t3", sourceTaskId: "R2" }];
  const d = { tasks } as unknown as FeatureDetail;
  expect(centerTaskOf(d, "R1")).toBe("t1");
  expect(centerTaskOf(d, "R1~2")).toBe("t1");
  expect(centerTaskOf(d, "R2")).toBeNull();
  expect(centerTaskOf(d, "nope")).toBeNull();
});

test("取页：登记一次，轮询到主场回传；翻页把更早的并进缓存，最新一页替换缓存", async () => {
  const first = [rec("a:5", "[用户]\n五"), rec("a:6", "[助手]\n六")];
  const { store, calls } = fake({ polls: [() => PENDING, () => PENDING, () => page(first, "v1:a:5")] });
  const got = await store.fetchPage(CARD, null, signal());
  expect(got).toEqual({ status: "page", pages: { records: first, nextCursor: "v1:a:5" } });
  expect(calls).toEqual({ request: [null], poll: 3 });
  expect(store.peek(CARD)!.records).toHaveLength(2);

  const older = fake({ polls: [() => page(first, "v1:a:5"), () => page([rec("a:3", "[用户]\n三"), rec("a:5", "[用户]\n五（重发）")], null)] });
  await older.store.fetchPage(CARD, null, signal());
  const more = await older.store.fetchPage(CARD, "v1:a:5", signal());
  expect(more.status === "page" && more.pages.records.map((r) => r.sourceKey)).toEqual(["a:6", "a:3", "a:5"]);
  expect(more.status === "page" && more.pages.nextCursor).toBeNull();
  expect(older.calls.request).toEqual([null, "v1:a:5"]);
});

test("复现测试:主场 30 秒内没回 → 主场离线，只登记过一次、不自动重发；再调一次才发第二次", async () => {
  const { store, calls, time } = fake({ polls: [() => PENDING] });
  const started = time.at;
  expect(await store.fetchPage(CARD, null, signal())).toEqual({ status: "home_offline" });
  expect(calls.request).toEqual([null]);
  expect(time.at - started).toBeLessThanOrEqual(30_000);
  expect(time.at - started).toBeGreaterThan(30_000 - 1500);
  expect(store.peek(CARD)).toBeNull();
  // 用户点「重新获取」= 调用方再调一次
  await store.fetchPage(CARD, null, signal());
  expect(calls.request).toEqual([null, null]);
});

test("复现测试:30 秒管整次取页：登记 25 秒 + 轮询 14 秒才回来的页不收、不进缓存，报主场离线，不重发", async () => {
  const time = clock();
  const calls = { request: 0, poll: 0 };
  const transport: TeamSessionTransport = {
    request: async () => { calls.request++; time.at += 25_000; return { requestId: "req", expiresAt: 9e15 }; },
    poll: async () => { calls.poll++; time.at += 14_000; return page([rec("a:1", "[用户]\n一")]); },
  };
  const store = teamSessionStore(() => transport, async () => ({ tasks: [] }) as unknown as FeatureDetail, () => time);
  const started = time.at;
  expect(await store.fetchPage(CARD, null, signal())).toEqual({ status: "home_offline" });
  expect(time.at - started).toBe(39_000);
  expect(calls).toEqual({ request: 1, poll: 1 });
  expect(store.cached()).toBe(0);
  expect(time.armed).toBe(0);
  // 登记本身就拖过 30 秒：不再轮询
  const slow: TeamSessionTransport = { ...transport, request: async () => { calls.request++; time.at += 31_000; return { requestId: "req", expiresAt: 9e15 }; } };
  expect(await teamSessionStore(() => slow, async () => ({ tasks: [] }) as unknown as FeatureDetail, () => time).fetchPage(CARD, null, signal())).toEqual({ status: "home_offline" });
  expect(calls).toEqual({ request: 2, poll: 1 });
  // 迟到的 403 仍然清缓存
  const fresh = clock();
  let mode: "ok" | "late-403" = "ok";
  const denied: TeamSessionTransport = {
    request: async () => ({ requestId: "req", expiresAt: 9e15 }),
    poll: async () => { if (mode === "ok") return page([rec("a:1", "[用户]\n一")]); fresh.at += 40_000; throw new ApiError("fake", 403, { code: "not_member" }); },
  };
  const s2 = teamSessionStore(() => denied, async () => ({ tasks: [] }) as unknown as FeatureDetail, () => fresh);
  await s2.fetchPage(CARD, null, signal());
  mode = "late-403";
  expect(await s2.fetchPage(CARD, "v1:a:1", signal())).toEqual({ status: "not_member" });
  expect(s2.cached()).toBe(0);
});

test("复现测试:截止到点取消在途请求：挂着不回的登记 / 轮询收到取消信号，立刻报主场离线；之后回来的页不进缓存", async () => {
  for (const hang of ["request", "poll"] as const) {
    const time = clock();
    const signals: AbortSignal[] = [];
    let answer: ((p: TeamSessionPoll) => void) | null = null;
    const never = <T>(sig: AbortSignal) => { signals.push(sig); return new Promise<T>((r) => { answer = r as never; }); };
    const transport: TeamSessionTransport = {
      request: (_f, _t, _c, sig) => hang === "request" ? never(sig) : Promise.resolve({ requestId: "req", expiresAt: 9e15 }),
      poll: (_f, _t, _r, sig) => never(sig),
    };
    const store = teamSessionStore(() => transport, async () => ({ tasks: [] }) as unknown as FeatureDetail, () => time);
    const outer = new AbortController();
    const got = store.fetchPage(CARD, null, outer.signal);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    time.fire();
    expect(await got).toEqual({ status: "home_offline" });
    expect(signals[0]!.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
    // 不认取消信号、之后才回来的页：不进缓存
    answer!(page([rec("a:1", "[用户]\n一")]));
    await Promise.resolve();
    expect(store.cached()).toBe(0);
    expect(signals).toHaveLength(1);
  }
  // 调用方中止（收起 / 换卡）：在途请求同样取消，抛中止、不报状态
  const time = clock();
  let seen: AbortSignal | null = null;
  const store = teamSessionStore(() => ({ request: (_f, _t, _c, sig) => { seen = sig; return new Promise(() => {}); }, poll: async () => PENDING }),
    async () => ({ tasks: [] }) as unknown as FeatureDetail, () => time);
  const outer = new AbortController();
  const got = store.fetchPage(CARD, null, outer.signal);
  outer.abort();
  await expect(got).rejects.toThrow();
  expect(seen!.aborted).toBe(true);
  expect(time.armed).toBe(0);
});

test("登记时中心就说主场离线 / 过期 / 未开放 → 对应状态，不轮询；轮询里的 410 → 过期", async () => {
  for (const [status, code, want] of [[503, "home_offline", "home_offline"], [409, "not_open", "not_open"], [404, "unsupported", "unsupported"], [503, "unavailable", "unavailable"]] as const) {
    const f = fake({ request: fail(status, code) as () => Promise<never>, polls: [() => PENDING] });
    expect(await f.store.fetchPage(CARD, null, signal())).toEqual({ status: want });
    expect(f.calls.poll).toBe(0);
  }
  const expired = fake({ polls: [() => PENDING, fail(410, "expired")] });
  expect(await expired.store.fetchPage(CARD, null, signal())).toEqual({ status: "expired" });
  expect(expired.calls.request).toHaveLength(1);
  // 轮询偶发读不到：接着等；到时还读不到按读不到报，不说成主场离线
  const flaky = fake({ polls: [fail(503), () => page([rec("a:1", "[用户]\n一")])] });
  expect((await flaky.store.fetchPage(CARD, null, signal())).status).toBe("page");
  const down = fake({ polls: [fail(503)] });
  expect(await down.store.fetchPage(CARD, null, signal())).toEqual({ status: "unavailable" });
});

test("复现测试:403 清空全部缓存；撤权前发出、之后才回来的页不收；主场回 not_open / gate_refused 丢这张卡的缓存", async () => {
  const other = { featureId: "F1", taskId: "task-2" };
  let mode: "ok" | "403" = "ok";
  let release: (() => void) | null = null;
  const transport: TeamSessionTransport = {
    request: async () => { if (mode === "403") throw new ApiError("fake", 403, { code: "not_member" }); return { requestId: "req", expiresAt: 9e15 }; },
    poll: async (_f, taskId) => {
      if (release === null && taskId === "slow") await new Promise<void>((r) => { release = r; });
      return page([rec(`${taskId}:1`, "[用户]\n一", { taskId })]);
    },
  };
  const store = teamSessionStore(() => transport, async () => ({ tasks: [] }) as unknown as FeatureDetail, clock);
  await store.fetchPage(CARD, null, signal());
  await store.fetchPage(other, null, signal());
  expect(store.cached()).toBe(2);
  const late = store.fetchPage({ featureId: "F1", taskId: "slow" }, null, signal());
  await Promise.resolve();
  mode = "403";
  expect(await store.fetchPage(CARD, null, signal())).toEqual({ status: "not_member" });
  expect(store.cached()).toBe(0);
  expect(store.peek(other)).toBeNull();
  release!();
  expect(await late).toEqual({ status: "not_member" });
  expect(store.cached()).toBe(0);

  for (const code of ["not_open", "gate_refused"] as const) {
    const f = fake({ polls: [() => page([rec("a:1", "[用户]\n一")]), () => ({ ...PENDING, status: "ready", result: { kind: "refused", code } })] });
    await f.store.fetchPage(CARD, null, signal());
    expect(await f.store.fetchPage(CARD, "v1:a:1", signal())).toEqual({ status: code });
    expect(f.store.peek(CARD)).toBeNull();
  }
});

test("复现测试:对卡号时读 feature 详情 403 → not_member，清空全部缓存和卡号对照，在途的页不收；revoke() 同一个口", async () => {
  let deny = false, release: (() => void) | null = null;
  const transport: TeamSessionTransport = {
    request: async () => ({ requestId: "req", expiresAt: 9e15 }),
    poll: async (_f, taskId) => {
      if (taskId === "slow") await new Promise<void>((r) => { release = r; });
      return page([rec(`${taskId}:1`, "[用户]\n一", { featureId: "F1", taskId })]);
    },
  };
  let details = 0;
  const detail = async (featureId: string) => {
    details++;
    if (deny) throw new ApiError("fake", 403, { code: "not_member" });
    return { tasks: [{ taskId: "t1", sourceTaskId: "R1" }, { taskId: `${featureId}-t2`, sourceTaskId: "R2" }] } as unknown as FeatureDetail;
  };
  const store = teamSessionStore(() => transport, detail, clock);
  const f1 = await store.resolve("F1", "R1", signal());
  expect(f1).toEqual({ featureId: "F1", taskId: "t1" });
  await store.fetchPage(f1 as { featureId: string; taskId: string }, null, signal());
  expect(store.cached()).toBe(1);
  const late = store.fetchPage({ featureId: "F1", taskId: "slow" }, null, signal());
  await Promise.resolve();
  deny = true;
  expect(await store.resolve("F2", "R2", signal())).toBe("not_member");
  expect(store.cached()).toBe(0);
  expect(store.peek({ featureId: "F1", taskId: "t1" })).toBeNull();
  release!();
  expect(await late).toEqual({ status: "not_member" });
  expect(store.cached()).toBe(0);
  // 卡号对照也清了：F1/R1 要重新问中心，仍是 403
  const before = details;
  expect(await store.resolve("F1", "R1", signal())).toBe("not_member");
  expect(details).toBe(before + 1);
  // 详情别的失败（离线、404）不是撤权：null，缓存不动
  deny = false;
  await store.fetchPage({ featureId: "F1", taskId: "t1" }, null, signal());
  const down = teamSessionStore(() => transport, async () => { throw new ApiError("fake", 503, {}); }, clock);
  expect(await down.resolve("F1", "R1", signal())).toBeNull();

  // 读正文时中心已答 403（界面传 blocked=not_member）：revoke() 清缓存，在途的页回来不收
  release = null;
  const slow = store.fetchPage({ featureId: "F1", taskId: "slow" }, null, signal());
  await Promise.resolve();
  expect(store.cached()).toBe(1);
  store.revoke();
  expect(store.cached()).toBe(0);
  for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
  release!();
  expect(await slow).toEqual({ status: "not_member" });
  expect(store.cached()).toBe(0);
});

test("别的卡 / 不是会话页的记录不收；失败状态码映射", async () => {
  const f = fake({ polls: [() => page([rec("a:1", "[用户]\n一", { taskId: "task-9" })])] });
  expect(await f.store.fetchPage(CARD, null, signal())).toEqual({ status: "unavailable" });
  expect(f.store.cached()).toBe(0);
  const e = (status: number, code?: string) => teamSessionFailure(new ApiError("x", status, code ? { code } : {}));
  expect([e(403), e(403, "gate_refused"), e(409), e(410), e(404), e(503, "home_offline"), e(503), e(429), teamSessionFailure(new Error("net"))])
    .toEqual(["not_member", "gate_refused", "not_open", "expired", "unsupported", "home_offline", "unavailable", "unavailable", "unavailable"]);
});
