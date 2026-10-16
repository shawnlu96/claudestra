/**
 * XMACH1「今天 · 团队与额度」机器行与设置 · 伙伴机器页的合成数据（模型单测、happy-dom、截图共用一份），叠在 today-shots 的世界上。照规格「对照基准」：
 * - 伙伴机器 2 个（机器 B 在线、机器 C 连不上）；
 * - 借出在跑 2 单：机器 B 一单正常在跑，机器 C 已收回（授权列表里没有它）、5 分钟前最后一次更新还 live = 停住；另有 1 单已结束（不算在跑）；
 * - 借入在跑 3 单，分在合成项目 A（A1 在跑、A4 等领取）与 B（B1 在跑、租约已过 = 停住）；
 * - forbidden：/lend/grants、/borrow、/peers/contacts 都回 403（非 owner 设备）。
 * 纯数据 + Response 构造，不 import web 里带 React 的模块。
 */
import { TODAY_NOW } from "./today-shots";

const MIN = 60_000;

export function machinesContacts() {
  return [
    { name: "机器 B", online: true, agents: [], stale: false },
    { name: "机器 C", online: false, agents: [], stale: false },
  ];
}

const lentOrder = (n: number, over: Record<string, unknown>, now: number) => ({ orderId: `lend-${n}`, peer: "机器 B", family: "codex", state: "running", repo: "synthetic/shop",
  pr: 40 + n, taskId: `L${n}`, step: "write", agent: `agent-lend-${n}`, startedAt: now - n * 10 * MIN, updatedAt: now - MIN, reason: null,
  notices: { start: now - n * 10 * MIN }, live: true, ...over });

export function machinesLend(now = TODAY_NOW) {
  return {
    writeOpen: true, maxDays: 7, shellSentence: "", peers: [{ name: "机器 B", fp: "b".repeat(16) }, { name: "机器 C", fp: "c".repeat(16) }],
    grants: [{ peer: "机器 B", repos: ["synthetic/shop"], roles: ["write", "review"], families: { codex: 2 }, ordersPerDay: 50,
      until: new Date(now + 6 * 86_400_000).toISOString(), grantedAt: new Date(now - 86_400_000).toISOString(), paused: null, problem: null }],
    orders: [
      lentOrder(1, {}, now),
      lentOrder(2, { peer: "机器 C", step: "review", updatedAt: now - 5 * MIN }, now),
      lentOrder(3, { state: "acked", live: false, updatedAt: now - 60 * MIN, notices: { start: now - 90 * MIN, end: { kind: "acked", why: null, sentAt: now - 60 * MIN } } }, now),
    ],
  };
}

const remote = (orderId: string, taskId: string, title: string, project: string, status: string, over: Record<string, unknown>, now: number) => ({
  orderId, taskId, title, project, peer: "机器 B", family: "codex", step: "write", status, leaseUntil: now + 20 * MIN, beatAt: now - 30_000, phase: "working", ...over });

export function machinesBorrow(now = TODAY_NOW) {
  const entry = { peer: "机器 B", projects: ["proj-a", "proj-b"], roles: ["write", "review"], maxOpen: 3, priority: "balance" };
  return {
    now, schedulerOk: true,
    projects: [{ id: "proj-a", mode: "balance", maxActiveWorkers: 3, agents: { claude: 1, codex: 2 } }, { id: "proj-b", mode: "balance", maxActiveWorkers: 2, agents: { claude: 0, codex: 1 } }],
    localQuota: null,
    borrow: { file: "ok", invalid: false, declared: [entry], effective: [entry], dropped: [], contacts: ["机器 B", "机器 C"],
      projects: [{ id: "proj-a", name: "合成项目 A" }, { id: "proj-b", name: "合成项目 B" }], maxOpenLimit: 8 },
    ledger: true,
    peers: [{ peer: "机器 B", maxOpen: 3, projects: ["proj-a", "proj-b"], roles: ["write", "review"], priority: "balance",
      capacity: { peer: "机器 B", proto: 2, helloAt: now - 40_000, open: 3, slots: { codex: 1, claude: 0 }, why: null },
      reported: { codex: { total: 4, busy: 3 }, claude: { total: 0, busy: 0 } }, paused: null, grant: null }],
    remote: [
      remote("r-a1", "A1", "导出按钮改版", "proj-a", "claimed", {}, now),
      remote("r-a4", "A4", "通知设置页", "proj-a", "pooled", { leaseUntil: null, beatAt: null, phase: null }, now),
      remote("r-b1", "B1", "同步失败重试", "proj-b", "claimed", { leaseUntil: now - 4 * MIN, beatAt: now - 9 * MIN }, now),
    ],
  };
}

/** /lend/quota-lines 的完整回包（today-shots 那份只够今天页额度行；设置页额度线卡要重置时刻与名额）：百分比同 today-shots */
export function machinesQuotaLines(now = TODAY_NOW) {
  const fam = (family: string, weekUsedPct: number) => ({ family, warnPct: 80, stopPct: 95, weekUsedPct, resetAt: now + 3 * 86_400_000, observedAt: now - MIN,
    source: "live", freshness: "fresh", state: "below", mode: "auto", limit: "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2 });
  return { ok: true, config: { status: "ok", error: null, mode: "auto" }, at: now, families: [fam("claude", 62), fam("codex", 18)] };
}

export interface MachinesWorld { now: number; forbidden: boolean; contacts: object[]; lend: object; borrow: object }
export const machinesWorld = (now = TODAY_NOW, forbidden = false): MachinesWorld =>
  ({ now, forbidden, contacts: machinesContacts(), lend: machinesLend(now), borrow: machinesBorrow(now) });

/** 夹具接口（path 去掉 /api/v1）：只答这几个，其余 null 交给 todayRoute */
export function machinesRoute(path: string, world: MachinesWorld): Response | null {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const deny = () => json({ ok: false, error: "forbidden" }, 403);
  if (path === "/peers/contacts") return world.forbidden ? deny() : json({ ok: true, contacts: world.contacts });
  if (path === "/lend/grants") return world.forbidden ? deny() : json(world.lend);
  if (path === "/borrow") return world.forbidden ? deny() : json(world.borrow);
  // 设置 · 伙伴机器页同页的其余面板（联系人与授权、中继、出借 Claude 登录）：给最小的正常回包，截图里不出「加载失败」
  if (path === "/peers") return world.forbidden ? deny() : json({ ok: true, peers: [], localAgents: [], pendingInvites: [], tidy: [], self: null });
  if (path === "/lend/quota-lines") return world.forbidden ? null : json(machinesQuotaLines(world.now));
  if (path === "/relay/status") return json({ ok: true, enabled: false, connected: false });
  if (path === "/lend/claude-token") return world.forbidden ? deny() : json({ loggedIn: true, reason: null, legacyTokenFile: null, legacyTokenEnv: false });
  return null;
}
