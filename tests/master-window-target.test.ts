import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// 大总管窗口定名为 "master" 之后，裸 `-t master` 会优先解析成**这个窗口**而不是 session：
// new-window 报 index in use、move-window 搬错窗口、kill/send-keys 打到大总管身上。
// 窗口类命令的 session 目标必须带冒号（sessionTarget）或写成 master:<index|name>。
const WINDOW_CMDS = "new-window|move-window|kill-window|send-keys|select-window|rename-window|swap-window|link-window";
const BARE = new RegExp(
  `\\[\\s*"(?:${WINDOW_CMDS})"[^\\]]*?"-[ts]",\\s*(?:MASTER_SESSION|SESSION_NAME|"master")\\s*[,\\]]`,
);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("窗口类 tmux 命令不使用不带冒号的 master session 目标", () => {
  const offenders: string[] = [];
  for (const f of walk(join(import.meta.dir, "..", "src"))) {
    const src = readFileSync(f, "utf-8").replace(/\n\s*/g, " ");
    const m = BARE.exec(src);
    if (m) offenders.push(`${f}: ${m[0].slice(0, 120)}`);
  }
  expect(offenders).toEqual([]);
});

test("守卫本身能抓到违例写法", () => {
  expect(BARE.test(`["new-window", "-t", MASTER_SESSION, "-n", x]`)).toBe(true);
  expect(BARE.test(`["move-window", "-s", "master", "-t", y]`)).toBe(true);
  expect(BARE.test(`["new-window", "-t", sessionTarget(SESSION_NAME), "-k"]`)).toBe(false);
  expect(BARE.test(`["list-windows", "-t", MASTER_SESSION, "-F", f]`)).toBe(false);
});
