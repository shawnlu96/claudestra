/**
 * 编排班子的 owner 确认：提案（src/lib/team-proposal.ts）、确认处理与网页入口（src/bridge/team-confirm.ts）、
 * team up / down 的规划与 status（src/manager/team-up.ts）。核心断言：改 PM 名单只能经 owner 在界面上点确认，
 * CLI 与 agent 手里的 Bearer token 都做不到；提案绑参数、过期、只生效一次。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { canConfirmTeam, handleTeamButton, teamConfirmRoute, type ConfirmDeps } from "../src/bridge/team-confirm.js";
import { getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import {
  applyPlan, buttonIds, newProposal, parseTeamButton, proposalHash, readProposals, refuseReason, updateProposals, type TeamProposal,
} from "../src/lib/team-proposal.js";
import { runLedger } from "../src/manager/ledger.js";
import { planDown, planUp, statusView, SUGGEST_AT } from "../src/manager/team-up.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const NOW = 1_000_000;
const agents = { "agent-pm": { channelId: "c-pm" }, "agent-old": {}, "agent-x": {} };
const upDraft = () => {
  const d = planUp({ project: "p", dir: "/w/p", actor: "agent-pm", dispatcher: "new", audit: true, meta: { pms: [], team: null }, agents });
  if ("error" in d) throw new Error(d.error);
  return d;
};

describe("planUp / planDown", () => {
  test("默认只配 PM；--dispatcher 新建 <project>-dispatch 并进名单；复用已有 agent 不新建", () => {
    const only = planUp({ project: "p", dir: "/w", actor: "agent-pm", audit: true, meta: { pms: [], team: null }, agents });
    expect(only).toMatchObject({ kind: "up", pm: "agent-pm", pms: ["agent-pm"], dispatcher: null, audit: true });
    expect(upDraft()).toMatchObject({ pms: ["agent-pm", "agent-p-dispatch"], dispatcher: { agent: "agent-p-dispatch", create: true, dir: "/w/p" } });
    const reuse = planUp({ project: "p", dir: "/w", actor: "owner", pm: "pm", dispatcher: "x", audit: false, meta: { pms: ["agent-pm"], team: null }, agents });
    expect(reuse).toMatchObject({ pms: ["agent-pm", "agent-x"], dispatcher: { agent: "agent-x", create: false }, audit: false });
  });

  test("换调度助理时旧的移出名单；终端里不给 --pm 报错；PM / 调度助理不存在报错", () => {
    const meta = { pms: ["agent-pm", "agent-old"], team: { dispatcher: "agent-old", audit: true, sinceSeq: 3 } };
    expect(planUp({ project: "p", dir: "/w", actor: "agent-pm", dispatcher: "x", audit: true, meta, agents })).toMatchObject({ pms: ["agent-pm", "agent-x"] });
    expect(planUp({ project: "p", dir: "/w", actor: "owner", audit: true, meta, agents })).toEqual({ error: "要用 --pm <agent> 指定 PM（在终端里跑时推不出是谁）" });
    expect("error" in planUp({ project: "p", dir: "/w", actor: "agent-nobody", audit: true, meta, agents })).toBe(true);
    expect("error" in planUp({ project: "p", dir: "/w", actor: "agent-pm", dispatcher: "ghost", audit: true, meta, agents })).toBe(true);
  });

  test("planDown：没开班子报错；开了则关路由、调度助理移出名单", () => {
    expect(planDown("p", "agent-pm", { pms: ["agent-pm"], team: null })).toEqual({ error: "项目 p 没开编排班子" });
    const d = planDown("p", "agent-pm", { pms: ["agent-pm", "agent-d"], team: { dispatcher: "agent-d", audit: true, sinceSeq: 1 } });
    expect(d).toMatchObject({ kind: "down", pms: ["agent-pm"], dispatcher: { agent: "agent-d", create: false } });
  });
});

describe("提案", () => {
  test("按钮 id 带参数哈希；改了内容、过期、结过案都拒", () => {
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    const ids = buttonIds(p);
    expect(parseTeamButton(ids.ok)).toEqual({ approve: true, id: "0a1b2c3d", hash: p.hash });
    expect(parseTeamButton(ids.no)?.approve).toBe(false);
    expect(parseTeamButton("list_agents")).toBeNull();
    expect(refuseReason(p, p.hash, NOW + 1)).toBeNull();
    expect(refuseReason({ ...p, pms: ["agent-evil"] }, p.hash, NOW + 1)).toContain("对不上");
    expect(refuseReason(p, "000000000000", NOW + 1)).toContain("对不上");
    expect(refuseReason(p, p.hash, p.expiresAt + 1)).toContain("过期");
    expect(refuseReason({ ...p, status: "applied" }, p.hash, NOW)).toContain("已生效");
    expect(refuseReason(undefined, p.hash, NOW)).toContain("不存在");
    expect(proposalHash(p)).toBe(p.hash);
  });

  test("applyPlan：台账只经 ledger team-apply 写；up 先建调度助理（带角色）、设 PM 角色，down 先写台账再撤角色，pms 只写台账", () => {
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    const steps = applyPlan(p);
    expect(steps.map((s) => s.slice(0, 2).join(" "))).toEqual(["create agent-p-dispatch", "team-link agent-pm", "ledger team-apply"]);
    expect(steps[0]).toEqual(expect.arrayContaining(["--role", "dispatcher", "--project", "p"]));
    expect(steps[2]).toEqual(["ledger", "team-apply", "0a1b2c3d"]);
    const down = applyPlan(newProposal(planDown("p", "agent-pm", { pms: ["agent-pm", "agent-d"], team: { dispatcher: "agent-d", audit: true, sinceSeq: 1 } }) as never, NOW, "0000aaaa"));
    expect(down).toEqual([["ledger", "team-apply", "0000aaaa"], ["team-link", "agent-d", "--role", "none"]]);
    const pms = newProposal({ kind: "pms", project: "p", proposer: "agent-pm", pm: null, pms: ["agent-pm"], dispatcher: null, audit: true }, NOW, "0000bbbb");
    expect(applyPlan(pms)).toEqual([["ledger", "team-apply", "0000bbbb"]]);
  });
});

describe("handleTeamButton", () => {
  let path: string;
  let calls: string[][];
  let failAt: number;
  let p: TeamProposal;
  let db: Database;
  // ledger 子命令真跑（owner 身份 = bridge 经 runManager 调用时的身份），其余命令只记下来
  const deps = (): ConfirmDeps => ({
    path, now: () => NOW + 10,
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

  test("确认：标 confirmed → 按 applyPlan 依次执行，team-apply 写名单 / 班子 / owner 决定并结案 applied；再点一次被拒", async () => {
    expect(await handleTeamButton(buttonIds(p).ok, "Discord", deps())).toContain("已生效");
    expect(calls).toEqual(applyPlan(p));
    expect((await readProposals(path))[p.id]).toMatchObject({ status: "applied", confirmedAt: NOW + 10, note: "Discord 确认，已生效" });
    expect(getMeta(db, "p")).toMatchObject({ pms: ["agent-pm", "agent-p-dispatch"], team: { dispatcher: "agent-p-dispatch", audit: true } });
    const decision = listEvents(db, { project: "p" }).find((e) => e.kind === "decision");
    expect(decision).toMatchObject({ actor: "owner", data: { transcribed: true, proposal: p.id } });
    expect(await handleTeamButton(buttonIds(p).ok, "Discord", deps())).toContain("不能再点");
    expect(calls).toHaveLength(applyPlan(p).length);
  });

  test("拒绝：什么都不执行；中途失败：停在失败那步，结案 failed 并写明", async () => {
    expect(await handleTeamButton(buttonIds(p).no, "网页 owner", deps())).toContain("已拒绝");
    expect(calls).toEqual([]);
    const q = newProposal(upDraft(), NOW, "11112222");
    await updateProposals((all) => void (all[q.id] = q), NOW, path);
    failAt = 1;
    expect(await handleTeamButton(buttonIds(q).ok, "Discord", deps())).toContain("第 1/3 步");
    expect(calls).toHaveLength(1);
    expect((await readProposals(path))[q.id]?.status).toBe("failed");
    expect(getMeta(db, "p").pms).toEqual([]);
  });

  test("提案文件里被改了名单：按钮哈希对不上，不执行", async () => {
    await updateProposals((all) => void (all[p.id].pms = ["agent-evil"]), NOW, path);
    expect(await handleTeamButton(buttonIds(p).ok, "Discord", deps())).toContain("对不上");
    expect(calls).toEqual([]);
  });

  test("不是班子按钮 → null（management.ts 接着走别的分支）", async () => {
    expect(await handleTeamButton("list_agents", "Discord", deps())).toBeNull();
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

  test("路由：普通消息放行（null）；按钮 + Bearer → 403 不执行；按钮 + owner 设备 → 结案", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "team-prop-")), "p.json");
    const calls: string[][] = [];
    const deps = (): ConfirmDeps => ({ path, now: () => NOW + 10, runManager: async (...a) => (calls.push(a), { ok: true }) });
    const p = newProposal(upDraft(), NOW, "0a1b2c3d");
    await updateProposals((all) => void (all[p.id] = p), NOW, path);
    const route = teamConfirmRoute(deps);
    const url = new URL("http://x/api/v1/agents/pm/messages");
    const req = (text: string) => new Request(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, wait: 0 }) });
    expect(await route(req("你好"), url, ownerDevice)).toBeNull();
    const plain = req("你好");
    await route(plain, url, ownerDevice);
    expect(await plain.json()).toEqual({ text: "你好", wait: 0 }); // 偷看用的是 clone，原请求还能往下读
    expect((await route(req(`[button:${buttonIds(p).ok}]`), url, bearerStar))?.status).toBe(403);
    expect(calls).toEqual([]);
    const ok = await route(req(`[button:${buttonIds(p).ok}]`), url, ownerDevice);
    expect(ok?.status).toBe(200);
    expect(((await ok?.json()) as { text: string }).text).toContain("已生效");
    expect(calls).toHaveLength(applyPlan(p).length);
  });
});

describe("team status", () => {
  test("每个进行中任务给出现在谁在接；执行者超过阈值且没开调度助理时建议开", () => {
    const db = openLedger(tempLedgerPath("team-status-"));
    const o = { actor: "owner", now: 1 };
    setMeta(db, o, { project: "p", key: "pms", value: ["agent-pm"] });
    for (let i = 0; i <= SUGGEST_AT; i++) createTask(db, o, { project: "p", id: `T${i}`, title: `t${i}`, kind: "code", agent: `agent-e${i}` });
    const v = statusView(db, "p", []);
    expect(v.executors).toBe(SUGGEST_AT + 1);
    expect(v.suggestion).toContain("team up --project p --dispatcher");
    expect(v.tasks[0].handler).toMatchObject({ role: "pm", agent: "agent-pm" });
    setMeta(db, o, { project: "p", key: "team", value: { dispatcher: "agent-d", audit: true } });
    expect(statusView(db, "p", []).suggestion).toBeNull();
    expect(getMeta(db, "p").team?.dispatcher).toBe("agent-d");
  });
});
