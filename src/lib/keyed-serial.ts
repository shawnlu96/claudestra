/**
 * 按 key 串行执行异步任务：同一个 key 的任务按调用顺序一个接一个跑，不同 key 互不影响；前一个出错不卡后面的。
 * 投递顺序（bridge deliverToLocal）和打断键（lib/interrupt-gate.ts）都靠它。单测 tests/keyed-serial.test.ts。
 */
export function createKeyedSerial() {
  const chains = new Map<string, Promise<unknown>>();
  return function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined, // 错误由 run 的调用方拿到；链尾只负责排队，不能因为前一个失败卡住后面的
    );
    chains.set(key, tail);
    void tail.then(() => chains.get(key) === tail && chains.delete(key));
    return run;
  };
}
