/**
 * 适配器这一侧的 pi rpc 线路：命令按 id 等回包（success:false / 超时 / pi 退出都 reject），其余记录（事件、扩展 UI 请求）交给 onRecord。
 * 每条记录单独占一个宏任务处理：上一条触发的 ACP 回包（它们都只走微任务）一定先写出去，再处理下一条。否则同一块输出里
 * 「prompt 回包 + 整个回合 + agent_settled」会先把 idle 发给宿主、后发 startedNewTurn，宿主就等不到这一轮的结束（session.ts）。
 * 退出也排进同一个队列：先处理完已收到的记录，再报退出。tests/pi-acp-replay.test.ts。
 */
import { lineSplitter, type RpcWire } from "../rpc.js";

type Rec = Record<string, any>;

export interface PiProc {
  wire: RpcWire;
  stop(): void;
  exited: Promise<number>;
}

export interface PiLink {
  command(cmd: Rec, timeoutMs?: number): Promise<any>;
  /** 不等回包的记录（extension_ui_response） */
  send(rec: Rec): void;
  onRecord(cb: (rec: Rec) => void): void;
  onExit(cb: (why: string) => void): void;
  stop(): void;
  exited: Promise<number>;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const snippet = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

export function piLinkOver(proc: PiProc, log: (msg: string) => void): PiLink {
  let seq = 0;
  let closed = false;
  const pending = new Map<string, Pending>();
  let recordCb: (rec: Rec) => void = () => {};
  const exitCbs: ((why: string) => void)[] = [];
  const queue: (() => void)[] = [];
  let scheduled = false;

  const schedule = () => {
    if (scheduled || !queue.length) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      queue.shift()?.();
      schedule();
    });
  };
  const enqueue = (job: () => void) => {
    queue.push(job);
    schedule();
  };

  const settle = (rec: Rec, line: string) => {
    const p = typeof rec.id === "string" ? pending.get(rec.id) : undefined;
    if (!p) return log(`pi 回了没人等的响应：${snippet(line)}`);
    pending.delete(rec.id);
    if (p.timer) clearTimeout(p.timer);
    if (rec.success === false) p.reject(new Error(`pi ${rec.command} 失败：${rec.error ?? "未说明原因"}`));
    else p.resolve(rec.data);
  };

  const handle = (line: string) => {
    let rec: Rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return log(`pi 输出了一行不是 JSON 的内容：${snippet(line)}`);
    }
    if (rec?.type === "response") settle(rec, line);
    else recordCb(rec);
  };

  const exit = (why: string) => {
    closed = true;
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`pi 退出了（${why}）`));
    }
    pending.clear();
    for (const cb of exitCbs.splice(0)) cb(why);
  };

  const overflow = (why: string) => {
    log(`pi ${why}，结束 pi`);
    proc.stop();
  };
  proc.wire.onData(lineSplitter((line) => enqueue(() => handle(line)), undefined, overflow));
  proc.wire.onClose((why) => enqueue(() => exit(why)));

  const write = (rec: Rec) => proc.wire.write(`${JSON.stringify(rec)}\n`);
  return {
    command(cmd, timeoutMs) {
      if (closed) return Promise.reject(new Error(`pi 已退出，${cmd.type} 发不出去`));
      const id = `p${++seq}`;
      return new Promise((resolve, reject) => {
        const p: Pending = { resolve, reject };
        if (timeoutMs) p.timer = setTimeout(() => (pending.delete(id), reject(new Error(`pi ${cmd.type} 超时（${timeoutMs}ms）`))), timeoutMs);
        pending.set(id, p);
        write({ ...cmd, id });
      });
    },
    send: (rec) => void (closed || write(rec)),
    onRecord: (cb) => void (recordCb = cb),
    onExit: (cb) => void exitCbs.push(cb),
    stop: () => proc.stop(),
    exited: proc.exited,
  };
}
