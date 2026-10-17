/**
 * OpenCode 的适配器：只有 ACP 一条路（acpOnly），宿主直连 `opencode acp`，没有适配器进程（docs/runtimes/opencode-acp.md）。
 * - new：起一个短命的 `opencode acp`，session/new 拿 `ses_…`（OpenCode 一建就落库，不需要 Codex 那种引导轮）；
 * - resume / restart：宿主 session/resume 接回，按 registry 的模型 set_config_option 校一次（host.ts applyAcpLaunchConfig）；
 * - 职责与频道规则：OpenCode 没有追加系统提示的入口，走首条入站前言（与 Codex 的 CLAUDESTRA_CODEX_PREAMBLE 同一条路）；
 * - 模型必填（modelRequired）：OpenCode 自己的缺省是免费的 big-pickle，免费期数据可能被拿去训练，不能指望缺省值。
 * 会话来源（历史）在 opencode-source.ts。tests/opencode-acp-runtime.test.ts。
 */
import { join } from "node:path";
import { channelInstructions } from "../channel-instructions.js";
import { shellEscape } from "../claude-launch.js";
import { acpCallerCredAssignment } from "../caller-cred-launch.js";
import { codexContextPreamble, codexDeveloperInstructions } from "../codex-launch.js";
import { encodePreambleEnv } from "../codex-thread.js";
import { acpLogDir } from "../log-paths.js";
import { pathOverrideAssignments } from "../paths.js";
import { REPO_ROOT } from "../repo-root.js";
import { resolveBunPath } from "../bun-path.js";
import { hostEnvBase, spawnAdapter } from "../acp/adapter-proc.js";
import { ACP_RUNTIME_ENV, opencodeConfigContent } from "../acp/host-runtime.js";
import { OPENCODE_BIN_ENV, OPENCODE_INSTALL_HINT, opencodeBin, opencodeDirsEnv } from "../acp/opencode-bin.js";
import { AcpSession } from "../acp/session.js";
import { enforceOpencodeModel } from "../acp/opencode-model-check.js";
import { isValidOpencodeSessionId } from "../opencode-session.js";
import { ACP_CONTROL, acpExitPrelude } from "./acp-control.js";
import { CODEX_READY_OPTION } from "./codex-ready.js";
import { waitOpencodeReady } from "./opencode-ready.js";
import { opencodeSource } from "./opencode-source.js";
import { resetReadyOption } from "./ready-option.js";
import type { LaunchSpec, ManagedRuntimeAdapter } from "./types.js";

const SESSION_TIMEOUT_MS = 120_000;
export const OPENCODE_MODEL_REQUIRED = "OpenCode agent 必须显式给模型（--model provider/model，如 opencode/big-pickle；网页弹窗选模型）："
  + "OpenCode 自己的缺省是免费模型，免费期数据可能被拿去训练，不替你默认";

const mcpName = (env: Record<string, string | undefined>) => env.MCP_NAME || "claudestra";

/** 启动命令：环境变量前缀 + bun acp-host.ts（窗口的 cwd 就是会话的 cwd）。纯函数，单测逐字钉住 */
export function buildOpencodeAcpHostCommand(
  spec: LaunchSpec, o: { bunBin: string; repoRoot: string; opencodeBin: string | null; env?: Record<string, string | undefined> },
): string {
  const env = o.env ?? process.env;
  const agent = spec.agentName || spec.settingsName;
  if (!agent) throw new Error("ACP 宿主需要 agent 名（LaunchSpec.agentName / settingsName）");
  if (!spec.sessionId) throw new Error("ACP 宿主需要会话 id（new 先经 prepareSession 建会话）");
  if (!spec.model?.trim()) throw new Error(OPENCODE_MODEL_REQUIRED);
  if (!o.opencodeBin) throw new Error(OPENCODE_INSTALL_HINT);
  const who = { agentName: agent, purpose: spec.purpose, projectContext: spec.projectContext };
  const full = encodePreambleEnv(codexDeveloperInstructions({ ...who, channelRules: channelInstructions(o.repoRoot) }));
  const pairs: [string, string | undefined][] = [
    ["DISCORD_CHANNEL_ID", spec.channelId],
    ["BRIDGE_URL", spec.bridgeUrl],
    ["CLAUDESTRA_AGENT", agent],
    ["CLAUDESTRA_SESSION_ID", spec.sessionId],
    ["MCP_NAME", mcpName(env)],
    [ACP_RUNTIME_ENV, "opencode"],
    [OPENCODE_BIN_ENV, o.opencodeBin],
    ["CLAUDESTRA_ACP_MODEL", spec.model.trim()],
    // 新会话里还没有职责 / 规则，首条入站带全文；接回的会话历史里已有，只带短前言。/clear 换的新会话同样要全文
    ["CLAUDESTRA_CODEX_PREAMBLE", spec.mode === "new" ? full : encodePreambleEnv(codexContextPreamble(who))],
    ["CLAUDESTRA_ACP_CLEAR_PREAMBLE", full],
  ];
  const prefix = pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${shellEscape(v!)}`).join(" ");
  const cred = acpCallerCredAssignment(spec.callerCredFile, shellEscape);
  return `${prefix}${cred}${pathOverrideAssignments(shellEscape, env)} ${shellEscape(o.bunBin)} ${shellEscape(join(o.repoRoot, "src/acp-host.ts"))}`;
}

/** new / fork：起短命的 `opencode acp` 建会话（不挂 claudestra MCP），返回 OpenCode 的会话 id */
async function prepareOpencodeSession(spec: LaunchSpec, bin: string | null): Promise<string> {
  if (!spec.cwd) throw new Error("OpenCode 新建会话需要工作目录（LaunchSpec.cwd）");
  if (!spec.model?.trim()) throw new Error(OPENCODE_MODEL_REQUIRED);
  if (!bin) throw new Error(OPENCODE_INSTALL_HINT);
  const logs: string[] = [];
  const base = { base: process.env, bunBin: resolveBunPath(), channelServer: "", mcpName: mcpName(process.env), logsDir: acpLogDir("bootstrap") };
  const env = { ...hostEnvBase(base), ...opencodeDirsEnv(), OPENCODE_CONFIG_CONTENT: opencodeConfigContent(spec.model.trim()) };
  const proc = spawnAdapter([bin, "acp", "--cwd", spec.cwd], env, spec.cwd, (m) => logs.push(m), "opencode");
  const s = new AcpSession(proc.wire, { onUpdate: () => {}, onPermission: async () => null, log: (m) => logs.push(m), label: "OpenCode" });
  const timer = setTimeout(() => proc.stop(), SESSION_TIMEOUT_MS);
  let sid: string | undefined;
  try {
    await s.initialize({ fork: spec.mode === "fork" });
    sid = spec.mode === "fork" ? await s.fork(spec.sessionId, spec.cwd) : await s.create(spec.cwd);
    // 手填的模型名在这里按会话自己的 configOptions 校（比 `opencode models` 全）、核对实际生效值：不认就拒建，别留一个起不来的 agent
    await enforceOpencodeModel(s, spec.model);
    return sid;
  } catch (e) {
    if (sid) await deleteOpencodeSession(bin, sid, env); // 会话一建就落库：拒建了就删掉，不在 OpenCode 库里留空会话
    throw new Error(`OpenCode 没建出会话：${e instanceof Error ? e.message : e}${logs.length ? `（${logs.slice(-3).join(" | ").slice(0, 300)}）` : ""}`);
  } finally {
    clearTimeout(timer);
    proc.stop();
  }
}

/** `opencode session delete <id>`；删不掉只记一条（空会话留在库里不影响谁，只是 OpenCode 的会话列表里多一条） */
async function deleteOpencodeSession(bin: string, sid: string, env: Record<string, string>): Promise<void> {
  try {
    const p = Bun.spawn({ cmd: [bin, "session", "delete", sid], env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) console.error(`[opencode] 删不掉拒建留下的空会话 ${sid}（exit ${code}）：${err.slice(0, 200)}`);
  } catch (e) {
    console.error(`[opencode] 删不掉拒建留下的空会话 ${sid}：${String(e)}`);
  }
}

export const opencodeAcpAdapter: ManagedRuntimeAdapter = {
  ...opencodeSource,
  manageable: true,
  control: ACP_CONTROL,
  acp: { control: ACP_CONTROL },
  acpOnly: true,
  modelRequired: OPENCODE_MODEL_REQUIRED,
  noEffort: true,
  inbound: "acp-host",
  turnEnd: "acp-host",
  exitCommand: "",
  noteTag: "opencode",
  callerCred: "env",
  isValidSessionId: isValidOpencodeSessionId,
  async available() {
    return opencodeBin() ? { ok: true } : { ok: false, hint: OPENCODE_INSTALL_HINT };
  },
  async prepareSession(spec) {
    return { sessionId: spec.mode === "resume" ? spec.sessionId : await prepareOpencodeSession(spec, opencodeBin()) };
  },
  buildLaunchCommand: (spec) => buildOpencodeAcpHostCommand(spec, { bunBin: process.execPath, repoRoot: REPO_ROOT, opencodeBin: opencodeBin() }),
  beforeLaunch: (win) => resetReadyOption(win, CODEX_READY_OPTION), // 清不掉就抛：不带着残留的 "1" 往下启动
  waitReady: (win, budget) => waitOpencodeReady(win, budget),
  exitPrelude: acpExitPrelude,
  registryFields: () => ({ runtime: "opencode", transport: "acp" }),
};
