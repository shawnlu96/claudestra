/**
 * 编排班子的「提案 → owner 在界面上点确认 → 生效」（docs/team/orchestration-team.md §owner 确认）。
 * 改 PM 名单、开关班子要 owner 身份，而 agent 不能冒充 owner：`team up` / `team down` / `ledger meta --pms` 只生成提案、贴出按钮；
 * 提案卡片由 bridge 按提案文件渲染并贴出（bridge/team-confirm.ts postProposalCard），按钮 id 带 bridge 进程内密钥的 HMAC（proposalMac），
 * 点击时核对 HMAC 和「点在 bridge 贴出的那条消息上」；owner 在 Discord（白名单用户）或网页（owner 设备凭据）点确认后，
 * bridge 把提案标成 confirmed，再用 runManager 按 applyPlan 逐条执行。台账只由 `ledger team-apply <id>` 写，它自己再核对一遍
 * （已确认、内容哈希一致、确认时未过期、提议时的 PM 名单与班子配置没变）。CLI 没有 confirm 子命令。
 * 这是产品约束，不是安全边界：同一用户的 shell 能直接改状态文件和台账库（见文档）。tests/team-confirm.test.ts、tests/team-apply.test.ts。
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { readJsonLenient, writeJsonStateGuarded } from "./state-file.js";

const PROPOSAL_TTL_MS = 30 * 60_000;
const PROPOSALS_PATH = statePath("team-proposals.json");
/** 已结案的提案留这么久再清（team status 能看到最近的结果） */
const KEEP_CLOSED_MS = 7 * 24 * 3600_000;

interface DispatcherPlan {
  /** registry 键 */
  agent: string;
  /** 要新建（否则是已有 agent，只设角色） */
  create: boolean;
  /** 新建时的工作目录（项目的第一个目录） */
  dir?: string;
}

/** 提议时台账里的 PM 名单与班子配置：team-apply 时对不上就作废（旧提案不能按过时的名单整表覆盖） */
export interface TeamBase {
  pms: string[];
  team: { dispatcher: string | null; audit: boolean } | null;
}

/** registry 角色的变动（只影响启动提示，不涉权限）；none = 撤下 */
export interface RoleChange {
  agent: string;
  role: "pm" | "dispatcher" | "none";
}

export interface TeamProposal {
  id: string;
  /** up / down = 开关班子；pms = 只改 PM 名单（ledger meta --pms） */
  kind: "up" | "down" | "pms";
  project: string;
  /** 提议者（ledger 身份：agent-xxx / master / owner） */
  proposer: string;
  /** up：设成 pm 角色的 agent；down：null */
  pm: string | null;
  /** 生效后的 PM 名单（整表替换） */
  pms: string[];
  /** up：调度助理；down：要撤下角色的调度助理 */
  dispatcher: DispatcherPlan | null;
  audit: boolean;
  base: TeamBase;
  roles: RoleChange[];
  createdAt: number;
  expiresAt: number;
  hash: string;
  /** pending → confirmed（bridge 在 owner 点确认时标）→ applied（team-apply 写完台账）；或 rejected / failed */
  status: "pending" | "confirmed" | "applied" | "rejected" | "failed";
  confirmedAt?: number;
  /** 结案说明（谁点的、失败在哪一步） */
  note?: string;
  /** bridge 贴出卡片的位置：点击只认这个频道（Discord 还认这几条消息） */
  posted?: { chatId: string; messageIds: string[] };
}

type ProposalMap = Record<string, TeamProposal>;
export type ProposalDraft = Omit<TeamProposal, "id" | "createdAt" | "expiresAt" | "hash" | "status" | "posted">;

type Hashed = Pick<TeamProposal, "id" | "kind" | "project" | "proposer" | "pm" | "pms" | "dispatcher" | "audit" | "base" | "roles" | "expiresAt">;

/** 内容哈希：生成后提案文件被改过（换了名单 / 调度助理 / 角色）就对不上；team-apply 也据此核对 */
export function proposalHash(p: Hashed): string {
  const canon = JSON.stringify([p.id, p.kind, p.project, p.proposer, p.pm, p.pms, p.dispatcher, p.audit, p.base, p.roles, p.expiresAt]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

/** 当前台账的 PM 名单与班子配置，按 TeamBase 的形状（比较时不看 sinceSeq） */
export function teamBaseOf(meta: { pms: readonly string[]; team: { dispatcher: string | null; audit: boolean } | null }): TeamBase {
  return { pms: [...meta.pms], team: meta.team ? { dispatcher: meta.team.dispatcher, audit: meta.team.audit } : null };
}

/** team-apply 时：提议之后名单或班子配置变过（先点了别的提案、down 过）就作废；null = 没变 */
export function baseRefusal(p: Pick<TeamProposal, "base">, now: TeamBase): string | null {
  return JSON.stringify(p.base) === JSON.stringify(now) ? null : "提议之后 PM 名单或班子配置已经变了（别的提案先生效、或者 down 过），这份提案作废；请按现状重新提议";
}

/**
 * 生效后各人的 registry 角色：班子开着时调度助理 → dispatcher、名单里其余的 → pm，其余（被移出名单、班子关掉）撤下。
 * 只列要变的：registry 里没有的跳过（要新建的调度助理由 create --role 设），撤下只撤 pm / dispatcher（别的角色不归班子管）。
 */
export function planRoles(
  after: { pms: readonly string[]; dispatcher: string | null; on: boolean },
  base: TeamBase,
  agents: Record<string, { role?: string }>,
): RoleChange[] {
  const everyone = [...new Set([...base.pms, ...after.pms, base.team?.dispatcher, after.dispatcher].filter((a): a is string => !!a))];
  const out: RoleChange[] = [];
  for (const agent of everyone) {
    if (!agents[agent]) continue;
    const want = !after.on ? "none" : agent === after.dispatcher ? "dispatcher" : after.pms.includes(agent) ? "pm" : "none";
    const cur = agents[agent].role ?? "none";
    if (want === cur || (want === "none" && cur !== "pm" && cur !== "dispatcher")) continue;
    out.push({ agent, role: want });
  }
  return out;
}

export function newProposal(d: ProposalDraft, now: number, id = randomBytes(4).toString("hex")): TeamProposal {
  const base = { ...d, id, createdAt: now, expiresAt: now + PROPOSAL_TTL_MS };
  return { ...base, hash: proposalHash(base), status: "pending" };
}

/**
 * 按钮上的校验码：bridge 进程内密钥对（提案 id、内容哈希、贴出的频道）做 HMAC。密钥只在 bridge 内存里，
 * agent 算不出来，也就没法自己贴一个能用的确认按钮；bridge 重启后旧卡片作废（重新提议即可）。
 */
export function proposalMac(key: Uint8Array, p: Pick<TeamProposal, "id" | "hash">, chatId: string): string {
  return createHmac("sha256", key).update(`${p.id}|${p.hash}|${chatId}`).digest("hex").slice(0, 16);
}

export const buttonIds = (p: Pick<TeamProposal, "id">, mac: string) => ({ ok: `team_ok:${p.id}:${mac}`, no: `team_no:${p.id}:${mac}` });

/** `team_ok:<id>:<mac>` / `team_no:…` → 动作；别的按钮 → null */
export function parseTeamButton(id: string): { approve: boolean; id: string; mac: string } | null {
  const m = id.match(/^team_(ok|no):([0-9a-f]{8}):([0-9a-f]{16})$/);
  return m ? { approve: m[1] === "ok", id: m[2], mac: m[3] } : null;
}

/** 能不能按这个按钮结案（状态、内容、期限；点在哪儿、校验码由 bridge 另核）；null = 可以 */
export function refuseReason(p: TeamProposal | undefined, now: number): string | null {
  if (!p) return "提案不存在（可能已清理）";
  if (p.status !== "pending") return `提案已${p.status === "applied" ? "生效" : p.status === "rejected" ? "被拒" : "处理过"}，不能再点`;
  if (proposalHash(p) !== p.hash) return "提案内容在生成后被改过，作废；请重新 team up / down";
  if (now > p.expiresAt) return "提案已过期（30 分钟），请重新 team up / down";
  return null;
}

/** 确认后 team-apply 要在这么久内跑完（生效步骤里的 create 最多等 3 分钟） */
const APPLY_WINDOW_MS = 10 * 60_000;

/** `ledger team-apply` 的核对：必须是 bridge 标过的 confirmed、内容没被改过、确认发生在过期之前、还在执行窗口内；null = 可以写 */
export function applyRefusal(p: TeamProposal | undefined, now: number): string | null {
  if (!p) return "提案不存在";
  if (p.status === "applied") return "提案已经写进台账了，不用再跑；要改请重新提议";
  if (p.status !== "confirmed" || typeof p.confirmedAt !== "number") return `提案状态是 ${p.status}，没有经 owner 确认，不能写台账`;
  if (proposalHash(p) !== p.hash) return "提案内容在确认后被改过，作废";
  if (p.confirmedAt > p.expiresAt) return "提案是过期后才确认的，作废";
  if (now - p.confirmedAt > APPLY_WINDOW_MS) return "确认已超过 10 分钟还没写入，作废；请重新提议";
  return null;
}

const bare = (k: string) => k.replace(/^agent-/, "");

/** 贴给 owner 看的说明：按钮点下去会发生什么，逐条写清 */
export function proposalText(p: TeamProposal): string {
  const d = p.dispatcher;
  const lines =
    p.kind === "up"
      ? [
          `🧩 编排班子：请确认项目「${p.project}」的班子配置（${bare(p.proposer)} 提议）`,
          `- PM 名单改为：${p.pms.map(bare).join("、") || "（空）"}`,
          `- 调度助理：${d ? `${bare(d.agent)}${d.create ? `（新建，目录 ${d.dir}）` : "（已有 agent）"}` : "不开（交付直接通知 PM）"}`,
          `- 巡检：${p.audit ? "开" : "关"}；开启后台账事件自动路由`,
        ]
      : p.kind === "pms"
      ? [`🧩 PM 名单：请确认项目「${p.project}」的 PM 名单改为 ${p.pms.map(bare).join("、") || "（空）"}（${bare(p.proposer)} 提议）`]
      : [
          `🧩 编排班子：请确认撤掉项目「${p.project}」的班子（${bare(p.proposer)} 提议）`,
          "- 停止台账事件路由",
          `- PM 名单改为：${p.pms.map(bare).join("、") || "（空）"}`,
          ...(d ? [`- ${bare(d.agent)} 不再当调度助理（agent 不删，需要时手动 kill）`] : []),
        ];
  const roles = p.roles.map((r) => `${bare(r.agent)} ${r.role === "none" ? "撤下角色" : `→ ${r.role === "pm" ? "PM" : "调度助理"}`}`);
  const roleLine = roles.length ? [`- 角色：${roles.join("，")}（下次重启生效，不会自动重启）`] : [];
  return [...lines, ...roleLine, `只有 owner 本人点确认才生效；30 分钟内有效（提案 ${p.id}）。`].join("\n");
}

/**
 * 确认后 bridge 依次执行的 manager 命令（第一条失败就停，已执行的不回滚，结果写进提案 note）。
 * 先 `team-apply --check` 只核对不写（提议后名单变过就在建 agent 之前停下），再建调度助理、写台账，最后按 roles 设 / 撤角色。
 */
export function applyPlan(p: TeamProposal): string[][] {
  const d = p.dispatcher;
  const createD = p.kind === "up" && d?.create ? [["create", d.agent, d.dir ?? "", "--project", p.project, "--role", "dispatcher", "--purpose", `项目 ${p.project} 的调度助理`]] : [];
  const roles = p.roles.map((r) => ["team-link", r.agent, "--role", r.role]);
  return [["ledger", "team-apply", p.id, "--check"], ...createD, ["ledger", "team-apply", p.id], ...roles];
}

/** team-apply 往台账写什么：PM 名单整表替换；班子配置 up = 开、down = 关、pms = 不动 */
export function ledgerWrites(p: TeamProposal): { pms: string[]; team?: { dispatcher: string | null; audit: boolean } | null; decision: string } {
  const decision = `owner 在界面上确认了提案 ${p.id}：${proposalText(p).split("\n").slice(p.kind === "pms" ? 0 : 1, -1).join("；")}`;
  if (p.kind === "pms") return { pms: p.pms, decision };
  if (p.kind === "down") return { pms: p.pms, team: null, decision };
  return { pms: p.pms, team: { dispatcher: p.dispatcher?.agent ?? null, audit: p.audit }, decision };
}

const isMap = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

export async function readProposals(path = PROPOSALS_PATH): Promise<ProposalMap> {
  return readJsonLenient<ProposalMap>(path, {}, { validate: isMap, who: "team-proposals" });
}

/** 加锁读改写（CLI 写新提案、bridge 结案可能同时发生）；顺手清掉结案超过 KEEP_CLOSED_MS 的旧提案。拿不到锁就抛，绝不照写 */
export async function updateProposals<T>(mutate: (m: ProposalMap) => T, now = Date.now(), path = PROPOSALS_PATH): Promise<T> {
  const lock = await acquireLock(`${path}.lock`, 10_000);
  if (!lock) throw new Error("team-proposals.json 正被别的进程占着（10 秒没拿到锁），这次没改，稍后重试");
  try {
    const all = await readProposals(path);
    const out = mutate(all);
    for (const [id, p] of Object.entries(all)) {
      if (p.status !== "pending" && p.status !== "confirmed" && now - p.expiresAt > KEEP_CLOSED_MS) delete all[id];
    }
    await writeJsonStateGuarded(path, all, { validate: isMap });
    return out;
  } finally {
    lock.release();
  }
}
