import { basename, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { readJsonState } from "./state-file.js";
import { readRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import type { Principal } from "./principals.js";
import type { HttpPeer } from "./peers.js";
import type { TeamProposal } from "./team-proposal.js";
import type { CronJob } from "./cron-job.js";
import { bridgeRequest } from "./bridge-client.js";

export interface PmState {
  agents: RegistryAgent[];
  principals: Principal[];
  peers: HttpPeer[];
  peerPrs: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  proposals: Record<string, TeamProposal>;
  cron: CronJob[];
}

async function json(path: string, fallback: unknown): Promise<any> {
  const r = await readJsonState(path);
  if (r.status === "corrupt") throw new Error(`cannot read ${path}`);
  return r.status === "ok" ? r.data : fallback;
}

/** Strict reads: a broken authorization file must never become an empty preflight. */
export async function readPmState(dir = STATE_DIR): Promise<PmState> {
  const [agents, principals, peers, peerPrs, config, proposals, cron] = await Promise.all([
    readRegistryAgents(join(dir, basename(REGISTRY_PATH))), json(join(dir, "principals.json"), { principals: [] }),
    json(join(dir, "peers.json"), { httpPeers: [] }), json(join(dir, "peer-prs.json"), null),
    json(join(dir, "config.json"), null), json(join(dir, "team-proposals.json"), {}), json(join(dir, "cron.json"), { jobs: [] }),
  ]);
  if (!Array.isArray(principals?.principals) || !Array.isArray(peers?.httpPeers ?? [])) throw new Error("invalid PM authorization state");
  return { agents, principals: principals.principals, peers: peers.httpPeers ?? [], peerPrs, config, proposals,
    cron: Array.isArray(cron) ? cron : cron.jobs ?? [] };
}

export async function onlinePmAgents(): Promise<Set<string>> {
  const r = await bridgeRequest({ type: "project_info" });
  const projects = r.projects ?? (r.project ? [r.project] : []);
  return new Set(projects.flatMap((p: { members: { name: string; online: boolean }[] }) => p.members.filter((a) => a.online).map((a) => a.name)));
}

/** Only identity literals change; text, patterns and unrelated config remain byte-for-byte equivalent values. */
export function replacePmRefs(value: unknown, before: string[], after: string): unknown {
  if (typeof value === "string") {
    for (const from of before) {
      if (value === from) return after;
      if (value === from.replace(/^agent-/, "")) return after.replace(/^agent-/, "");
      if (value.startsWith(`${from}@`)) return `${after}${value.slice(from.length)}`;
      const bare = from.replace(/^agent-/, "");
      if (value.startsWith(`${bare}@`)) return `${after.replace(/^agent-/, "")}${value.slice(bare.length)}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => replacePmRefs(v, before, after));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replacePmRefs(v, before, after)]));
  return value;
}

function pmRefEntries(value: unknown, prefix: string): { location: string; agent: string }[] {
  if (typeof value === "string") return [{ location: prefix, agent: value.split("@")[0]! }];
  if (Array.isArray(value)) return value.flatMap((v, i) => pmRefEntries(v, `${prefix}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => pmRefEntries(v, `${prefix}.${k}`));
  return [];
}


function compactNameLists(value: unknown, prefix: string, visit: (value: unknown, location: string) => unknown): unknown {
  if (Array.isArray(value)) return value.map((v, i) => compactNameLists(v, `${prefix}[${i}]`, visit));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    k === "names" || k === "agents" ? visit(v, `${prefix}.${k}`) : compactNameLists(v, `${prefix}.${k}`, visit)]));
}

export function pmCompactRefs(value: unknown) {
  const entries: { location: string; agent: string }[] = [];
  compactNameLists(value, "config.autoCompact", (v, location) => { entries.push(...pmRefEntries(v, location)); return v; });
  return entries;
}

export function replaceCompactPmRefs(value: unknown, before: string[], after: string): unknown {
  return compactNameLists(value, "config.autoCompact", (v) => replacePmRefs(v, before, after));
}
