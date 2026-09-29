/**
 * 批量管理（fleet）经 ws 调用时「谁在调、能动谁」的纯判定。身份只认 bridge 这边 ws 连接上已注册的频道，
 * 不信请求里自报的名字；manager CLI 的连接不注册，落到 cli（T35 的最低口径，身份自报、防手滑级别）。
 * 能调的：大总管、台账 pms 上的 agent（只管自己是 PM 的项目）、config.json fleet.callers（管全部）。
 * 经 MCP 一律不动大总管（带上就整个拒）、不动调用方自己。用例见 tests/fleet-caller.test.ts。
 */
import { bareName, type Excluded, type FleetActionKind, type FleetCandidate, type FleetSelect } from "./fleet-plan.js";
import { isMasterName } from "./registry.js";

export interface FleetCaller {
  kind: "master" | "pm" | "caller";
  /** registry 名（带 agent- 前缀）；大总管是 "master" */
  name: string;
  /** 能动的项目；null = 全部（大总管、fleet.callers） */
  projects: string[] | null;
}

export interface CallerInput {
  /** 这条 ws 连接在 bridge 注册过的频道；空 = 没注册（manager CLI，或还没注册上的 channel-server） */
  channels: readonly string[];
  /** 请求是不是 MCP 工具发的（channel-server 带 via:"mcp"） */
  mcp: boolean;
  controlChannelId?: string;
  /** 频道在 registry 里对应的 agent；null = 查不到 */
  agent: { name: string; external?: boolean } | null;
  /** 项目 id → 台账 meta 的 PM 名单 */
  pmsByProject: ReadonlyMap<string, readonly string[]>;
  /** config.json fleet.callers（带不带 agent- 前缀都认） */
  callers: readonly string[];
}

export type CallerDecision = { kind: "cli" } | { kind: "ok"; caller: FleetCaller } | { kind: "deny"; error: string };

export const FLEET_DENIED = "只有大总管和 PM 能用 fleet";
/** MCP 下发文本的上限（比网页 / CLI 的 4000 紧）；工具那侧先报一次，bridge 这里是真正的闸 */
export const MCP_TEXT_MAX = 2000;

export function identifyFleetCaller(x: CallerInput): CallerDecision {
  if (!x.channels.length) {
    // channel-server 没注册上（控制频道被拒、还在重连）时发来的 MCP 请求不能掉进 CLI 分支，否则身份判定就被绕过了
    return x.mcp ? { kind: "deny", error: "这条连接还没在 bridge 注册频道，认不出调用方，fleet 不能用" } : { kind: "cli" };
  }
  // 控制频道只有 MASTER_DIR 里的实例能注册（lib/control-registrant.ts），占着它就是大总管
  if (x.controlChannelId && x.channels.includes(x.controlChannelId)) return { kind: "ok", caller: { kind: "master", name: "master", projects: null } };
  if (x.channels.length > 1) return { kind: "deny", error: `${FLEET_DENIED}（这条连接注册了 ${x.channels.length} 个频道，认不准是谁）` };
  if (!x.agent) return { kind: "deny", error: `${FLEET_DENIED}（频道 ${x.channels[0]} 不在 registry 里，认不出是谁）` };
  const name = x.agent.name;
  // external = 开放给 peer / API token 调用；它的回合可能是外人发的消息触发的，不能拿它的身份去别人窗口里发键
  if (x.agent.external) return { kind: "deny", error: `${FLEET_DENIED}（${name} 开了 external，可被 peer 调用的 agent 不能调 fleet）` };
  const me = bareName(name);
  if (x.callers.some((c) => bareName(c) === me)) return { kind: "ok", caller: { kind: "caller", name, projects: null } };
  const projects = [...x.pmsByProject].filter(([, pms]) => pms.some((p) => bareName(p) === me)).map(([p]) => p).sort();
  if (projects.length) return { kind: "ok", caller: { kind: "pm", name, projects } };
  return { kind: "deny", error: FLEET_DENIED };
}

const MASTER_OWNER_ONLY = "大总管只由 owner 在网页上操作";

/** 会打断调用方正在跑的这一轮的动作：对自己点名做这些，整个请求报错 */
const INTERRUPTS_SELF: readonly FleetActionKind[] = ["compact", "lp-compact", "save-compact"];

/** 调用方越界（不是它的项目、点名自己压缩、带上大总管）：是拒绝不是故障，入口原样报给调用方 */
export class FleetScopeError extends Error {}

export type ScopeResult<T> = { ok: true; cands: T[]; select: FleetSelect; excluded: Excluded[] } | { ok: false; error: string };

/**
 * 在 selectTargets 之前按调用方收窄候选：去掉大总管、调用方自己、PM 管不到的项目。
 * 点名了但被收掉的（自己、别的项目）记进 excluded，并从 select.agents 里拿掉（否则 selectTargets 会再报一次「没有这个 agent」）；
 * all / project 带进来的自己也记一条，免得调用方以为漏了；PM 管不到的其他 agent 直接不出现（all 只展开到它的项目）。
 */
export function scopeForCaller<T extends FleetCandidate>(caller: FleetCaller, action: FleetActionKind, sel: FleetSelect, cands: T[]): ScopeResult<T> {
  const named = new Set((sel.agents ?? []).map(bareName));
  // 和 ws 的 CLI 分支同一条线（bridge/fleet/ws.ts）：includeMaster、点名 master（isMasterName 认大小写 / 全角 / 多层前缀）都整个拒
  if (sel.includeMaster || (sel.agents ?? []).some(isMasterName)) return { ok: false, error: `fleet 不能动大总管：${MASTER_OWNER_ONLY}` };
  if (caller.projects && sel.project !== undefined && !caller.projects.includes(sel.project)) {
    return { ok: false, error: `你不是项目 ${sel.project} 的 PM（你管：${caller.projects.join("、")}）` };
  }
  const me = bareName(caller.name);
  if (named.has(me) && INTERRUPTS_SELF.includes(action)) {
    return { ok: false, error: "不能对自己压缩：你正在这一轮里调用 fleet，压缩会打断它。要压自己请在这一轮结束后自己跑 /compact" };
  }
  const excluded: Excluded[] = [];
  const drop = new Set<string>();
  const out: T[] = [];
  for (const c of cands) {
    const n = bareName(c.name);
    const picked = named.has(n) || (!c.master && (!!sel.all || (sel.project !== undefined && c.project === sel.project)));
    const reason = c.master
      ? MASTER_OWNER_ONLY
      : n === me
        ? "调用方自己：你正在这一轮里，发键会插进或打断它"
        : caller.projects && !(c.project && caller.projects.includes(c.project))
          ? "不在你管的项目里"
          : null;
    if (!reason) {
      out.push(c);
      continue;
    }
    if (named.has(n)) drop.add(n);
    if (named.has(n) || (picked && n === me)) excluded.push({ name: n, reason });
  }
  const select: FleetSelect = sel.agents ? { ...sel, agents: sel.agents.filter((a) => !drop.has(bareName(a))) } : sel;
  return { ok: true, cands: out, select, excluded };
}

/**
 * 调用方凭据能动谁，传给服务层当 allowed（列状态、选目标、发键前各查一遍）：不含大总管和调用方自己，PM 只到它管的项目。
 * 和 scopeForCaller 是同一条线：那边负责报错、写 excluded 原因，这个是服务层最后一道闸，两边任一放宽都还有另一边挡着
 */
export function allowedForCaller(caller: FleetCaller, agents: readonly Pick<FleetCandidate, "name" | "project">[]): (name: string) => boolean {
  const me = bareName(caller.name);
  const mine = (p?: string) => !caller.projects || (!!p && caller.projects.includes(p));
  const ok = new Set(agents.filter((a) => !isMasterName(a.name) && bareName(a.name) !== me && mine(a.project)).map((a) => a.name));
  return (name) => ok.has(name);
}
