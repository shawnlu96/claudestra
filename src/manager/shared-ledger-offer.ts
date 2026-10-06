/**
 * `manager shared-ledger-offer --peer <peer> --url <中心根 URL> --code-file <0600 文件> [--project <本机项目>] [--task <任务>] [--expires-at <ms|ISO>] [--note <一句话>]`
 * Hands a shared-ledger join code to a configured HTTP peer's bridge (POST /api/v1/shared-ledger-join-offer) with our outbound
 * peer token. The code is read from a 0600 file only — never argv, never stdout — and goes out only inside that one request body.
 * "accepted" means the peer retained it in memory and asked its owner; the joined / declined / expired / failed receipt lands later as a
 * ledger note in --project (default: the calling agent's project).
 */
import { randomBytes } from "node:crypto";
import { signedFor } from "../lib/instance-key.js";
import { readProjects } from "../lib/projects.js";
import { readRegistryAgents } from "../lib/registry.js";
import { STATE_DIR } from "../lib/paths.js";
import { findHttpPeer, type HttpPeer } from "../lib/peers.js";
import { looksLikeSharedLedgerJoinCode, parseSharedLedgerJoinCode, SharedLedgerJoinError } from "../lib/shared-ledger-join.js";
import { centerOfferUrl, JOIN_OFFER_MAX_TTL_MS, JOIN_OFFER_PATH, joinOfferProjectDisplay, saveSentOffer } from "../lib/shared-ledger-join-offer.js";
import { output } from "./core.js";
import { peerCliFetch, peerE2eOnlyFetch } from "./relay.js";
import { readJoinCodeFile } from "./shared-ledger-join-cmd.js";

const USAGE = "usage: shared-ledger-offer --peer <peer 名> --url <中心根 URL> --code-file <0600 文件> [--project <本机项目>] [--task <任务>] "
  + "[--expires-at <毫秒时间戳|ISO>] [--note <一句来源说明>] [--team <团队> --shared-project <中心项目> --name <显示名>]（入组码只从 0600 文件读）";
const VALUED = new Set(["peer", "url", "code-file", "project", "task", "expires-at", "note", "team", "shared-project", "name"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_NOTE = "共享台账入组邀请";

export function parseOfferArgs(args: string[]): Record<string, string> | string {
  if (args.some(looksLikeSharedLedgerJoinCode)) return "入组码不能放在命令行参数里：写进 0600 文件，用 --code-file 传路径";
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!.startsWith("--") ? args[i]!.slice(2) : "";
    if (!VALUED.has(name) || args[i + 1] === undefined || flags[name] !== undefined) return USAGE;
    flags[name] = args[++i]!;
  }
  return flags.peer && flags.url && flags["code-file"] ? flags : USAGE;
}

function expiresAtOf(raw: string | undefined, now: number): number | string {
  if (raw === undefined) return now + JOIN_OFFER_MAX_TTL_MS;
  const t = /^\d{10,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isSafeInteger(t) && t > now ? Math.min(t, now + JOIN_OFFER_MAX_TTL_MS) : "--expires-at 要是未来的时间（毫秒时间戳或 ISO）";
}

/** Where the receipt is recorded: --project, else the calling agent's project; it must exist in projects.json. */
async function receiptProject(flag: string | undefined, d: OfferDeps): Promise<string> {
  const id = flag ?? (await d.callerProject());
  if (!id) throw new Error("要带 --project <本机项目>：回执写进这个项目的台账（你不属于任何项目，推不出默认值）");
  if (!(await d.projectExists(id))) throw new Error(`projects.json 里没有项目 ${id}`);
  return id;
}

/** The code may only leave over an encrypted hop: an E2E peer, or an https base URL. */
function peerProblem(peer: HttpPeer | null, name: string): string | null {
  if (!peer) return `HTTP peer "${name}" 不存在或已禁用`;
  if (!peer.baseUrl || !peer.outToken) return `${name} 握手未完成（缺对方地址或出站凭据）`;
  return peer.e2e || peer.baseUrl.startsWith("https://") ? null : `${name} 既不是端到端加密的 peer，地址也不是 https：入组码不走明文`;
}

export interface OfferDeps {
  stateDir: string; now: number;
  findPeer: (name: string) => Promise<HttpPeer | null>;
  callerProject: () => Promise<string | undefined>;
  projectExists: (id: string) => Promise<boolean>;
  post: (peer: HttpPeer, url: string, body: string) => Promise<Response>;
}
const live = (): OfferDeps => ({
  stateDir: STATE_DIR, now: Date.now(), findPeer: findHttpPeer,
  callerProject: async () => {
    const ch = process.env.DISCORD_CHANNEL_ID;
    return ch ? (await readRegistryAgents()).find((a) => a.channelId === ch)?.projectId : undefined;
  },
  projectExists: async (id) => (await readProjects()).projects.some((p) => p.id === id),
  post: (peer, url, body) => {
    const headers = { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) };
    const init = { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) };
    return peer.e2e ? peerE2eOnlyFetch(url, init) : peerCliFetch(url, init);
  },
});

/** The center-to-peer path calls this with an in-memory code; the CLI file reader is only an operational fallback. */
export async function sendSharedLedgerOffer(flags: Record<string, string>, code: string, d: OfferDeps): Promise<Record<string, unknown>> {
  const hasProject = [flags.team, flags["shared-project"], flags.name].some(v => v !== undefined);
  const sharedProject = hasProject ? joinOfferProjectDisplay({ teamId: flags.team, projectId: flags["shared-project"], name: flags.name }) : undefined;
  if (sharedProject) return { ok: false, error: "项目邀请需要已核验的中心 invite；请通过本人项目邀请接口发送" };
  if (sharedProject === null) return { ok: false, error: "团队项目信息不完整或不合法" };
  const center = centerOfferUrl(flags.url);
  if (!center) return { ok: false, error: "--url 要是中心根地址：https://<主机名>/（不带路径、查询、账号）" };
  const expiresAt = expiresAtOf(flags["expires-at"], d.now);
  if (typeof expiresAt === "string") return { ok: false, error: expiresAt };
  if (flags.task !== undefined && !ID_RE.test(flags.task)) return { ok: false, error: "--task 不是合法的任务 id" };
  const note = flags.note ?? DEFAULT_NOTE;
  if (Array.from(note).length > 120 || /[\p{Cc}\p{Cf}]/u.test(note) || looksLikeSharedLedgerJoinCode(note)) return { ok: false, error: "--note 只能是一行 120 字以内" };
  const parsed = code === code.trim() ? parseSharedLedgerJoinCode(code) : null;
  if (!parsed) return { ok: false, error: "文件里不是合法的入组码" };
  if (note.includes(parsed.secret)) {
    return { ok: false, error: "邀请显示字段不能包含入组码" };
  }
  const peer = await d.findPeer(flags.peer!);
  const bad = peerProblem(peer, flags.peer!);
  if (bad) return { ok: false, error: bad };
  const project = await receiptProject(flags.project, d);
  const offerId = randomBytes(16).toString("hex");
  const sent = { offerId, peer: peer!.name, host: center.host, centerId: parsed.centerId, project, target: flags.task ?? "", sentAt: d.now, expiresAt };
  await saveSentOffer(d.stateDir, sent); // Before sending: a fast receipt must find it.
  const body = JSON.stringify({ v: 1, offerId, url: center.url, code, note, expiresAt });
  let res: Response;
  try {
    res = await d.post(peer!, `${peer!.baseUrl!.replace(/\/+$/, "")}${JOIN_OFFER_PATH}`, body);
  } catch {
    return { ok: false, offerId, error: `发给 ${peer!.name} 失败（网络 / 中继），对方是否收到不明；可以重发一次` }; // Transport errors may echo the request.
  }
  const reply = (await res.json().catch(() => null)) as { code?: unknown } | null; // Non-JSON = peer predates this route; status says enough.
  const why = typeof reply?.code === "string" && /^[a-z_]{1,40}$/.test(reply.code) ? reply.code : undefined;
  if (res.status !== 202) return { ok: false, offerId, status: res.status, ...(why ? { code: why } : {}), error: `${peer!.name} 没收下（HTTP ${res.status}）` };
  return { ok: true, offerId, peer: peer!.name, centerHost: center.host, centerId: parsed.centerId, accepted: true, joined: false, receiptProject: project,
    note: "对方已收下并请其 owner 点卡确认；收下 ≠ 已入组，结果会以回执写进本机台账" };
}

export async function cmdSharedLedgerOffer(args: string[], deps: Partial<OfferDeps> = {}): Promise<void> {
  const flags = parseOfferArgs(args);
  if (typeof flags === "string") return output({ ok: false, error: flags });
  try {
    output(await sendSharedLedgerOffer(flags, readJoinCodeFile(flags["code-file"]!).trim(), { ...live(), ...deps }));
  } catch (e) {
    // Only fixed or self-written messages leave: arbitrary errors could quote the code file's content.
    const own = e instanceof SharedLedgerJoinError || (e instanceof Error && /^(要带 --project|projects\.json 里没有项目)/.test(e.message));
    output({ ok: false, error: own ? (e as Error).message : "shared ledger offer failed" });
  }
}

