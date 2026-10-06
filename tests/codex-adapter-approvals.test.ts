// 自研 Codex 适配器的审批（CX-3）：app-server 的审批 → session/request_permission → 宿主「待你处理」卡，答复按 CX-0 语义回 app-server；
// 拿不到答复（宿主取消 / 超时 / 断开 / session/cancel / 不属于当前回合）一律 cancel，回合不挂起。真 CLI 的对照见 scripts/codex-acp-compare.ts。
import { describe, expect, test } from "bun:test";
import { Approvals, commandOptions } from "../src/lib/acp/codex-adapter/approvals.ts";
import type { PermissionCard } from "../src/lib/acp/permissions.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { harness, type HarnessOpts, type Rec, until } from "./helpers/codex-fake-app.ts";

const AMEND = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["/bin/zsh", "-lc", "echo x > ../out.txt"] } };
const commandApproval = (turnId: string, extra: Rec = {}) => ({
  threadId: "th-1", turnId, itemId: "call_1", startedAtMs: 0, command: "/bin/zsh -lc 'echo x > ../out.txt'", cwd: "/w", reason: "outside",
  commandActions: [{ type: "unknown", command: "echo x > ../out.txt" }], availableDecisions: ["accept", AMEND, "cancel"], ...extra,
});
const never = () => new Promise<string | null>(() => {});

/** 开一轮停在 turn/started，返回宿主的 prompt 结果 promise */
async function running(o: HarnessOpts = {}) {
  const h = harness(o);
  await h.open();
  h.f.on("turn/start", (_p, id) => {
    const turnId = (h.f.turn = h.f.nextTurn());
    h.f.feed({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
    h.f.started(turnId);
    return undefined;
  });
  const done = h.session.prompt("go");
  await until(() => h.statuses().includes("active"), "回合开始");
  return { h, turnId: h.f.turn!, done };
}

describe("审批经授权卡（真宿主 AcpSession 在环）", () => {
  test("允许：卡片标题去 shell 前缀，选项 = 允许 / 拒绝（decline）/ 停下（cancel），不给带策略修订的选项；回 accept，回合照常结束", async () => {
    const cards: PermissionCard[] = [];
    const { h, turnId, done } = await running({ onPermission: async (c) => (cards.push(c), "accept") });
    const r = await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId));
    expect(r.result).toEqual({ decision: "accept" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCallId: "call_1", title: "Codex 请求授权：echo x > ../out.txt", detail: "echo x > ../out.txt", mcp: false });
    expect(cards[0]!.options.map((o) => [o.id, o.style])).toEqual([["accept", "success"], ["decline", "danger"], ["cancel", "danger"]]);
    h.f.complete(turnId);
    expect(await done).toEqual({ kind: "done" });
  });

  test("拒绝：回 decline（命令不跑、回合继续，CX-0 Q0-7），不是 cancel", async () => {
    const { h, turnId, done } = await running({ onPermission: async () => "decline" });
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId))).result).toEqual({ decision: "decline" });
    h.f.complete(turnId);
    expect(await done).toEqual({ kind: "done" });
  });

  test("改文件：允许 / 本会话允许 / 拒绝 / 停下四项，选什么回什么", async () => {
    const cards: PermissionCard[] = [];
    const { h, turnId } = await running({ onPermission: async (c) => (cards.push(c), "acceptForSession") });
    const r = await h.f.request("item/fileChange/requestApproval", { threadId: "th-1", turnId, itemId: "fc_1", reason: "edit", grantRoot: "/w/sub" });
    expect(r.result).toEqual({ decision: "acceptForSession" });
    expect(cards[0]!.title).toBe("Codex 请求授权：改文件，并允许写 /w/sub");
    expect(cards[0]!.options.map((o) => o.id)).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
  });

  test("宿主没答（出卡失败 / owner 取消 → cancelled）：回 cancel", async () => {
    const { h, turnId } = await running({ onPermission: async () => null });
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId))).result).toEqual({ decision: "cancel" });
  });

  test("宿主一直不答：到兜底时限回 cancel，app-server 打断后回合按取消收尾，不挂起", async () => {
    const { h, turnId, done } = await running({ onPermission: never, approvalTimeoutMs: 60 });
    const t0 = Date.now();
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId))).result).toEqual({ decision: "cancel" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    h.f.complete(turnId, "interrupted");
    expect(await done).toEqual({ kind: "cancelled" });
    expect(h.logs.some((l) => l.includes("等宿主答复超时"))).toBe(true);
  });

  test("等卡期间宿主 session/cancel：审批立刻回 cancel（app-server 才停得下来），回合按取消收尾", async () => {
    const { h, turnId, done } = await running({ onPermission: never });
    const pending = h.f.request("item/commandExecution/requestApproval", commandApproval(turnId));
    await until(() => h.out().some((m) => m.method === "session/request_permission"), "出卡");
    void h.session.cancel();
    expect((await pending).result).toEqual({ decision: "cancel" });
    await until(() => h.f.calls("turn/interrupt").length === 1, "turn/interrupt");
    h.f.complete(turnId, "interrupted");
    expect(await done).toEqual({ kind: "cancelled" });
  });

  test("等卡期间宿主断开：审批回 cancel，适配器走收尾", async () => {
    let host: RpcWire | undefined;
    const { h, turnId } = await running({ onPermission: never, wrap: (w) => (host = w) });
    const pending = h.f.request("item/commandExecution/requestApproval", commandApproval(turnId));
    await until(() => h.out().some((m) => m.method === "session/request_permission"), "出卡");
    host!.close("宿主没了");
    expect((await pending).result).toEqual({ decision: "cancel" });
    expect(h.causes[0]?.kind).toBe("stop");
  });

  test("不属于当前在跑回合的审批（旧 turnId / 别的线程）：不出卡，直接 cancel", async () => {
    const cards: PermissionCard[] = [];
    const { h, turnId } = await running({ onPermission: async (c) => (cards.push(c), "accept") });
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval("T-old"))).result).toEqual({ decision: "cancel" });
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId, { threadId: "th-other" }))).result).toEqual({ decision: "cancel" });
    expect(cards).toHaveLength(0);
  });

  test("没有可允许的选项、参数不合格：不出卡，直接 cancel", async () => {
    const cards: PermissionCard[] = [];
    const { h, turnId } = await running({ onPermission: async (c) => (cards.push(c), "accept") });
    expect((await h.f.request("item/commandExecution/requestApproval", commandApproval(turnId, { availableDecisions: ["cancel"] }))).result).toEqual({ decision: "cancel" });
    expect((await h.f.request("item/commandExecution/requestApproval", { threadId: "th-1", turnId })).result).toEqual({ decision: "cancel" });
    expect(cards).toHaveLength(0);
  });

  test("其余反向请求照旧按「不给」答", async () => {
    const { h, turnId } = await running();
    const base = { threadId: "th-1", turnId, itemId: "x" };
    expect((await h.f.request("item/permissions/requestApproval", base)).result).toEqual({ permissions: {}, scope: "turn", strictAutoReview: false });
    expect((await h.f.request("mcpServer/elicitation/request", { threadId: "th-1", turnId, serverName: "s" })).result).toEqual({ action: "cancel", content: null, _meta: null });
    expect((await h.f.request("item/tool/requestUserInput", base)).result).toEqual({ answers: {} });
  });
});

describe("宿主答复的边界（Approvals 单独测）", () => {
  type Handle = (req: unknown) => Promise<Rec>;
  const setup = (request: () => Promise<unknown>) => {
    const handlers = new Map<string, Handle>();
    const app = { handle: (m: string, fn: Handle) => void handlers.set(m, fn) };
    const a = new Approvals({ app: app as never, acp: { request: request as never }, owns: () => true, log: () => {} });
    const ask = () => handlers.get("item/commandExecution/requestApproval")!({ ok: true, params: commandApproval("T1"), corr: {} });
    return { a, ask };
  };

  test("答了不在卡上的 id、回包形状不对、请求失败：都回 cancel", async () => {
    expect(await setup(async () => ({ outcome: { outcome: "selected", optionId: "acceptForSession" } })).ask()).toEqual({ decision: "cancel" });
    expect(await setup(async () => ({ nope: true })).ask()).toEqual({ decision: "cancel" });
    expect(await setup(async () => null).ask()).toEqual({ decision: "cancel" });
    expect(await setup(() => Promise.reject(new Error("boom"))).ask()).toEqual({ decision: "cancel" });
  });

  test("cancelAll 之后宿主才答：只回一次 cancel，迟到的允许不生效", async () => {
    let answer: (v: unknown) => void = () => {};
    const { a, ask } = setup(() => new Promise((r) => (answer = r)));
    const p = ask();
    a.cancelAll();
    answer({ outcome: { outcome: "selected", optionId: "accept" } });
    expect(await p).toEqual({ decision: "cancel" });
  });

  test("commandOptions：只认字符串决定，accept / acceptForSession 列着才给，decline 总给，cancel 列着才给", () => {
    expect(commandOptions(["accept", AMEND, "cancel"])?.map((o) => o.optionId)).toEqual(["accept", "decline", "cancel"]);
    expect(commandOptions(["accept", "acceptForSession", "decline"])?.map((o) => o.optionId)).toEqual(["accept", "acceptForSession", "decline"]);
    expect(commandOptions([AMEND, "cancel"])).toBeNull();
    expect(commandOptions(null)).toBeNull();
  });
});
