/**
 * 开工前核（MIX1「PM 定」5）：前卡最终 head、私仓中心支持证明、四 daemon 实际拓扑与三机差异。
 * 规矩只有一条：没有证据的项是 unverified，绝不填 pass；任何一项不是 pass，ready 就是 false。
 * 纯函数：证据由调用方给（CLI 从 git 历史与人给的 JSON 文件收集），这里不读真实机器。
 */
import { createServicePlan } from "../../../src/lib/floka-services/plan/index.ts";

/** 本卡依赖的前卡：第一批十张 + 兼容层三张 + 矩阵直接复用其接口的五张 */
export const PRIOR_CARDS = [
  "MAP1", "CODEMOD1", "TXN1", "STATE1", "STATE2", "RUNTIME1", "SERVICEPLAN1", "SIGN1", "RELAY1", "E2E1",
  "INSTALLCFG1", "LEDGER1", "WEBWIRE1", "CENTER1", "CENTER2", "PEER1", "SERVICES1", "MCP1",
] as const;

/** 四个 daemon 的名字取自 SERVICEPLAN1 的定义，不另抄一份 */
export const DAEMONS: readonly string[] = createServicePlan("preflight", { repoRoot: "/", bunPath: "/", home: "/", envPath: "", logDir: "/" }).services.map((s) => s.name);

type CheckStatus = "pass" | "fail" | "unverified";
export interface CheckItem { id: string; status: CheckStatus; detail: string }

export interface PreflightEvidence {
  /** 卡 → 基线上合入它的提交；null = 查过、没找到；缺键 = 没查 */
  merged?: Partial<Record<string, string | null>>;
  /** 私仓中心支持两族的证明：{ repo, commit, families } */
  centerProof?: unknown;
  /** 三机实际拓扑：{ machines: { 名字: { daemons: [...], version?: "..." } } } */
  topology?: unknown;
}

const SHA = /^[0-9a-f]{7,40}$/;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** 合入提交的标题里认卡名：大小写不敏感，后面不能紧跟字母数字（STATE1 不认 STATE10） */
export function cardMerges(log: readonly { sha: string; subject: string }[]): Record<string, string | null> {
  return Object.fromEntries(PRIOR_CARDS.map((card) => {
    const re = new RegExp(`rename-floka-${card}(?![A-Za-z0-9])`, "i");
    return [card, log.find((c) => re.test(c.subject))?.sha ?? null];
  }));
}

function cardItems(merged: PreflightEvidence["merged"]): CheckItem[] {
  return PRIOR_CARDS.map((card) => {
    const id = `card:${card}`;
    if (!merged || !(card in merged)) return { id, status: "unverified", detail: "没有查基线历史" };
    const sha = merged[card];
    return sha && SHA.test(sha) ? { id, status: "pass", detail: sha } : { id, status: "fail", detail: "基线上没有合入记录" };
  });
}

function centerItem(raw: unknown): CheckItem {
  const id = "center-proof";
  if (raw === undefined) return { id, status: "unverified", detail: "没有私仓中心支持证明（本仓看不到私仓，需人给出 repo / commit / families）" };
  const p = obj(raw);
  const fam = Array.isArray(p?.families) ? p!.families : [];
  if (!p || typeof p.repo !== "string" || !p.repo || typeof p.commit !== "string" || !SHA.test(p.commit)) {
    return { id, status: "fail", detail: "证明格式不对：要 repo 与 commit（7–40 位小写 hex）" };
  }
  if (!fam.includes("legacy") || !fam.includes("floka")) return { id, status: "fail", detail: "证明没写中心两族都认（families 需含 legacy 与 floka）" };
  return { id, status: "pass", detail: `${p.repo}@${p.commit}` };
}

/** 三机拓扑：每台都要正好跑着四个 daemon；版本或 daemon 集合的差异写进 detail，缺 daemon / 多 daemon 判 fail */
function topologyItems(raw: unknown): CheckItem[] {
  if (raw === undefined) return [{ id: "topology", status: "unverified", detail: "没有三机拓扑证据" }];
  const machines = obj(obj(raw)?.machines);
  if (!machines || Object.keys(machines).length !== 3) return [{ id: "topology", status: "fail", detail: "拓扑要正好三台机器" }];
  const items: CheckItem[] = [];
  const versions = new Map<string, string>();
  for (const [name, m] of Object.entries(machines)) {
    const daemons = Array.isArray(obj(m)?.daemons) ? (obj(m)!.daemons as unknown[]).filter((d): d is string => typeof d === "string") : [];
    const missing = DAEMONS.filter((d) => !daemons.includes(d));
    const extra = daemons.filter((d) => !DAEMONS.includes(d));
    const version = obj(m)?.version;
    if (typeof version === "string") versions.set(name, version);
    const ok = missing.length === 0 && extra.length === 0 && daemons.length === DAEMONS.length;
    items.push({ id: `topology:${name}`, status: ok ? "pass" : "fail", detail: ok ? daemons.join(",") : `缺 ${missing.join(",") || "无"}；多 ${extra.join(",") || "无"}` });
  }
  const distinct = new Set(versions.values());
  const diff = versions.size < 3 ? "有机器没报版本" : distinct.size > 1 ? `版本不一：${[...versions].map(([n, v]) => `${n}=${v}`).join(" ")}` : "三机版本一致";
  items.push({ id: "topology:diff", status: versions.size === 3 ? "pass" : "unverified", detail: diff });
  return items;
}

export function preflight(e: PreflightEvidence): { ready: boolean; items: CheckItem[] } {
  const items = [...cardItems(e.merged), centerItem(e.centerProof), ...topologyItems(e.topology)];
  return { ready: items.every((i) => i.status === "pass"), items };
}
