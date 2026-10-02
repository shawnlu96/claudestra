import { runningPiVersion, writePiEnvSnapshot } from "../../pi-env-snapshot.js";
/**
 * Pi 扩展：ACP 会话也写一份能力快照（与 tmux 侧共用 src/lib/pi-env-snapshot.ts）。
 *
 * 为什么必须补：网页输入框上方那条「Pi 1.0.0 已装好，本会话还在 0.99.2 —— 重启后生效」的
 * 横幅，读的是这份快照里的 piVersion（src/lib/update-hints.ts）。ACP 会话原先不写快照
 * ⇒ 重启之后 piVersion 永远是旧的 ⇒ 横幅**永远不消失**，看起来像"重启没生效"（2026-10-02 owner 实报）。
 *
 * 版本用共享的 runningPiVersion()（问 Pi 的虚拟模块要本进程版本）——**不要**用
 * process.env.PI_VERSION：真机实测那个变量在 ACP 会话里根本不存在（2026-10-02）。
 */
const AGENT = (process.env.CLAUDESTRA_AGENT ?? "").trim();

interface SnapApi {
  on(event: string, handler: (e: unknown, ctx: unknown) => unknown): void;
  getAllTools?(): Array<{ name?: string } | string>;
  getActiveTools?(): string[];
  getCommands?(): Array<{ name?: string } | string>;
  getModel?(): { id?: string; name?: string };
  getThinkingLevel?(): string | undefined;
}

export default function piEnvSnapshot(pi: SnapApi): void {
  if (!AGENT) return;
  const write = (ctx: unknown) => {
    const c = ctx as { sessionManager?: { getSessionId?(): string }; model?: { id?: string; name?: string } } | undefined;
    let sessionId: string | undefined;
    try {
      sessionId = c?.sessionManager?.getSessionId?.();
    } catch {
      sessionId = undefined; // 老版本没有这个接口时留空，不影响快照其余字段
    }
    void runningPiVersion().then((v) => writePiEnvSnapshot({ pi, agent: AGENT, sessionId, ctx: c, piVersion: v }));
  };
  pi.on("session_start", (_e, ctx) => write(ctx));
  // 回合开始再写一次：激活（codemode）发生在别的扩展的 session_start 里，首份快照会少一个工具
  pi.on("agent_start", (_e, ctx) => write(ctx));
}

