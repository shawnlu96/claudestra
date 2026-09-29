/**
 * 用最小 env 起子进程的测试统一走这里（T45）：带上测试标记和死端口的 bridge，子进程里 lib/test-guard.ts 的闸照样生效
 * （状态目录不带：用临时 HOME 的 harness 靠 HOME 定位；HOME 是真家目录时 test-guard 会换成临时目录）。guard 规则 test-env 会拦 tests/ 里没经这里的最小 env。
 * 要继承当前环境的用 `{ ...process.env, … }`（preload 已设好标记），不必经这里。
 */
import { TEST_FLAG } from "../src/lib/test-guard.ts";

/** PATH / HOME / TMPDIR 取当前进程的，其余只有隔离要的几项；extra 覆盖，值为 undefined 的键去掉 */
export function testChildEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    [TEST_FLAG]: "1",
    NODE_ENV: "test",
    BRIDGE_URL: "ws://127.0.0.1:9",
    BRIDGE_PORT: "9",
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...base, ...extra })) if (v !== undefined) out[k] = v;
  return out;
}
