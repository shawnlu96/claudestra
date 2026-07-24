/**
 * v2.7+ SessionsInventory —— Claude Code agents 模式的中性会话清单
 * （设计 docs/design-multi-frontend.md 的延伸：管理面也 transport 解耦）。
 *
 * 聚合三个数据源，输出不含任何 Discord 概念的 NeutralSessionInfo[]：
 *   1. `claude agents --json`（官方脚本接口）—— 全机器 interactive + background 会话
 *   2. `~/.claude/jobs/<id>/state.json` —— background job 的 intent/detail/tokens 补充
 *   3. `~/.claude-orchestrator/registry.json` —— 对账：哪些是 Claudestra 正式 agent
 *
 * 分身（doppelganger）判定：background 会话的 sessionId 不属于任何正式 agent，
 * 但 name 或 cwd 与某正式 agent 重合 —— 典型来源是 agents 视图误触把正式 agent
 * 的会话 fork 派发成了 bg job（2026-07-09 事故）。检出后由消费端决定处置：
 * 清理（死分身）或收编替换（活分身，上下文比正式 agent 新）。
 *
 * 消费端：HTTP GET /api/v1/sessions、event-bus session_anomaly 告警、
 * Discord /agents 面板 —— 三者共用本模块，Discord 只是渲染器之一。
 */

import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readRegistryAgents } from "../lib/registry.js";

// ============================================================
// 类型
// ============================================================

/** `claude agents --json` 的原始条目（上游 schema，字段宽松处理） */
export interface RawClaudeSession {
  pid?: number;
  cwd?: string;
  kind?: string; // "interactive" | "background"
  startedAt?: number;
  sessionId?: string;
  name?: string;
  status?: string; // interactive: idle/busy/...
  id?: string; // background 短 id（= jobs 目录名）
  state?: string; // background: working/done/blocked/...
}

/** jobs/<id>/state.json 里我们关心的子集 */
export interface JobStateInfo {
  state?: string;
  intent?: string;
  name?: string;
  detail?: string;
  tokens?: number;
  sessionId?: string;
  cwd?: string;
  updatedAt?: string;
}

/** registry.json 单个 agent 的精简视图 */
export interface RegistryAgentLite {
  name: string; // "agent-xxx"
  sessionId?: string;
  cwd?: string;
  status?: string;
  channelId?: string;
  displayName?: string;
}

/** 中性会话信息 —— 不含任何平台概念 */
export interface NeutralSessionInfo {
  kind: "interactive" | "background";
  sessionId: string;
  /** claude 侧的显示名（--name / job name），可能缺失 */
  name?: string;
  cwd?: string;
  pid?: number;
  /** interactive 用 status（idle/busy），background 用 state（working/done/blocked） */
  status: string;
  startedAt?: number;
  /** background job 短 id（jobs 目录名 / 清理与收编操作的键） */
  bgId?: string;
  /** background 补充：任务意图 / 最后状态摘要 / token 用量 */
  intent?: string;
  detail?: string;
  tokens?: number;
  updatedAt?: string;
  /** sessionId 精确命中 registry → 正式 agent 名（"agent-xxx"） */
  registeredAgent?: string;
  /** 分身判定：疑似哪个正式 agent 的 bg 分身 */
  doppelgangerOf?: string;
  doppelgangerReason?: "same-name" | "same-cwd";
}

// ============================================================
// 纯对账逻辑（可测，无 IO）
// ============================================================

/** 展开路径开头的 ~（registry 的 project 字段常用 ~ 写法） */
function expandHome(p: string | undefined, home: string): string | undefined {
  if (!p) return p;
  return p.startsWith("~") ? home + p.slice(1) : p;
}

/** registry 名 "agent-worker" → 短名 "worker"（与 peers/principals 的前缀兼容规则同款） */
function shortName(registryName: string): string {
  return registryName.startsWith("agent-") ? registryName.slice(6) : registryName;
}

export function reconcileSessions(
  raw: RawClaudeSession[],
  jobStates: Map<string, JobStateInfo>,
  registryAgents: RegistryAgentLite[],
  home = homedir(),
): NeutralSessionInfo[] {
  const bySessionId = new Map<string, RegistryAgentLite>();
  for (const a of registryAgents) {
    if (a.sessionId) bySessionId.set(a.sessionId, a);
  }

  const out: NeutralSessionInfo[] = [];
  for (const r of raw) {
    if (!r.sessionId) continue;
    const kind: NeutralSessionInfo["kind"] =
      r.kind === "background" ? "background" : "interactive";
    const job = r.id ? jobStates.get(r.id) : undefined;

    const info: NeutralSessionInfo = {
      kind,
      sessionId: r.sessionId,
      name: r.name ?? job?.name,
      cwd: r.cwd ?? job?.cwd,
      pid: r.pid,
      status: (kind === "background" ? r.state ?? job?.state : r.status) ?? "unknown",
      startedAt: r.startedAt,
      bgId: r.id,
      intent: job?.intent,
      detail: job?.detail,
      tokens: job?.tokens,
      updatedAt: job?.updatedAt,
    };

    const registered = bySessionId.get(r.sessionId);
    if (registered) {
      info.registeredAgent = registered.name;
    } else if (kind === "background") {
      // 分身判定：未注册的 bg 会话，与某正式 agent 同名或同 cwd
      const byName = r.name
        ? registryAgents.find(
            (a) => shortName(a.name) === r.name || a.displayName === r.name,
          )
        : undefined;
      if (byName) {
        info.doppelgangerOf = byName.name;
        info.doppelgangerReason = "same-name";
      } else if (r.cwd) {
        const byCwd = registryAgents.find(
          (a) => expandHome(a.cwd, home) === r.cwd,
        );
        if (byCwd) {
          info.doppelgangerOf = byCwd.name;
          info.doppelgangerReason = "same-cwd";
        }
      }
    }
    out.push(info);
  }
  return out;
}

/** 清单里的分身（消费端快捷过滤） */
export function doppelgangers(list: NeutralSessionInfo[]): NeutralSessionInfo[] {
  return list.filter((s) => s.doppelgangerOf);
}

// ============================================================
// IO 层
// ============================================================

const DEFAULT_JOBS_DIR = join(homedir(), ".claude", "jobs");
const DEFAULT_REGISTRY = join(homedir(), ".claude-orchestrator", "registry.json");

/** claude 可执行文件候选（launchd 环境 PATH 可能不含 homebrew） */
const CLAUDE_BIN_CANDIDATES = ["claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

/** 跑 `claude agents --json`。失败返回 null（上游不可用时清单退化为空，不炸 bridge）。 */
export async function runClaudeAgentsJson(): Promise<RawClaudeSession[] | null> {
  for (const bin of CLAUDE_BIN_CANDIDATES) {
    try {
      const proc = Bun.spawn([bin, "agents", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      // 15s 超时强杀:claude 二进制坏掉时(2026-07-24 cask 升级后签名评估挂死,
      // 连 --version 都永久 hang)本函数每 10min 被 reconciler 调一次,无超时
      // 就每轮堆积一个僵尸进程(实测堆了 30+)。正常执行 <2s,15s 足够宽。
      const killer = setTimeout(() => {
        try { proc.kill(9); } catch { /* 已退出 */ }
      }, 15_000);
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      clearTimeout(killer);
      if (code !== 0) continue;
      const arr = JSON.parse(out);
      return Array.isArray(arr) ? arr : null;
    } catch {
      continue; // ENOENT / 解析失败 / 超时被杀 → 下一个候选
    }
  }
  return null;
}

/** 扫 jobs 目录读全部 state.json（单个坏文件跳过） */
export async function readJobStates(jobsDir = DEFAULT_JOBS_DIR): Promise<Map<string, JobStateInfo>> {
  const map = new Map<string, JobStateInfo>();
  try {
    if (!existsSync(jobsDir)) return map;
    for (const entry of await readdir(jobsDir)) {
      const statePath = join(jobsDir, entry, "state.json");
      try {
        if (!existsSync(statePath)) continue;
        const data = JSON.parse(await readFile(statePath, "utf-8"));
        map.set(entry, {
          state: data.state,
          intent: data.intent,
          name: data.name,
          detail: typeof data.detail === "string" ? data.detail.slice(0, 500) : undefined,
          tokens: data.tokens,
          sessionId: data.sessionId,
          cwd: data.cwd,
          updatedAt: data.updatedAt,
        });
      } catch {
        /* 单个 job 坏了不影响其他 */
      }
    }
  } catch {
    /* jobs 目录不可读 → 空 map */
  }
  return map;
}

/** registry.json → RegistryAgentLite[]（读失败返回空数组）。v2.9+ 委托 lib/registry 单点解析。 */
export async function readRegistryLite(registryPath = DEFAULT_REGISTRY): Promise<RegistryAgentLite[]> {
  return (await readRegistryAgents(registryPath)).map(({ name, sessionId, cwd, status, channelId, displayName }) => ({
    name, sessionId, cwd, status, channelId, displayName,
  }));
}

/**
 * 一站式采集：agents --json + jobs state + registry 对账。
 * 上游 CLI 不可用时返回 null（调用方据此区分「无会话」与「采集失败」）。
 */
export async function collectSessions(opts?: {
  jobsDir?: string;
  registryPath?: string;
}): Promise<NeutralSessionInfo[] | null> {
  const raw = await runClaudeAgentsJson();
  if (raw === null) return null;
  const [jobStates, registry] = await Promise.all([
    readJobStates(opts?.jobsDir),
    readRegistryLite(opts?.registryPath),
  ]);
  return reconcileSessions(raw, jobStates, registry);
}
