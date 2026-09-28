/**
 * 编排班子的 owner 确认：提案（src/lib/team-proposal.ts）、卡片与确认处理、网页入口（src/bridge/team-confirm.ts）、
 * team up / down 的规划与 status（src/manager/team-up.ts）。核心断言：改 PM 名单只能经 owner 点 bridge 贴出的那张卡片，
 * 伪造的按钮（算不出校验码、贴在别处、点在别的消息上）一律不执行；提案绑内容、过期、只生效一次。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Delivery, Envelope } from "../src/bridge/router.js";
import { canConfirmTeam, handleTeamButton, postProposalCard, teamConfirmRoute, type ConfirmDeps } from "../src/bridge/team-confirm.js";
import { getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import {
  applyPlan, buttonIds, newProposal, parseTeamButton, planRoles, proposalHash, proposalMac, readProposals, refuseReason, updateProposals, type TeamProposal,
} from "../src/lib/team-proposal.js";
import { runLedger } from "../src/manager/ledger.js";
import { planDown, planUp, statusView, SUGGEST_AT } from "../src/manager/team-up.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const NOW = 1_000_000;
const KEY = new Uint8Array(32).fill(7);
const agents = { "agent-pm": { channelId: "c-pm" }, "agent-old": { role: "dispatcher" }, "agent-x": {} };
const noTeam = { pms: [], team: null };
const upDraft = () => {
  const d = planUp({ project: "p", dir: "/w/p", actor: "agent-pm", dispatcher: "new", audit: true, meta: noTeam, agents });
  if ("error" in d) throw new Error(d.error);
  return d;
};
// bridge 读 registry 找提议者的频道（测试的状态目录是临时的，见 tests/preload.ts）
writeFileSync(REGISTRY_PATH, JSON.stringify({ socket: "s", agents: { "agent-pm": { channelId: "c-pm", status: "active" } } }));

describe("planUp / planDown", () => {
  test("默认只配 PM；--dispatcher 新建 <project>-dispatch 并进名单；复用已有 agent 不新建；提案记下提议时的名单与班子", () => {
    const only = planUp({ project: "p", dir: "/w", actor: "agent-pm", audit: true, meta: noTeam, agents });
    expect(only).toMatchObject({ kind: "up", pm: "agent-pm", pms: ["agent-pm"], dispatcher: null, audit: true, base: { pms: [], team: null } });
    expect(upDraft()).toMatchObject({ pms: ["agent-pm", "agent-p-dispatch"], dispatcher: { agent: "agent-p-dispatch", create: true, dir: "/w/p" } });
    const reuse = planUp({ project: "p", dir: "/w", actor: "owner", pm: "pm", dispatcher: "x", audit: false, meta: { pms: ["agent-pm"], team: null }, agents });
    expect(reuse).toMatchObject({ pms: ["agent-pm", "agent-x"], dispatcher: { agent: "agent-x", create: false }, audit: false });
    expect(reuse).toMatchObject({ roles: [{ agent: "agent-pm", role: "pm" }, { agent: "agent-x", role: "dispatcher" }] });
  });

  test("已有调度助理：不带参数保留、--no-dispatcher（none）撤掉、换人时旧的移出名单并撤角色", () => {
    const meta = { pms: ["agent-pm", "agent-old"], team: { dispatcher: "agent-old", audit: true, sinceSeq: 3 } };
    expect(planUp({ project: "p", dir: "/w", actor: "agent-pm", audit: true, meta, agents })).toMatchObject({ pms: ["agent-pm", "agent-old"], dispatcher: { agent: "agent-old" } });
    expect(planUp({ project: "p", dir: "/w", actor: "agent-pm", dispatcher: "none", audit: true, meta, agents })).toMatchObject({ pms: ["agent-pm"], dispatcher: null });
    const swap = planUp({ project: "p", dir: "/w", actor: "agent-pm", dispatcher: "x", audit: true, meta, agents });
    expect(swap).toMatchObject({ pms: ["agent-pm", "agent-x"] });
    expect(swap).toMatchObject({ roles: expect.arrayContaining([{ agent: "agent-old", role: "none" }, { agent: "agent-x", role: "dispatcher" }]) });
    expect(planUp({ project: "p", dir: "/w", actor: "owner", audit: true, meta, agents })).toEqual({ error: "要用 --pm <agent> 指定 PM（在终端里跑时推不出是谁）" });
    expect("error" in planUp({ project: "p", dir: "/w", actor: "agent-nobody", audit: true, meta, agents })).toBe(true);
    expect("error" in planUp({ project: "p", dir: "/w", actor: "agent-pm", dispatcher: "ghost", audit: true, meta, agents })).toBe(true);
  });

  test("planDown：没开班子报错；开了则关路由、调度助理移出名单、班子角色全撤", () => {
    expect(planDown("p", "agent-pm", noTeam, agents)).toEqual({ error: "项目 p 没开编排班子" });
    const withRoles = { "agent-pm": { role: "pm" }, "agent-d": { role: "dispatcher" }, "agent-e": { role: "executor" } };
    const d = planDown("p", "agent-pm", { pms: ["agent-pm", "agent-d", "agent-e"], team: { dispatcher: "agent-d", audit: true, sinceSeq: 1 } }, withRoles);
    expect(d).toMatchObject({ kind: "down", pms: ["agent-pm", "agent-e"], dispatcher: { agent: "agent-d", create: false } });
    expect(d).toMatchObject({ roles: [{ agent: "agent-pm", role: "none" }, { agent: "agent-d", role: "none" }] }); // executor 角色不归班子管
  });

  test("planRoles：名单变了只动要变的；registry 里没有的跳过", () => {
    const base = { pms: ["agent-a", "agent-b"], team: { dispatcher: null, audit: true } };
    const roles = { "agent-a": { role: "pm" }, "agent-b": { role: "pm" }, "agent-c": {} };
    expect(planRoles({ pms: ["agent-a", "agent-c", "agent-ghost"], dispatcher: null, on: true }, base, roles)).toEqual([
      { agent: "agent-b", role: "none" }, { agent: "agent-c", role: "pm" },
    ]);
    expect(planRoles({ pms: ["agent-a"], dispatcher: null, on: false }, base, roles)).toEqual([{ agent: "agent-a", role: "none" }, { agent: "agent-b", role: "none" }]);
  });
});

describe("提案", () => {
  test("按钮 id 带 bridge 密钥的校验码（绑提案与频道）；内容被改、过期、结过案都拒", () => {
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    const mac = proposalMac(KEY, p, "c-pm");
    const ids = buttonIds(p, mac);
    expect(parseTeamButton(ids.ok)).toEqual({ approve: true, id: "0a1b2c3d", mac });
    expect(parseTeamButton(ids.no)?.approve).toBe(false);
    expect(parseTeamButton(`team_ok:0a1b2c3d:${p.hash}`)).toBeNull(); // 老格式（明文哈希）不认
    expect(parseTeamButton("list_agents")).toBeNull();
    expect(proposalMac(KEY, p, "c-other")).not.toBe(mac);
    expect(proposalMac(new Uint8Array(32), p, "c-pm")).not.toBe(mac);
    expect(refuseReason(p, NOW + 1)).toBeNull();
    expect(refuseReason({ ...p, pms: ["agent-evil"] }, NOW + 1)).toContain("被改过");
    expect(refuseReason(p, p.expiresAt + 1)).toContain("过期");
    expect(refuseReason({ ...p, status: "applied" }, NOW)).toContain("已生效");
    expect(refuseReason(undefined, NOW)).toContain("不存在");
    expect(proposalHash(p)).toBe(p.hash);
  });

  test("applyPlan：先 --check 只核对，再建调度助理、写台账，最后按提案设 / 撤角色", () => {
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    const steps = applyPlan(p);
    expect(steps.map((s) => s.slice(0, 4).join(" "))).toEqual([
      "ledger team-apply 0a1b2c3d --check", "create agent-p-dispatch /w/p --project", "ledger team-apply 0a1b2c3d", "team-link agent-pm --role pm",
    ]);
    const downMeta = { pms: ["agent-pm", "agent-d"], team: { dispatcher: "agent-d", audit: true, sinceSeq: 1 } };
    const down = newProposal(planDown("p", "agent-pm", downMeta, { "agent-d": { role: "dispatcher" } }) as never, NOW, "0000aaaa");
    expect(applyPlan(down)).toEqual([["ledger", "team-apply", "0000aaaa", "--check"], ["ledger", "team-apply", "0000aaaa"], ["team-link", "agent-d", "--role", "none"]]);
  });
});

/** bridge 贴卡片：deliver 换成假的，返回给定的 Discord 消息 id */
async function post(p: TeamProposal, path: string, messageIds = ["m-card"]): Promise<{ sent: Envelope[]; r: unknown }> {
  const sent: Envelope[] = [];
  const deliver = async (env: Envelope): Promise<Delivery> => (sent.push(env), { envelope: env, outcome: { kind: "sent", discordMessageIds: messageIds } });
  const r = await postProposalCard(p.id, deliver, { path, key: KEY, now: () => NOW + 1 });
  return { sent, r };
}

describe("贴卡片与点击", () => {
  let path: string;
  let calls: string[][];
  let failAt: number;
  let p: TeamProposal;
  let db: Database;
  const at = { chatId: "c-pm", messageId: "m-card" };
  const okId = () => buttonIds(p, proposalMac(KEY, p, "c-pm")).ok;
  // ledger 子命令真跑（owner 身份 = bridge 经 runManager 调用时的身份），其余命令只记下来
  const deps = (): ConfirmDeps => ({
    path, key: KEY, now: () => NOW + 10,
    runManager: async (...args) => {
      calls.push(args);
      if (calls.length === failAt) return { ok: false, error: "create 超时" };
      if (args[0] !== "ledger") return { ok: true };
      return runLedger(args.slice(1), {
        db, actor: "owner", projectIds: ["p"], proposals: { path },
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => NOW + 20,
      }) as Promise<{ ok?: boolean; error?: string }>;
    },
  });

  beforeEach(async () => {
    db = openLedger(tempLedgerPath("team-confirm-"));
    path = join(mkdtempSync(join(tmpdir(), "team-prop-")), "p.json");
    calls = [];
    failAt = -1;
    p = newProposal(upDraft(), NOW, "0a1b2c3d");
    await updateProposals((all) => void (all[p.id] = p), NOW, path);
  });

  test("bridge 贴卡片：发在提议者频道、来源是 bridge、文字按提案渲染，贴在哪记进提案", async () => {
    const { sent, r } = await post(p, path);
    expect(r).toEqual({ result: { posted: "c-pm", messageIds: ["m-card"] } });
    expect(sent[0]).toMatchObject({ from: { kind: "bridge", label: "team-proposal" }, to: { kind: "user", channelId: "c-pm" } });
    expect(sent[0].content).toContain("PM 名单改为：pm、p-dispatch");
    expect(JSON.stringify(sent[0].meta.components)).toContain(okId());
    expect((await readProposals(path))[p.id]?.posted).toEqual({ chatId: "c-pm", messageIds: ["m-card"] });
    await post(p, path, ["m-again"]);
    expect((await readProposals(path))[p.id]?.posted?.messageIds).toEqual(["m-card", "m-again"]);
  });

  test("确认：点在贴出的那条上 → 按 applyPlan 执行，team-apply 写名单 / 班子 / owner 决定并结案 applied；再点一次被拒", async () => {
    await post(p, path);
    expect(await handleTeamButton(okId(), "Discord", at, deps())).toContain("编排班子已生效");
    expect(calls).toEqual(applyPlan(p));
    expect((await readProposals(path))[p.id]).toMatchObject({ status: "applied", confirmedAt: NOW + 10, note: "Discord 确认，已生效" });
    expect(getMeta(db, "p")).toMatchObject({ pms: ["agent-pm", "agent-p-dispatch"], team: { dispatcher: "agent-p-dispatch", audit: true } });
    const decision = listEvents(db, { project: "p" }).find((e) => e.kind === "decision");
    expect(decision).toMatchObject({ actor: "owner", data: { transcribed: true, proposal: p.id } });
    expect(await handleTeamButton(okId(), "Discord", at, deps())).toContain("不能再点");
    expect(calls).toHaveLength(applyPlan(p).length);
  });

  test("伪造的按钮一律不执行：卡片没由 bridge 贴过、校验码不对、换了频道、点在别的消息上", async () => {
    const forgedHash = `team_ok:${p.id}:${p.hash}0000`; // agent 能算出的只有明文内容哈希
    expect(await handleTeamButton(okId(), "Discord", at, deps())).toContain("按钮校验不过"); // 还没贴过
    await post(p, path);
    expect(await handleTeamButton(forgedHash, "Discord", at, deps())).toContain("按钮校验不过");
    expect(await handleTeamButton(buttonIds(p, proposalMac(new Uint8Array(32), p, "c-pm")).ok, "Discord", at, deps())).toContain("按钮校验不过");
    expect(await handleTeamButton(okId(), "Discord", { chatId: "c-exec", messageId: "m-card" }, deps())).toContain("按钮校验不过");
    expect(await handleTeamButton(okId(), "Discord", { chatId: "c-pm", messageId: "m-exec-fake" }, deps())).toContain("按钮校验不过");
    expect(calls).toEqual([]);
    expect((await readProposals(path))[p.id]?.status).toBe("pending");
  });

  test("拒绝：什么都不执行；中途失败：停在失败那步，结案 failed 并写明；PM 名单提案的回执说名单", async () => {
    await post(p, path);
    expect(await handleTeamButton(buttonIds(p, proposalMac(KEY, p, "c-pm")).no, "网页 owner", { chatId: "c-pm" }, deps())).toContain("已拒绝");
    expect(calls).toEqual([]);
    const q = newProposal(upDraft(), NOW, "11112222");
    await updateProposals((all) => void (all[q.id] = q), NOW, path);
    await post(q, path, ["m-q"]);
    failAt = 2;
    expect(await handleTeamButton(buttonIds(q, proposalMac(KEY, q, "c-pm")).ok, "Discord", { chatId: "c-pm", messageId: "m-q" }, deps())).toContain("第 2/4 步");
    expect(calls).toHaveLength(2);
    expect((await readProposals(path))[q.id]?.status).toBe("failed");
    expect(getMeta(db, "p").pms).toEqual([]);
    const pmsDraft = { kind: "pms" as const, project: "p", proposer: "agent-pm", pm: null, pms: ["agent-pm"], dispatcher: null, audit: true };
    const pmsOnly = newProposal({ ...pmsDraft, base: { pms: [], team: null }, roles: [] }, NOW, "33334444");
    await updateProposals((all) => void (all[pmsOnly.id] = pmsOnly), NOW, path);
    await post(pmsOnly, path, ["m-pms"]);
    const r = await handleTeamButton(buttonIds(pmsOnly, proposalMac(KEY, pmsOnly, "c-pm")).ok, "Discord", { chatId: "c-pm", messageId: "m-pms" }, deps());
    expect(r).toContain("PM 名单已改为 agent-pm");
    expect(r).not.toContain("撤下");
  });

  test("提案文件里被改了名单：内容哈希对不上，不执行；不是班子按钮 → null", async () => {
    await post(p, path);
    await updateProposals((all) => void (all[p.id].pms = ["agent-evil"]), NOW, path);
    expect(await handleTeamButton(okId(), "Discord", at, deps())).toContain("被改过");
    expect(calls).toEqual([]);
    expect(await handleTeamButton("list_agents", "Discord", at, deps())).toBeNull();
  });
});

describe("网页确认入口：只认 owner 本人的设备凭据", () => {
  const base = { createdAt: "2026-09-29T00:00:00Z" };
  const ownerDevice = { ...base, id: "owner:self", role: "owner", agents: ["*", "master"], manage: true, credential: "cred1" } as Principal;
  const bearerStar = { ...base, id: "token:tok_1", role: "external", agents: ["*"], secret: "s" } as Principal;
  const guest = { ...base, id: "guest:g1", role: "external", agents: ["a"], manage: false, credential: "cred2" } as Principal;
  const peer = { ...base, id: "token:tok_p", role: "external", agents: ["*"], peer: "other", credential: "c3" } as Principal;
  const ownerPartial = { ...ownerDevice, agents: ["a"] } as Principal;

  test("canConfirmTeam 矩阵", () => {
    expect(canConfirmTeam(ownerDevice)).toBe(true);
    for (const p of [bearerStar, guest, peer, ownerPartial]) expect(canConfirmTeam(p)).toBe(false);
  });

  test("路由：普通消息放行（null）；按钮 + Bearer → 403；按钮点在别的 agent 的聊天里 → 不执行；owner 设备点在卡片所在的聊天 → 结案", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "team-prop-")), "p.json");
    const calls: string[][] = [];
    const deps = (): ConfirmDeps => ({ path, key: KEY, now: () => NOW + 10, runManager: async (...a) => (calls.push(a), { ok: true }) });
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    await updateProposals((all) => void (all[p.id] = p), NOW, path);
    await post(p, path);
    const route = teamConfirmRoute(deps);
    const url = new URL("http://x/api/v1/agents/pm/messages");
    const headers = { "Content-Type": "application/json" };
    const req = (text: string, u = url) => new Request(u.toString(), { method: "POST", headers, body: JSON.stringify({ text, wait: 0 }) });
    const click = `[button:${buttonIds(p, proposalMac(KEY, p, "c-pm")).ok}]`;
    expect(await route(req("你好"), url, ownerDevice)).toBeNull();
    const plain = req("你好");
    await route(plain, url, ownerDevice);
    expect(await plain.json()).toEqual({ text: "你好", wait: 0 }); // 偷看用的是 clone，原请求还能往下读
    expect((await route(req(click), url, bearerStar))?.status).toBe(403);
    const other = new URL("http://x/api/v1/agents/exec/messages");
    expect(((await (await route(req(click, other), other, ownerDevice))?.json()) as { text: string }).text).toContain("按钮校验不过");
    expect(calls).toEqual([]);
    const ok = await route(req(click), url, ownerDevice);
    expect(ok?.status).toBe(200);
    expect(((await ok?.json()) as { text: string }).text).toContain("已生效");
    expect(calls).toHaveLength(applyPlan(p).length);
  });
});

describe("team status", () => {
  test("每个进行中任务给出现在谁在接；列出名单成员的 registry 角色；执行者超过阈值且没开调度助理时建议开", () => {
    const db = openLedger(tempLedgerPath("team-status-"));
    const o = { actor: "owner", now: 1 };
    setMeta(db, o, { project: "p", key: "pms", value: ["agent-pm"] });
    for (let i = 0; i <= SUGGEST_AT; i++) createTask(db, o, { project: "p", id: `T${i}`, title: `t${i}`, kind: "code", agent: `agent-e${i}` });
    const v = statusView(db, "p", [], { "agent-pm": { role: "pm" } });
    expect(v.executors).toBe(SUGGEST_AT + 1);
    expect(v.suggestion).toContain("team up --project p --dispatcher");
    expect(v.tasks[0].handler).toMatchObject({ role: "pm", agent: "agent-pm" });
    expect(v.roles).toEqual({ "agent-pm": "pm" });
    setMeta(db, o, { project: "p", key: "team", value: { dispatcher: "agent-d", audit: true } });
    expect(statusView(db, "p", []).suggestion).toBeNull();
    expect(statusView(db, "p", []).roles).toEqual({ "agent-pm": null, "agent-d": null });
  });
});
