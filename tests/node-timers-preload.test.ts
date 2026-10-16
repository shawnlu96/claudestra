/**
 * merge-arch-TIMERPRE1：tests/preload.ts 第一条语句载入 node:timers。Bun 的 node:timers 首次加载时绑定当时的 globalThis.setInterval，
 * web-dom-* 测试注册 happy-dom 之后才首次加载的话，同进程后面 discord.js 的 `setInterval(...).unref()` 会报 not a function。
 * 子进程里先 register、再首次 require、再 unregister，复现 DOM 测试之后的状态；去掉 preload 那一行这里就红。
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = `
const { GlobalRegistrator } = require("@happy-dom/global-registrator");
GlobalRegistrator.register();
const timers = require("node:timers");
await GlobalRegistrator.unregister();
const handle = timers.setInterval(() => {}, 60_000);
console.log(JSON.stringify({ unref: typeof handle.unref, same: timers.setInterval === globalThis.setInterval }));
timers.clearInterval(handle);
process.exit(0);
`;

test("[验收线 1] 预加载先绑定原生计时器：happy-dom 注册后首次加载的 node:timers 仍有 unref", async () => {
  const proc = Bun.spawn(["env", "-i", `HOME=${process.env.HOME ?? ""}`, `PATH=${process.env.PATH ?? ""}`, process.execPath, "--preload", "./tests/preload.ts", "-e", SCRIPT], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out.trim().split("\n").at(-1) ?? "")).toEqual({ unref: "function", same: true });
}, 60_000);
