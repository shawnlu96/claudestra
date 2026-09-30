/**
 * Web 斜杠直通（POST /api/v1/agents/:name/messages 里文本形如 "/cmd [args]"）：命中命令表 → tmux 字面注入 TUI，
 * 由 CC / Pi 原生解释。注入不经 bridge 的 render：没有来源头、不做委托标记中和（lib/delegate-marker.ts），
 * 网页历史里也看不到参数——等于「owner 在终端里亲手敲」。所以只给 owner 本人（lib/principals.ts isOwnerPrincipal）：
 * guest / scoped token 发本来会直通的文本回 403；peer 从来没有直通，斜杠文字一直按普通消息投（带 🤝 头、被中和）。
 * 从 api-routes.ts 原样搬出，依赖注入以便单测（tests/api-slash.test.ts）。
 */
import { isOwnerPrincipal, type Principal } from "../lib/principals.js";
import { runtimeCommandsFor } from "../lib/runtime-commands.js";
import { resolveModelAlias } from "../lib/claude-launch.js";
import { MASTER_SESSION, SWITCH_LEFTOVER, windowTarget, type SwitchConfirmKind, type SwitchResult } from "../lib/tmux-helper.js";
import { modelTargetKey } from "../lib/switch-target.js";
import { MASTER_WINDOW_MISMATCH } from "../lib/master-modal.js";
import type { KeysBlockedError } from "../lib/codex-key-guard.js";
import { canSeeQuota } from "../lib/devices.js";
import { wallWaitRefusal, windowWallWait, type WallWait } from "../lib/wall-screen.js";
import { resolveWebInvocation, isProjectSkillForOtherAgent } from "./slash-registry.js";
import { apiJson } from "./api-respond.js";
import type { ApiUserEndpoint } from "./router.js";
import { acpClear, acpSlash } from "./acp-link.js";
import { isConfiguredAcpChannel } from "./acp-state.js";

export const SLASH_OWNER_ONLY = {
  code: "slash_owner_only",
  error: "斜杠命令只有 owner 能用，请直接发文字 / Slash commands are owner-only — send it as plain text",
} as const;

interface SlashAgent {
  name: string;
  channelId: string;
  cwd?: string;
  sessionId?: string;
  runtime?: string;
}

export interface SlashDeps {
  sendLine: (win: string, text: string) => Promise<void>;
  mirror: (to: ApiUserEndpoint, agentChannelId: string, text: string) => Promise<void>;
  scheduleClearRotation: (agentName: string, channelId: string, cwd: string, oldSid?: string) => void;
  /** 技能类命令注入后跑真实回合：点亮 web 的思考徽章 / 侧栏 busy（builtin TUI 命令没有回合，不发） */
  markThinking: (agent: SlashAgent) => void;
  record: (cmd: string, agent: SlashAgent) => void;
  /** 窗口停在额度菜单 / 撞墙倒计时上（lib/wall-screen.ts）：不注入；不给 = 真抓屏 */
  wallWait?: (win: string) => Promise<WallWait | null>;
  /** 同步注入并确认 /model X、/effort X（lib/tmux-helper.ts runSwitchCommand） */
  switchCommand: (win: string, kind: SwitchConfirmKind, arg: string) => Promise<SwitchResult>;
  /** window 0 此刻是不是大总管正身（lib/master-modal.ts isMasterWindow） */
  masterWindowOk: (win: string) => Promise<boolean>;
}

export interface SlashRequest {
  principal: Principal;
  tokenId: string;
  agent: SlashAgent;
  text: string;
  hasAttachments: boolean;
}

const SLASH_RE = /^\/([\w:-]+)(?:\s+([\s\S]+))?$/;

/** ACP 宿主的 agent：不敲键，原样当 prompt 交给宿主 */
async function acpSlashPassthrough(agent: SlashAgent, cmd: string, ccText: string, deps: SlashDeps): Promise<Response> {
  const r = await acpSlash(agent.channelId, ccText);
  if (!r.ok) return apiJson(409, { ok: false, error: `没交给宿主：${r.error}` });
  deps.record(cmd, agent);
  deps.markThinking(agent);
  console.log(`⚡ [api] slash 交给 ACP 宿主 ${agent.name}: ${ccText}`);
  return apiJson(202, { ok: true, accepted: true, slash: true, ccText, agent: agent.name, acp: true });
}

const SWITCH_TITLE = { model: "Switch model?", effort: "Change effort level?" } as const;

/** 框没按的原因：本来就停着 / 认不出版本核对不了（自定义 id 等）/ 目标确实不同 */
export function foreignReason(kind: SwitchConfirmKind, arg: string, r: SwitchResult & { prompt: NonNullable<SwitchResult["prompt"]> }): string {
  if (r.reason === SWITCH_LEFTOVER) return "这条命令没有注入（框在注入前就停着）";
  if (kind === "model" && r.prompt.kind === "model" && (!modelTargetKey(arg) || !modelTargetKey(r.prompt.target))) {
    return `认不出「${arg}」和框里目标的版本，核对不了，没有代按`;
  }
  return "和这条命令的目标不同，没有代按";
}

/** runSwitchCommand 的结局 → 409 文案（null = 注入成功，warning 另给）。不按的框留给 owner：watcher 会通知 */
function switchOutcome(kind: SwitchConfirmKind, arg: string, r: SwitchResult): { error?: string; warning?: string } {
  if (r.outcome === "rejected") return { error: `CC 拒绝了这次切换：${r.reason ?? "原因见终端"}` };
  if (r.outcome === "foreign" && r.prompt) {
    const why = foreignReason(kind, arg, { ...r, prompt: r.prompt });
    return { error: `会话停在「${SWITCH_TITLE[r.prompt.kind]}」确认框上（切到 ${r.prompt.target}），${why}；请到终端或网页终端里自己按` };
  }
  if (r.outcome === "timeout") {
    return { warning: r.prompt ? `按过一次确认，「${SWITCH_TITLE[kind]}」框还在，请到终端或网页终端里看一眼` : `没等到 /${kind} 落地；如果弹了确认框，请到终端或网页终端里自己按` };
  }
  return {};
}

/** 处理完了（直通 202 / 403 / 409 / 注入失败 500）→ Response；不是能直通的命令 → null，调用方按普通消息投递 */
export async function handleSlashPassthrough(r: SlashRequest, deps: SlashDeps): Promise<Response | null> {
  const { principal, agent, text } = r;
  if (principal.peer) return null; // peer 的斜杠文字永远是普通消息（v2.11 review 2026-07-19 #5）
  const slashM = text.trim().match(SLASH_RE);
  if (!slashM) return null;
  const owner = isOwnerPrincipal(principal);
  const regName = agent.name === "master" ? null : agent.name;
  // Pi / Codex 的命令表是它们自己的（lib/runtime-commands.ts），命中就交给运行时原生解释（同名命令语义不同）。
  // Codex 不在表里的 "/xxx" 落回普通消息——CC 的技能注进 Codex 的 TUI 没有意义；Pi 照旧回落到 CC 注册表
  const rt = String(agent.runtime || "");
  if (rt === "codex" && slashM[1] === "clear" && await isConfiguredAcpChannel(agent.channelId)) {
    if (!owner) return apiJson(403, { ok: false, ...SLASH_OWNER_ONLY });
    if (r.hasAttachments) return apiJson(409, { ok: false, error: "ACP /clear 不接收附件；会话未改动" });
    const cleared = await acpClear(agent.channelId);
    if (!cleared.ok) return apiJson(cleared.uncertain ? 504 : 409, { ok: false, code: cleared.uncertain ? "clear_result_unknown" : undefined, error: cleared.error, sessionId: cleared.sessionId });
    deps.record("clear", agent);
    return apiJson(200, { ok: true, agent: agent.name, sessionId: cleared.sessionId, previousSessionId: agent.sessionId, acp: true, slash: true, clear: true });
  }
  if (r.hasAttachments) return null;
  const args = (slashM[2] || "").trim();
  const nativeHit = runtimeCommandsFor(rt, agent.name)?.find((c) => c.name === slashM[1]);
  const resolved = nativeHit
    ? { ok: true as const, ccText: `/${nativeHit.invokeName}${args ? ` ${args}` : ""}`, scope: nativeHit.scope }
    : rt === "codex" ? { ok: false as const, reason: "not a Codex command" } : resolveWebInvocation(slashM[1], regName, slashM[2] || "");
  if (!resolved.ok) {
    const other = isProjectSkillForOtherAgent(slashM[1], regName);
    if (!other) return null; // 不是已知命令 → 按普通消息投递
    if (!owner) return apiJson(403, { ok: false, ...SLASH_OWNER_ONLY });
    return apiJson(409, { ok: false, error: `/${slashM[1]} 是 ${other.replace(/^agent-/, "")} 的项目技能，当前 agent 不可用` });
  }
  if (!owner) return apiJson(403, { ok: false, ...SLASH_OWNER_ONLY });
  if (await isConfiguredAcpChannel(agent.channelId)) return acpSlashPassthrough(agent, slashM[1], resolved.ccText, deps);
  const win = agent.name === "master" ? `${MASTER_SESSION}:0` : windowTarget(agent.name);
  if (agent.name === "master" && !(await deps.masterWindowOk(win))) return apiJson(409, { ok: false, error: MASTER_WINDOW_MISMATCH });
  // 停在额度菜单 / 撞墙倒计时上不打字（倒计时上一打字就取消自动续跑，菜单上会选项）；原因只告诉能看额度的凭据（canSeeQuota）
  const wall = await (deps.wallWait ?? ((w: string) => windowWallWait(w, rt || undefined)))(win); // Codex 窗口还认选择菜单（T63）
  if (wall) return apiJson(409, { ok: false, error: `${agent.name} ${wallWaitRefusal(wall, canSeeQuota(principal))}，这条命令没有注入` });
  // CC 的 /model X、/effort X（大总管也是）：同一次调用里注入、等框、目标和注入值完全一致才按，只按一次（T41c）。
  // 对不上 / 超时都不按、也不留任何意图——之后弹的框 watcher 只通知 owner。Pi 的同名命令是它自己的，照常直通
  const switchKind = !nativeHit && rt !== "codex" && args && (slashM[1] === "model" || slashM[1] === "effort") ? slashM[1] : null;
  let warning: string | undefined;
  try {
    if (switchKind) {
      const arg = switchKind === "model" ? resolveModelAlias(args) : args;
      const out = switchOutcome(switchKind, arg, await deps.switchCommand(win, switchKind, arg));
      if (out.error) return apiJson(409, { ok: false, error: out.error });
      warning = out.warning;
    } else await deps.sendLine(win, resolved.ccText);
  } catch (e) {
    // 查过之后、真正发键前菜单 / 切换框弹出来了（lib/codex-key-guard.ts）：打字前拦的没注入；回车前拦的字已进输入框，文案自带
    if ((e as Error).name === "KeysBlockedError") {
      return apiJson(409, { ok: false, error: `${agent.name} ${(e as Error).message}${(e as KeysBlockedError).typed ? "" : "，这条命令没有注入"}` });
    }
    return apiJson(500, { ok: false, error: `tmux 注入失败: ${(e as Error).message}` });
  }
  const tn = principal.name || r.tokenId;
  // Discord 抄送只是镜像，失败不影响已完成的注入；mirror 内部已记日志
  deps.mirror({ kind: "api", tokenId: r.tokenId, name: tn }, agent.channelId, `[🌐 API←${tn}] ${text}`).catch(() => {});
  deps.record(slashM[1], agent);
  if (resolved.scope !== "builtin") deps.markThinking(agent);
  // 直通的 /clear 与 clear 端点一样会轮转 session——必须同样挂轮转收尾，否则 registry/watcher/history 盯死旧文件
  if (slashM[1] === "clear" && agent.name !== "master" && agent.cwd) {
    deps.scheduleClearRotation(agent.name, agent.channelId, agent.cwd, agent.sessionId);
  }
  console.log(`⚡ [api] slash 注入 ${agent.name}: ${resolved.ccText}`);
  return apiJson(202, { ok: true, accepted: true, slash: true, ccText: resolved.ccText, agent: agent.name, ...(warning ? { warning } : {}) });
}
