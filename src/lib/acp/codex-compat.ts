/**
 * 自研 Codex 适配器能配哪个 Codex：按 app-server 协议判，不看上游 codex-acp 的 semver 声明。
 * 目标 Codex 现场生成的 schema 锁和已提交的锁（适配器验证过的那版）走漂移分级（codex-compat-drift.ts）：
 * 红 = 不兼容；黄 / 候选 / 没变 = 兼容（黄的差异列进原因，要过真实组合验证）；生成失败 = 未知，调用方按拦处理。
 * 组合身份 = 适配器源码指纹 + Codex 版本 + schema 全量指纹，任一变了就是一个没验证过的组合。tests/codex-compat.test.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shellEscape } from "../claude-launch.js";
import { nativeCodexCandidates } from "../codex-launch.js";
import { CODEX_ACP_ADAPTER_MAIN } from "./codex-adapter/main.js";
import { classify, type LockSet } from "./codex-compat-drift.js";
import { generateLockSet, readLockSet } from "./codex-compat-lock.js";
import { AdapterPick, adapterFor, readAdapterChoice, type CodexAdapterId } from "./codex-compat-switch.js";

/**
 * 选中的 Codex 适配器（选择开关 codex-compat-switch.ts）：给 agent 就看它的覆盖，不给就是全局。
 * readiness、更新闸、宿主、doctor 都只认这里；手工覆盖 / 沙箱 / 出借 worker 的特例在 adapter-proc.ts。
 */
export function selectedCodexAdapter(agent?: string, file?: string): CodexAdapterId {
  return adapterFor(readAdapterChoice(file), agent);
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** 适配器源码指纹：目录里 *.ts 按名排序逐个喂「名 \0 内容 \0」；前 12 位与适配器 initialize 报的 agentInfo.version 相同 */
export function adapterFingerprint(dir = dirname(CODEX_ACP_ADAPTER_MAIN)): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex");
}

export interface ComboIdentity {
  id: string;
  adapter: string;
  codex: string;
  schema: string;
}

export function codexComboIdentity(codexVersion: string, schemaSha: string, adapter = adapterFingerprint()): ComboIdentity {
  return { id: sha256(`${adapter}\0${codexVersion}\0${schemaSha}`).slice(0, 16), adapter: adapter.slice(0, 12), codex: codexVersion, schema: schemaSha.slice(0, 12) };
}

export const identityLine = (i: ComboIdentity) => `组合身份 ${i.id}（自研适配器 ${i.adapter} + codex ${i.codex} + schema ${i.schema}）`;

type CompatVerdict = "compatible" | "incompatible" | "unknown";
export interface CodexCompat {
  verdict: CompatVerdict;
  /** 每条一句：`[红/黄/候选] 位置：原因`；兼容且没差异时为空 */
  reasons: string[];
  codexVersion?: string;
  identity?: ComboIdentity;
}

const LEVEL = { red: "红", yellow: "黄", candidate: "候选" } as const;

/** base：适配器验证过的那份锁（缺省已提交的 fixture）；next：目标 Codex 生成的锁 */
export function judgeCodexCompat(base: LockSet, next: LockSet, adapter?: string): CodexCompat {
  const r = classify(base, next);
  return {
    verdict: r.level === "red" ? "incompatible" : "compatible",
    reasons: r.findings.map((f) => `[${LEVEL[f.level]}] ${f.where}：${f.why}`),
    codexVersion: next.lock.cliVersion,
    identity: codexComboIdentity(next.lock.cliVersion, next.lock.schemaFullSha256, adapter),
  };
}

const unknown = (why: string): CodexCompat => ({ verdict: "unknown", reasons: [why] });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 对一个已在磁盘上的 codex 判兼容（readiness 用本机那个） */
export function probeCodexCompat(cli: string, base?: LockSet): CodexCompat {
  try {
    return judgeCodexCompat(base ?? readLockSet(), generateLockSet(cli));
  } catch (e) {
    return unknown(`生成或读取 schema 失败：${errText(e)}`);
  }
}

type Shell = (cmd: string) => Promise<{ ok: boolean; tail: string }>;
const STABLE = /^\d+\.\d+\.\d+$/;

/**
 * 还没装的 Codex 版本：npm 装进一次性临时目录（--ignore-scripts，nested 让原生包落在 nativeCodexCandidates 认得的位置），
 * 拿原生二进制生成 schema 再判，用完即删；不碰全局 Codex。shell 要带 npm 的 PATH（bridge 传登录 shell）。
 */
export async function probeNpmCodexCompat(version: string, shell: Shell, base?: LockSet): Promise<CodexCompat> {
  if (!STABLE.test(version)) return unknown(`${version.slice(0, 40)} 不是正式版本号`);
  const dir = mkdtempSync(join(tmpdir(), "codex-compat-"));
  try {
    const flags = "--no-save --ignore-scripts --no-audit --no-fund --install-strategy=nested --loglevel=error";
    const r = await shell(`npm install --prefix ${shellEscape(dir)} ${flags} @openai/codex@${version}`);
    if (!r.ok) return unknown(`隔离目录装 Codex ${version} 失败：${r.tail}`);
    const shim = join(dir, "node_modules/@openai/codex/bin/codex.js");
    const native = existsSync(shim) ? nativeCodexCandidates(realpathSync(shim)).find((p) => existsSync(p)) : undefined;
    if (!native) return unknown(`隔离目录里找不到 Codex ${version} 的原生二进制`);
    const c = probeCodexCompat(native, base);
    return c.verdict === "unknown" || c.codexVersion === version ? c : unknown(`隔离目录装出来的是 ${c.codexVersion}，不是 ${version}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Log = (m: string) => void;
// 只走 stderr：readiness 跑在 manager create / update / doctor 里，它们的 stdout 只放 JSON（调度器整体 JSON.parse）。
// 宿主传自己的 log（acp-host.ts → pickCodexAdapter），host.log 不受影响。见 tests/codex-compat.test.ts「诊断行只走 stderr」
const consoleLog: Log = (m) => console.error(m);

/**
 * 选了自研时用不用它：兼容才用，组合身份打进日志。不兼容和判不出（unknown）一样不用、退回上游——和更新闸遇到 unknown 回 409
 * 同一个取舍：自研是没验证够的那一边，判不出就回到一直在用的上游；上游自己的就绪照旧（离线不把能跑的机器判成未就绪）。
 * readiness 和宿主（起适配器之前）用的都是这一个判据。
 */
export function selfAdapterVerdict(codexBin: string | undefined, compat: (bin: string) => CodexCompat = probeCodexCompat, log: Log = consoleLog):
  { ok: true; compat: CodexCompat } | { ok: false; compat?: CodexCompat; why: string } {
  if (!codexBin) return { ok: false, why: "没解析出本机 codex 的路径，判不了协议" };
  const c = compat(codexBin);
  if (c.verdict === "compatible" && c.identity) {
    log(`[acp] ${identityLine(c.identity)}${c.reasons.length ? `；协议差异 ${c.reasons.length} 条，需真实组合验证` : ""}`);
    return { ok: true, compat: c };
  }
  const why = c.verdict === "incompatible"
    ? `本机 codex ${c.codexVersion} 按 app-server 协议判定和自研适配器不兼容：${c.reasons.slice(0, 3).join("；")}`
    : `判不出本机 codex 和自研适配器是否兼容：${c.reasons.join("；")}`;
  log(`⚠️ [acp] ${why}；改用上游 codex-acp`);
  return { ok: false, compat: c, why };
}

/**
 * 宿主起适配器之前定用哪个（acp-host.ts）：只管带了 adapter 的命令（沙箱 stub、手工覆盖、Pi 不归开关管，返回 null）。
 * 起之前和起之后分开：起之前判协议，判不过（不兼容 / unknown）有上游就直接换上游，没上游就返回 error 拒起宿主——判不过还硬起自研，
 * 等于把没验证过的组合放上生产；判过了起自研，起来后接不上线程再由 AdapterPick.fallback 退一次（没上游时那一步只告警、照旧重起）。
 */
export function pickCodexAdapter(
  agent: { cmd: string[]; adapter?: CodexAdapterId; upstream?: string[] | null }, codexBin: string | undefined, log: Log,
  compat: (bin: string) => CodexCompat = probeCodexCompat,
): AdapterPick | { error: string } | null {
  if (!agent.adapter) return null;
  const pick = new AdapterPick(agent.adapter, agent.cmd, agent.upstream ?? null, log);
  if (agent.adapter !== "self") return pick;
  const v = selfAdapterVerdict(codexBin, compat, log);
  if (v.ok) return pick;
  if (!agent.upstream) return { error: `选了自研 Codex 适配器但用不了（${v.why}），也没装上游 codex-acp 可退：不起宿主（manager acp-install 装上游，或 codex-adapter rollback）` };
  pick.fallback(v.why);
  return pick;
}
