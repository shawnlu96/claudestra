/**
 * 隔离矩阵里的一台临时实例：所有文件都在调用方给的临时 base 下，切换走各前卡的真实库——
 *   state    migrateState / rollbackState（STATE1/2），真实文件系统、真实事务日志；
 *   runtime  applyRuntimeAlias / rollbackRuntimeAlias（RUNTIME1），socket 是普通文件，server 是一张「文件标识 → server」表；
 *   services runServicePlan（SERVICEPLAN1）配本文件的假控制器，四个 daemon 每一刻最多一个活着的写者；
 *   mcp      selectMcpName + 会话族记录（MCP1），记录落在状态根里，随根迁移与回滚。
 * 不连 tmux、不碰 launchd、不读写真实状态目录。
 */
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceKey } from "../../../src/lib/instance-key.ts";
import { stateDirIn } from "../../../src/lib/state-dir.ts";
import { nodeStateFs } from "../../../src/lib/floka-migration/state/fs-adapter.ts";
import { readIdentity, inspectLayout } from "../../../src/lib/floka-migration/state/layout.ts";
import { migrateState, rollbackState } from "../../../src/lib/floka-migration/state/migrate.ts";
import type { StateFs } from "../../../src/lib/floka-migration/state/types.ts";
import { nodeAliasFs } from "../../../src/lib/floka-migration/runtime/adapters.ts";
import { applyRuntimeAlias, rollbackRuntimeAlias } from "../../../src/lib/floka-migration/runtime/alias.ts";
import type { RuntimeAliasInput } from "../../../src/lib/floka-migration/runtime/types.ts";
import { createServicePlan, runServicePlan } from "../../../src/lib/floka-services/plan/index.ts";
import type { Controller, Journal, ServicePlan, Service, Side, State } from "../../../src/lib/floka-services/plan/types.ts";
import { readSessionFamily, writeSessionFamily } from "../../../src/lib/floka-mcp/store.ts";
import { selectMcpName, type McpChoice } from "../../../src/lib/floka-mcp/select.ts";
import { closeWebState, openWebState } from "../../../src/lib/web-state.ts";
import { listPushSubscriptions, savePushSubscription, type PushSubscriptionRow } from "../../../src/lib/push-store.ts";
import { PART_KEYS, type CutPart } from "./rollout.ts";

const SOCK = "fixture-server.sock";
/** 迁移前就存在、没有族记录的老会话：任何档位下续接都必须是旧族 */
export const OLD_SESSION = "0a0a0a0a-0000-4000-8000-000000000001";

/** 单写者假控制器：每个 daemon 的旧 / 新两侧共享一个进程表，任何时刻同时活着的写者都记进 maxLive */
class FakeServices implements Controller {
  journal: Journal | null = null;
  live = new Map<string, number[]>();
  loaded = new Set<string>();
  maxLive = 0;
  healthy = true;
  private pid = 1000;
  constructor(readonly plan: ServicePlan) {
    for (const d of plan.services) this.start(d, "old");
  }
  private start(d: Service, side: Side) {
    this.loaded.add(`${side}:${d.name}`);
    this.live.set(`${side}:${d.name}`, [++this.pid]);
    this.maxLive = Math.max(this.maxLive, ...this.plan.services.map((s) => this.writers(s.name)));
  }
  writers(name: string): number {
    return (this.live.get(`old:${name}`)?.length ?? 0) + (this.live.get(`new:${name}`)?.length ?? 0);
  }
  /** 当前提供服务的一侧：只有一侧活着才算 */
  side(): Side | "mixed" {
    const sides = new Set(this.plan.services.flatMap((d) => (["old", "new"] as Side[]).filter((s) => this.live.get(`${s}:${d.name}`)?.length)));
    return sides.size === 1 ? [...sides][0]! : "mixed";
  }
  async withLock<T>(_key: string, run: (lease: { assertHeld(): void }) => Promise<T>): Promise<T> {
    return run({ assertHeld: () => {} });
  }
  async readJournal() { return structuredClone(this.journal); }
  async saveJournal(j: Journal) { this.journal = structuredClone(j); }
  async auditLegacy(plan: ServicePlan) {
    return Object.fromEntries(plan.legacyLabels.map((l) => [l, { loaded: false, pids: [], restartDisabled: true }]));
  }
  async inspect(_p: ServicePlan, d: Service, side: Side): Promise<State> {
    return { loaded: this.loaded.has(`${side}:${d.name}`), pids: [...(this.live.get(`${side}:${d.name}`) ?? [])] };
  }
  async prepare() {}
  async restoreOld() {}
  async unload(_p: ServicePlan, d: Service, side: Side) {
    this.loaded.delete(`${side}:${d.name}`);
    this.live.set(`${side}:${d.name}`, []);
  }
  async waitExited(_p: ServicePlan, d: Service, side: Side) { return !this.live.get(`${side}:${d.name}`)?.length; }
  async load(_p: ServicePlan, d: Service, side: Side) { this.start(d, side); }
  async health(_p: ServicePlan, d: Service, side: Side) { return this.healthy && this.live.get(`${side}:${d.name}`)?.length === 1; }
  async commit() {}
}

export interface MixedInstance {
  name: string;
  instanceId: string;
  key: InstanceKey;
  base: string;
  home: string;
  oldRoot: string;
  newRoot: string;
  journal: string;
  runtime: { current: string; alias: string };
  /** 外部配置（~/.claude/settings.json 一类）：在状态根之外，迁移与回滚都不许碰 */
  settings: string;
  services: FakeServices;
  /** 维护窗口外的写者；切 state 前由矩阵清空（STATE2 的停写由 runner 证明，这里如实模拟） */
  writers: string[];
  /** socket 文件标识 → server 标识 */
  servers: Map<string, string>;
  /** 故障注入：本实例下一次切这些分项时失败 */
  faults: Set<CutPart>;
  /** 已切完的分项（回滚按逆序） */
  done: CutPart[];
  rename: Record<string, unknown>;
  seq: number;
}

const fileId = (p: string): string => { const s = statSync(p); return `${s.dev}:${s.ino}`; };

/** 状态根：身份、peer 台账与旧邀请、任务台账、Web 状态库（推送订阅）、VAPID 钥匙 */
function seedRoot(root: string, i: { instanceId: string; pem: string; name: string }): void {
  mkdirSync(join(root, "ledger", "tasks"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "instance-id"), `${i.instanceId}\n`, { mode: 0o600 });
  writeFileSync(join(root, "instance-key.pem"), i.pem, { mode: 0o600 });
  writeFileSync(join(root, "peers.json"), JSON.stringify({ httpPeers: [{ name: "synthetic", baseUrl: "https://peer.invalid", outToken: `tok-${i.name}` }] }), { mode: 0o600 });
  // 迁移前发出、还没兑现的邀请：原样保留，不重签不重发
  writeFileSync(join(root, "pending-invites.json"), JSON.stringify([{ id: `inv-${i.name}`, joinSecret: `join-${i.name}`, url: "https://invite.invalid" }]), { mode: 0o600 });
  writeFileSync(join(root, "ledger", "tasks", "t1.json"), JSON.stringify({ id: "t1", owner: i.name }), { mode: 0o600 });
  writeFileSync(join(root, "push-vapid.json"), JSON.stringify({ publicKey: `vapid-pub-${i.name}`, privateKey: `vapid-priv-${i.name}` }), { mode: 0o600 });
  mkdirSync(join(root, "web"), { mode: 0o700 });
  const db = join(root, "web", "state.db");
  const conn = openWebState(db);
  savePushSubscription(conn, { endpoint: `https://push.invalid/${i.name}`, keys: { p256dh: "p256", auth: "auth" } }, "fixture-ua", `vapid-pub-${i.name}`);
  closeWebState(db);
}

export function createInstance(base: string, name: string, n: number): MixedInstance {
  const home = join(base, name, "home");
  mkdirSync(home, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const key: InstanceKey = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
  const pem = String(privateKey.export({ format: "pem", type: "pkcs8" }));
  const instanceId = `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`;
  const oldRoot = stateDirIn(home);
  seedRoot(oldRoot, { instanceId, pem, name });
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ command: "bun ~/repos/claudestra/src/hooks/stop.ts" }] }, mcpServers: { claudestra: {} } }));
  const run = join(base, name, "run");
  const current = join(run, "claude-runtime");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, SOCK), "fake socket");
  const plan = createServicePlan(`mixed-${name}`, { repoRoot: join(base, name, "repo"), bunPath: "/fixture/bun", home, envPath: "/bin", logDir: join(base, name, "log") });
  const inst: MixedInstance = {
    name, instanceId, key, base, home, oldRoot, newRoot: join(home, ".floka"), journal: join(base, name, "journal"),
    runtime: { current, alias: join(run, "floka") }, settings, services: new FakeServices(plan), writers: [`bridge:${name}`],
    servers: new Map(), faults: new Set(), done: [], rename: {}, seq: 0,
  };
  inst.servers.set(fileId(join(current, SOCK)), `tmux-server:${name}`);
  return inst;
}

/** state 的故障注入：搬根之后建别名时失败，库须补偿搬回 */
function faultyFs(inst: MixedInstance): StateFs {
  if (!inst.faults.has("state")) return nodeStateFs;
  return { ...nodeStateFs, symlink: async () => { throw Object.assign(new Error("injected symlink failure"), { code: "EIO" }); } };
}

const stateOpts = (inst: MixedInstance) => ({
  mode: "on", oldRoot: inst.oldRoot, newRoot: inst.newRoot, home: inst.home, fs: faultyFs(inst),
  writers: { activeWriters: async () => [...inst.writers] }, journalDir: inst.journal, txId: `state-${++inst.seq}`, lockWaitMs: 200,
});

function runtimeInput(inst: MixedInstance): RuntimeAliasInput {
  const flip = inst.faults.has("runtime");
  return {
    mode: "on", currentDir: inst.runtime.current, aliasDir: inst.runtime.alias, socketName: SOCK, fs: nodeAliasFs,
    probe: {
      identify: async (socketPath) => {
        // 故障注入：经别名看到的是另一个 server，库须拒绝并撤掉刚建的别名
        if (flip && socketPath.startsWith(inst.runtime.alias)) return "tmux-server:intruder";
        try { return inst.servers.get(fileId(socketPath)) ?? null; } catch { return null; } // socket 不在 = 查不到
      },
    },
  };
}

/** 切一个分项；返回是否成功与原因。失败时各库已按自身语义补偿 */
export async function cutPart(inst: MixedInstance, part: CutPart): Promise<{ ok: boolean; detail: string }> {
  const r = await applyPart(inst, part);
  if (r.ok) inst.done.push(part);
  return r;
}

async function applyPart(inst: MixedInstance, part: CutPart): Promise<{ ok: boolean; detail: string }> {
  if (part === "state") {
    const r = await migrateState(stateOpts(inst));
    return { ok: r.status === "committed" && r.layout === "migrated", detail: `${r.status}/${r.layout}${r.error ? `: ${r.error}` : ""}` };
  }
  if (part === "runtime") {
    const r = await applyRuntimeAlias(runtimeInput(inst));
    return { ok: r.status === "aliased" || r.status === "already", detail: r.status };
  }
  if (part === "services") {
    inst.services.healthy = !inst.faults.has("services");
    const r = await runServicePlan({ plan: inst.services.plan, controller: inst.services, rename: { services: "on" } });
    if (r.status === "committed") return { ok: true, detail: r.status };
    // 健康检查不过：按 SERVICEPLAN1 回到旧四件，不留半切状态
    inst.services.healthy = true;
    const back = await runServicePlan({ plan: inst.services.plan, controller: inst.services, rename: { services: "on" }, action: "rollback" });
    return { ok: false, detail: `${r.status} → ${back.status}` };
  }
  if (part === "mcp") inst.rename.mcp = PART_KEYS.mcp.mcp;
  else inst.rename = { ...inst.rename, ...PART_KEYS.receive };
  return { ok: true, detail: "gear" };
}

/** 按已切分项的逆序整机回滚 */
export async function rollbackAll(inst: MixedInstance): Promise<string[]> {
  const out: string[] = [];
  for (const part of [...inst.done].reverse()) {
    if (part === "state") {
      const r = await rollbackState(stateOpts(inst));
      out.push(`state:${r.status}/${r.layout}`);
    } else if (part === "runtime") {
      out.push(`runtime:${(await rollbackRuntimeAlias(runtimeInput(inst))).status}`);
    } else if (part === "services") {
      out.push(`services:${(await runServicePlan({ plan: inst.services.plan, controller: inst.services, rename: { services: "on" }, action: "rollback" })).status}`);
    } else if (part === "mcp") {
      delete inst.rename.mcp;
      out.push("mcp:off");
    } else {
      inst.rename = {};
      out.push("receive:off");
    }
  }
  inst.done = [];
  return out;
}

/** 现在的数据根（迁移后旧路径是别名，两条路径都能读） */
export const dataRoot = (inst: MixedInstance): string => inst.oldRoot;

/** 一次 agent 启动选哪个 MCP 名；新族会话的记录写进状态根 */
export function launchMcp(inst: MixedInstance, kind: "new" | "resume", sessionId: string): McpChoice {
  const root = join(dataRoot(inst), "mcp-family");
  const mode = inst.rename.mcp === "on" ? "on" : "off";
  const c = selectMcpName({ mode, explicit: null, kind, sessionId, stored: kind === "resume" ? readSessionFamily(sessionId, root) : null });
  if (c.recordSession) writeSessionFamily(c.recordSession.sessionId, c.recordSession.family, "mixed", root);
  return c;
}

/** 迁移后新增的任务：写进当前数据根 */
export function addTask(inst: MixedInstance, id: string): void {
  writeFileSync(join(dataRoot(inst), "ledger", "tasks", `${id}.json`), JSON.stringify({ id, owner: inst.name }), { mode: 0o600 });
}

export const tasks = (inst: MixedInstance): string[] => readdirSync(join(dataRoot(inst), "ledger", "tasks")).sort();

export function pushRows(inst: MixedInstance): PushSubscriptionRow[] {
  const path = join(dataRoot(inst), "web", "state.db");
  const rows = listPushSubscriptions(openWebState(path));
  closeWebState(path);
  return rows;
}

/** 需要原样保留的东西：身份、peer、旧邀请、VAPID、外部配置的字节摘要 */
export function contracts(inst: MixedInstance): Record<string, string> {
  const sum = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
  const root = dataRoot(inst);
  return Object.fromEntries([
    ...["instance-id", "instance-key.pem", "peers.json", "pending-invites.json", "push-vapid.json"].map((f) => [f, sum(join(root, f))]),
    ["external:settings.json", sum(inst.settings)],
  ]);
}

export async function identitySum(inst: MixedInstance): Promise<string> {
  const id = await readIdentity(nodeStateFs, dataRoot(inst));
  return id.ok ? id.sum : `bad:${id.problem}`;
}

export const layoutOf = async (inst: MixedInstance): Promise<string> => (await inspectLayout(nodeStateFs, inst.oldRoot, inst.newRoot)).kind;

/** 两条 runtime 路径各自看到的 server；别名不在则只有现路径 */
export async function serversSeen(inst: MixedInstance): Promise<string[]> {
  const probe = runtimeInput({ ...inst, faults: new Set() }).probe;
  const paths = [inst.runtime.current, inst.runtime.alias].map((d) => join(d, SOCK));
  const seen = await Promise.all(paths.map((p) => probe.identify(p)));
  return seen.filter((s): s is string => s !== null);
}
