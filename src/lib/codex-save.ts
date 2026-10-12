/**
 * Codex（ACP）版 /save-compact、/save-clear 的纯逻辑：交接文件放哪、让 Codex 落盘 / 回读的提示词、落盘结果怎么核对。
 * 交接按 agent 隔离放在状态目录（STATE_DIR/handoff/<agent>/HANDOFF.md），不进 ~/.claude/projects/*\/memory：
 * 那是 Claude Code 的 SessionStart hook 读的地方，Codex 读不回，执行者写进去还会盖掉 PM 的交接。
 * 编排（等回合结束、失败停在原地）在 bridge/codex-save.ts。tests/codex-save.test.ts。
 */
import { statePath } from "./paths.js";

export type CodexSaveKind = "save-compact" | "save-clear";

/** 交接上限：回读时整段塞进新会话第一轮，太大就失去「交接」的意思 */
export const HANDOFF_MAX_BYTES = 32 * 1024;
const AGENT_RE = /^[\w.-]{1,128}$/;

/** 交接文件路径；名字只当一段目录（registry 名本来就过了校验，这里再挡一次 ../ 之类） */
export function codexHandoffPath(agent: string): string {
  if (!AGENT_RE.test(agent) || agent === "." || agent === "..") throw new Error(`agent 名不能当目录：${agent}`);
  return statePath("handoff", agent, "HANDOFF.md");
}

/** 落盘回合在文件首行写的标记：证明文件是这一轮写的，不是上次留下的 */
export const handoffMarker = (opId: string) => `<!-- claudestra-handoff op=${opId} -->`;

/** 让 Codex 跑一轮「先落盘」：内容要求对照 Claude Code save-compact 第 1 步（进度交接 + 长期事实），只写这一个文件 */
export function codexSavePrompt(kind: CodexSaveKind, path: string, opId: string, now = new Date()): string {
  const next = kind === "save-compact" ? "上下文压缩" : "清空上下文、换一个新会话";
  return [
    `[Claudestra ${kind}] 马上要${next}。先把这次会话里值得留下的东西写进交接文件，这一轮只做这件事：`,
    `- 路径：${path}（目录不存在就建；整文件覆盖，不追加；不要写到别处）`,
    `- 第一行必须原样是：${handoffMarker(opId)}`,
    `- 之后按这个结构写（≤ 80 行，具体到下一个会话能直接接着干；没有的小节写「无」）：`,
    `  # HANDOFF · ${now.toISOString()}`,
    "  ## 在做什么 / ## 已完成 / 已定 / ## 进行中 / 阻塞 / ## 下一步（按顺序） / ## 等 owner 拍板 / ## 关键路径 / 命令 / ## 长期事实（决策+理由、踩过的坑、用户偏好）",
    `- 不写密钥、token、密码。写完回一句「交接已存」就结束这一轮，不要做别的事，也不要自己压缩或清空。`,
  ].join("\n");
}

/** 新会话第一轮：把交接原文带进去（Codex 没有 Claude Code 的 SessionStart hook） */
export function codexRestorePrompt(path: string, content: string): string {
  return [
    `[Claudestra save-clear] 上下文刚清空，这是上一个会话存下的交接（原文在 ${path}）：`,
    "",
    content.trim(),
    "",
    "读完只回一句「已接上交接」，然后等下一条消息，不要开始做事。",
  ].join("\n");
}

export type HandoffCheck = { ok: true; content: string } | { ok: false; why: string };

/** 核对落盘结果：文件在、是这一轮写的（首行标记）、有正文、不超限。raw = null 表示文件不在 */
export function checkHandoff(raw: string | null, opId: string): HandoffCheck {
  if (raw === null) return { ok: false, why: "交接文件没写出来" };
  if (Buffer.byteLength(raw) > HANDOFF_MAX_BYTES) return { ok: false, why: `交接文件超过 ${HANDOFF_MAX_BYTES / 1024}KB` };
  const [first, ...rest] = raw.replace(/^﻿/, "").split("\n");
  if (first.trim() !== handoffMarker(opId)) return { ok: false, why: "交接文件首行不是这一轮的标记（像是旧文件，或没按要求写）" };
  const content = rest.join("\n").trim();
  if (content.length < 20) return { ok: false, why: "交接文件几乎是空的" };
  return { ok: true, content };
}
