/**
 * 远程终端的授权判定（bridge/web-terminal.ts 用；tests/terminal-auth.test.ts）。
 * 设备凭据下 owner 的所有设备共用 principal owner:self，所以「会话属于谁」不能按 principal id 判——按设备凭据判：
 * 否则一台没开终端的 owner 设备拿到别的设备的 termId 就能往 PTY 里写（codex 复核）。每次 input / resize 都重验
 * 终端授权：grant 在会话打开后被收窄、凭据被换，都要立刻生效。
 */
import { terminalAllowed, tokenIdOf, type Principal } from "../lib/principals.js";

/** 终端会话的属主键：设备凭据 id 优先（cred:<id>），Bearer token 退回 token id */
export function terminalOwnerKey(p: Principal): string {
  return p.credential ? `cred:${p.credential}` : tokenIdOf(p);
}

/** 这个身份能不能开 / 操作这个 agent 的终端（agent 名带不带 agent- 前缀都试） */
export function terminalAllowedFor(p: Principal, agent: string): boolean {
  return terminalAllowed(p, agent) || terminalAllowed(p, `agent-${agent}`);
}

/** input / resize 的每次校验：属主一致且此刻仍有终端授权；不通过返回拒绝原因 */
export function terminalIoDenied(p: Principal, sess: { tokenId: string; agent: string }): string | null {
  if (sess.tokenId !== terminalOwnerKey(p)) return "terminal session belongs to another token";
  if (!terminalAllowedFor(p, sess.agent)) return "terminal access no longer granted for this agent";
  return null;
}
