/**
 * 出借 worker 的干净环境（docs/design/remote-capacity.md §5）：外来任务在 B 的用户下跑，进程环境只放白名单里的几个变量，
 * 不带 B 的 .env、控制 token、CLAUDESTRA_*、GH_TOKEN / GITHUB_TOKEN、代理设置。防的是「worker 顺手用到继承来的凭据」，
 * 不是凭据隔离：同一个 OS 用户下它仍能读 HOME 里的文件（§5「做不到」）。
 * 按 agent 名认（agent-lend-*），不靠 registry 里的开关：create / restart / resume 三条启动路径都走 runtimes 的同一个判定，
 * 哪条漏传一个字段都不会让出借 worker 带着全量环境起来。tests/lend-worker-env.test.ts。
 */

import { isSandbox } from "../sandbox.js";

/** 出借 worker 的 agent 名前缀；lend 循环按 orderId 生成，别的入口建不出这个前缀以外的出借 worker */
export const LEND_WORKER_PREFIX = "agent-lend-";

/** worker 进程能看到的全部继承变量（§5 定的名单）；别的一律不带 */
export const WORKER_ENV_WHITELIST = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "CODEX_HOME"] as const;

export const isLendWorkerName = (name: string | undefined): boolean => !!name && name.startsWith(LEND_WORKER_PREFIX);

/**
 * 白名单之外还要带的路径 / 隔离变量（都不是凭据）：状态与运行目录改过时不带，worker 里的 `lend submit` 和宿主自停兜底会去读默认目录，
 * 找不到这张单就当它结束了（lend-watchdog.ts）；沙箱实例不带沙箱变量，worker 会被当成生产进程（碰生产目录、起真 Codex）。
 */
const PLUMBING = ["CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"] as const;
/** 沙箱进程加载 lib/paths 时要核 bridge 地址不是生产端口，不带 BRIDGE_* 会回落到默认端口、当场拒绝启动（都是回环地址，不是凭据） */
const SANDBOX_VAR = /^(?:CLAUDESTRA_(?:SANDBOX(?:_[A-Z_]+)?|LAB_[A-Z_]+)|BRIDGE_(?:PORT|URL|BIND))$/;

/** 只留白名单里有值的变量（外加上面的路径变量；沙箱里再加沙箱变量） */
export function pickWorkerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = [...WORKER_ENV_WHITELIST, ...PLUMBING, ...(isSandbox(env) ? Object.keys(env).filter((k) => SANDBOX_VAR.test(k)) : [])];
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

/**
 * 宿主启动命令的前缀：`env -i K=V …`。env -i 先清掉 tmux 窗口 shell 继承来的一切，再只放白名单与调用方给的宿主变量；
 * TMUX_PANE 由窗口 shell 展开（宿主要用它标就绪），它只是窗格编号，不是凭据。
 */
export function envIPrefix(env: Record<string, string | undefined>, escape: (v: string) => string): string {
  const pairs = Object.entries(pickWorkerEnv(env)).map(([k, v]) => `${k}=${escape(v)}`);
  return ["env -i", ...pairs, 'TMUX_PANE="$TMUX_PANE"'].join(" ");
}

/** 宿主告诉自己「起适配器时只给白名单」的标记；只有 envIPrefix 起的宿主才带 */
export const CLEAN_ENV_FLAG = "CLAUDESTRA_ACP_CLEAN_ENV";

/**
 * 出借 worker 进程（codex 本体及它起的 shell）带的非秘密标记：ledger / lend / project 的身份判定（manager/ledger-identity.ts）
 * 看到它一律拒，否则「没有频道号 = owner」会让外来任务以 owner 身份改 lend.json、延长预先授权、替 owner 答 ask。
 * 同一 OS 用户下仍能绕开（unset 或直接写文件，§5 已知限制），防的是顺手照派单里的命令去做。
 */
export const LEND_WORKER_MARK = "CLAUDESTRA_LEND_WORKER";
