/**
 * 沙箱里 ACP 只许起本仓的协议 stub（scripts/acp-stub.ts；owner 定的：沙箱不碰真 Codex 登录和 ~/.codex）。
 * - 外部的 CLAUDESTRA_ACP_AGENT 在沙箱里不认：它是任意 argv，非空证明不了是 stub。沙箱不继承它（sandbox-env.ts），
 *   带着它建 / 切 acp 直接拒（sandbox.ts assertSandboxRuntime），起适配器时按本仓位置现拼 argv（adapter-proc.ts）；
 * - stub 的真实路径（解开软链后）必须还在本仓里，指到别处就当没有；
 * - ACP 这条链（宿主、适配器、它起的 channel-server）的 HOME / CODEX_HOME 挪到沙箱根下，碰不到 owner 的家目录。
 * tests/codex-acp-adapter.test.ts。
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "../repo-root.js";

export const ACP_AGENT_ENV = "CLAUDESTRA_ACP_AGENT";

/** 本仓 stub 的真实路径；不存在、解不开或解出来不在本仓里 → null（调用方拒起） */
export function repoStubPath(root = REPO_ROOT): string | null {
  try {
    const repo = realpathSync(root);
    const p = realpathSync(join(repo, "scripts", "acp-stub.ts"));
    return p.startsWith(`${repo}/`) ? p : null;
  } catch {
    return null; // 找不到或解不开：按「没有 stub」拒起，不猜
  }
}

/** argv 是不是本仓的 stub（[bun, <stub>]，按真实路径比） */
export function isRepoStub(cmd: string[]): boolean {
  const stub = repoStubPath();
  if (!stub || cmd.length !== 2) return false;
  try {
    return realpathSync(cmd[1]!) === stub;
  } catch {
    return false; // 路径解不开：不是本仓 stub
  }
}

/** 沙箱里 ACP 这条链的 HOME（CODEX_HOME 在它下面）；沙箱根不是绝对路径就抛——拼出相对路径会落进 cwd */
export function sandboxAcpHome(sandboxRoot: string | undefined): { HOME: string; CODEX_HOME: string } {
  if (!sandboxRoot || !isAbsolute(sandboxRoot)) throw new Error(`沙箱根（CLAUDESTRA_SANDBOX_ROOT）不是绝对路径：${sandboxRoot || "空"}`);
  const home = join(sandboxRoot, "acp-home");
  return { HOME: home, CODEX_HOME: join(home, ".codex") };
}
