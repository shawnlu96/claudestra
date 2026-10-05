/**
 * 适配器进程自己的 stdio 当 RpcWire：stdout 只走协议，stdin 收宿主的行，stdin 关了算断开。
 * 线路作废（超长行等）直接退出进程：宿主看到适配器退出会重启它，留着一条坏线路只会让回合挂死。
 */
import type { RpcWire } from "./rpc.js";

export function stdioWire(log: (msg: string) => void): RpcWire {
  return {
    write: (line) => void process.stdout.write(line),
    onData: (cb) => void process.stdin.on("data", cb),
    onClose: (cb) => void process.stdin.on("end", () => cb("stdin 关闭")),
    close: (why) => {
      log(`ACP 线路作废（${why}），退出`);
      process.exit(1);
    },
  };
}
