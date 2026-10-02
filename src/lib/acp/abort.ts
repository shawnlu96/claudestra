/**
 * 宿主收到 bridge 的停止（ws abort）。会话里有回合就取消，不能答空闲：调度器在跑 / 排着，或者适配器报着 active
 * （它自己开的一轮，session.ts running）。回执的 voided 列出适配器清掉的排队消息里宿主 steer 进去的那几条，
 * bridge 逐条告诉发送方没执行（语义同 Pi 扩展的 pi/abort-control.ts）。宿主队列里还没送出的消息照旧留着，下一轮处理。
 * tests/acp-self-turn.test.ts。
 */
import type { AcpSession } from "./session.js";
import type { AcpTurnLoop } from "./turn.js";

export interface AbortDeps {
  session: AcpSession | null;
  loop: AcpTurnLoop;
  /** 挂着的权限请求按取消回适配器、撤卡 */
  endPermissions(): void;
  send(frame: Record<string, unknown>): void;
  log(msg: string): void;
}

export async function abortAcpTurn(id: string, d: AbortDeps): Promise<void> {
  const s = d.loop.busy || d.session?.running ? d.session : null;
  const voided = d.loop.voided(s ? await s.cancel() : []);
  d.endPermissions();
  d.send({ type: "abort_ack", id, result: s ? "aborted" : "idle", voided, inEditor: 0 });
  d.log(s ? `收到停止：已取消当前回合${voided.length ? `，作废 ${voided.length} 条 steer 进去还没执行的消息` : ""}` : "收到停止：当前空闲");
}
