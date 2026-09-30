/**
 * 本机 AI 能力清单（T91，阶段 4 R0）：装了哪些 agent 运行时、每个实际接哪家哪个模型、订阅额度还剩多少。
 * 给三处用：出借声明取数、远端交结论时附身份、网页一眼看全（`manager ai-inventory`、doctor 一行、GET /api/v1/ai-inventory）。
 * 全程只读：探测复用 login-binary / claude-binary / codex-launch，接口判定在 ai-endpoints，模型证据在 ai-model-evidence，
 * 额度在 ai-quota。凭据文件（~/.codex/auth.json、~/.pi/agent/auth.json、.env）与 Keychain 一律不打开。
 * env 一栏是**当前进程**的：CLI 从终端 / agent 里跑是那个 shell 的，API 走 bridge（launchd）的，两边可能不同，所以每条来源都标出处。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyClaudeEndpoint, classifyCodexEndpoint, classifyPiEndpoint, pickClaudeKeys, type ClaudeConfigLayer, type EndpointVerdict,
} from "./ai-endpoints.js";
import { collectModelEvidence, EVIDENCE_LIMIT, type EvidenceRuntime, type ModelEvidence } from "./ai-model-evidence.js";
import { readInventoryQuota, unknownQuota, type InventoryQuota } from "./ai-quota.js";
import { classifyClaudeInstall, probeClaudeVersion } from "./claude-binary.js";
import { resolveCodexBinary } from "./codex-launch.js";
import { defaultRunner } from "./codex-thread.js";
import { isNpmGlobalCodex } from "./codex-version.js";
import { resolveLoginBinary, type LoginBinary, type Runner } from "./login-binary.js";
import { piBinName } from "./pi-env.js";
import { piAgentDir } from "./pi-session.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";

export interface RuntimeInventory {
  id: EvidenceRuntime;
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  /** brew / npm / native / unknown（只对认得出的安装方式归类） */
  install: string | null;
  endpoint: EndpointVerdict;
  quota: InventoryQuota;
  /** 不收集时（doctor）为 null */
  evidence: ModelEvidence | null;
}

export interface AiInventory {
  generatedAt: number;
  runtimes: RuntimeInventory[];
}

// ── 配置读取（只读；解析整份文件，但只挑字段） ─────────────────────────────

type Json = Record<string, unknown>;

/** undefined = 文件不存在；null = 在但读不了 / 解析不了 */
function readJsonFile(path: string): Json | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null; // 写坏了：调用方把这个来源判成「未知」，不当官方
  }
}

const claudeConfigDir = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const MANAGED_SETTINGS = process.platform === "darwin"
  ? "/Library/Application Support/ClaudeCode/managed-settings.json"
  : "/etc/claude-code/managed-settings.json";

/** 一份 settings 文件 → 一层；不存在 = null；解析不了 = env null（判未知）；只拷判定用的键 */
function fileLayer(from: string, path: string): ClaudeConfigLayer | null {
  const j = readJsonFile(path);
  if (j === undefined) return null;
  return j === null ? { from, env: null } : { from, env: pickClaudeKeys(j.env && typeof j.env === "object" ? (j.env as Json) : {}), model: j.model };
}

type AgentDir = Pick<RegistryAgent, "name" | "cwd" | "runtime">;

/**
 * 在册 Claude Code agent 工作目录下的项目级 settings：CC 按 cwd 读它们，里面的 env 同样能把某个 agent 指到第三方。
 * 只收有线索的层（写了源 / 模型，或解析不了）；家目录跳过（那里的 .claude/settings.json 就是用户级那份）。
 */
export function projectLayers(agents: AgentDir[], home = homedir()): ClaudeConfigLayer[] {
  const seen = new Set<string>([resolve(home)]);
  const out: ClaudeConfigLayer[] = [];
  for (const a of agents) {
    if ((a.runtime && a.runtime !== "claude-code") || !a.cwd || seen.has(resolve(a.cwd))) continue;
    seen.add(resolve(a.cwd));
    for (const f of ["settings.json", "settings.local.json"]) {
      const l = fileLayer(`${a.name} .claude/${f}`, join(a.cwd, ".claude", f));
      if (l && (l.env === null || Object.keys(l.env).length || l.model !== undefined)) out.push(l);
    }
  }
  return out;
}

/** 企业托管 > 用户 settings > 各 agent 的项目 settings > 当前进程 env（顺序只影响列出来的先后，判定是「任一非官方即第三方」） */
export function claudeLayers(env: NodeJS.ProcessEnv = process.env, agents: AgentDir[] = []): ClaudeConfigLayer[] {
  const layers = [fileLayer("managed-settings.json", MANAGED_SETTINGS), fileLayer("~/.claude/settings.json", join(claudeConfigDir(env), "settings.json"))]
    .filter((l): l is ClaudeConfigLayer => l !== null);
  layers.push(...projectLayers(agents), { from: "当前进程 env", env: pickClaudeKeys(env) });
  return layers;
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return join(home ? resolve(home) : join(homedir(), ".codex"), "config.toml");
}

function readCodexToml(path: string): Json | null | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return null; // 写坏了：判「未知」
  }
}

function piEndpoint(): EndpointVerdict {
  const dir = piAgentDir();
  const settings = readJsonFile(join(dir, "settings.json")) ?? null;
  const models = readJsonFile(join(dir, "models.json"));
  const providers = models?.providers && typeof models.providers === "object" ? Object.keys(models.providers as Json) : [];
  return classifyPiEndpoint(settings, providers.filter((p) => /^[\w.-]{1,64}$/.test(p)));
}

// ── 运行时探测 ───────────────────────────────────────────────────────────

interface Probe {
  found: LoginBinary | null;
  version: string | null;
  install: string | null;
}

async function probe(run: Runner, find: () => Promise<LoginBinary | null>, install: (real: string) => string | null): Promise<Probe> {
  const found = await find().catch((e) => (console.error("[ai-inventory] 定位可执行文件失败:", (e as Error).message), null));
  if (!found) return { found: null, version: null, install: null };
  return { found, version: await probeClaudeVersion(run, found.real, 15_000), install: install(found.real) };
}

export function probeRuntimes(run: Runner = defaultRunner): Promise<Record<EvidenceRuntime, Probe>> {
  const pi = piBinName();
  return Promise.all([
    probe(run, () => resolveLoginBinary(run, "claude"), (r) => classifyClaudeInstall(r).kind),
    probe(run, () => resolveCodexBinary(run), (r) => (isNpmGlobalCodex(r) ? "npm" : "unknown")),
    probe(run, () => (pi.includes("/") ? Promise.resolve(existsSync(pi) ? { link: pi, real: pi } : null) : resolveLoginBinary(run, pi)), () => null),
  ]).then(([cc, codex, p]) => ({ "claude-code": cc, codex, pi: p }));
}

const NAMES: Record<EvidenceRuntime, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };

export async function collectAiInventory(opts: { evidence?: boolean; quota?: boolean; limit?: number } = {}): Promise<AiInventory> {
  const [probes, quota, evidence] = await Promise.all([
    probeRuntimes(),
    opts.quota === false ? null : readInventoryQuota(),
    opts.evidence === false ? null : collectModelEvidence(opts.limit ?? EVIDENCE_LIMIT),
  ]);
  const endpoints: Record<EvidenceRuntime, EndpointVerdict> = {
    "claude-code": classifyClaudeEndpoint(claudeLayers(process.env, readRegistryAgentsSync())),
    codex: classifyCodexEndpoint(readCodexToml(codexConfigPath()), { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }),
    pi: piEndpoint(),
  };
  const quotaOf = (id: EvidenceRuntime): InventoryQuota => {
    if (id === "pi") return unknownQuota("Pi 的接入商额度不在清单范围（按量计费的用量见额度看板）");
    if (!quota) return unknownQuota("本次未读取额度");
    return quota[id === "claude-code" ? "claude" : "codex"];
  };
  const runtimes = (["claude-code", "codex", "pi"] as const).map((id): RuntimeInventory => ({
    id,
    name: NAMES[id],
    installed: !!probes[id].found,
    version: probes[id].version,
    path: probes[id].found?.real ?? null,
    install: probes[id].install,
    endpoint: endpoints[id],
    quota: quotaOf(id),
    evidence: evidence?.[id] ?? null,
  }));
  return { generatedAt: Date.now(), runtimes };
}
