import { runningPiVersion, writePiEnvSnapshot } from "../../pi-env-snapshot.js";
/**
 * Pi 扩展：ACP 会话也写能力快照（与 tmux 侧共用 src/lib/pi-env-snapshot.ts）。网页「本会话还在旧版本，重启后生效」
 * 横幅读快照里的 piVersion（src/lib/update-hints.ts）：不写的话重启后版本永远是旧的，横幅永不消失。
 * 版本走 runningPiVersion()（Pi 的虚拟模块），别改成 process.env.PI_VERSION：Pi 不设这个变量。
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

/** version 可注入（测试断言成功值真的写进快照）；默认问 Pi 的虚拟模块。handler 返回写盘的 promise，失败降级成不带版本 */
export function createPiEnvSnapshot(version: () => Promise<string | undefined> = runningPiVersion) {
  return function piEnvSnapshot(pi: SnapApi): void {
    if (!AGENT) return;
    const write = (ctx: unknown): Promise<void> => {
      const c = ctx as { sessionManager?: { getSessionId?(): string }; model?: { id?: string; name?: string } } | undefined;
      let sessionId: string | undefined;
      try {
        sessionId = c?.sessionManager?.getSessionId?.();
      } catch {
        sessionId = undefined; // 老版本没有这个接口时留空，不影响快照其余字段
      }
      return version()
        .catch(() => undefined) // 拿不到版本只是不提示重启，快照其余字段照写
        .then((v) => writePiEnvSnapshot({ pi, agent: AGENT, sessionId, ctx: c, piVersion: v }));
    };
    pi.on("session_start", (_e, ctx) => write(ctx));
    // 回合开始再写一次：激活（codemode）发生在别的扩展的 session_start 里，首份快照会少一个工具
    pi.on("agent_start", (_e, ctx) => write(ctx));
  };
}

export default createPiEnvSnapshot();
