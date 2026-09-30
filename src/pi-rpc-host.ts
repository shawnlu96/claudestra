/**
 * Pi 直连 rpc 宿主（spike，docs/design/pi-acp-eval.md）：在 agent 的 tmux 窗口里代替 Pi 的 TUI 运行，
 * 起 `pi --mode rpc <原来那套参数>`，窗口只显示可读日志。收发消息、工具、回合结束、打断仍全部走 Claudestra 扩展的 ws
 * （rpc 模式下扩展照常加载，实测），这里只做三件事：
 * - 窗口里的一行输入翻成 rpc 命令（lib/pi-rpc.ts actionForLine）：bridge 发的 /clear、/claudestra-model、/quit 不用改；
 * - 空闲时在最后一行画 `❯`：bridge 的 /clear 前置检查（paneLooksIdle）据此放行，回合中不画；
 * - C-c：回合中 = abort，空闲 = 退出（关 Pi 的 stdin，Pi 自己收尾）。Pi 退出宿主跟着退，退出码照传。
 * 用法：bun src/pi-rpc-host.ts <pi 可执行文件> [pi 参数…]（lib/pi-launch.ts 生成）。
 */
import { actionForLine, autoAnswer, renderEvent, splitJsonl } from "./lib/pi-rpc.js";

const [piBin, ...piArgs] = process.argv.slice(2);
if (!piBin) {
  console.error("用法：bun src/pi-rpc-host.ts <pi> [参数…]");
  process.exit(2);
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (line: string) => console.log(`[${stamp()}] ${line}`);
const pi = Bun.spawn([piBin, "--mode", "rpc", ...piArgs], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
let busy = false;
let quitting = false;
let seq = 0;

const send = (cmd: Record<string, unknown>) => {
  try {
    pi.stdin.write(`${JSON.stringify({ id: `h${++seq}`, ...cmd })}\n`);
  } catch (e) {
    say(`⚠ 写不进 Pi 的 stdin（多半已退出）：${e}`);
  }
};
const idlePrompt = () => !busy && !quitting && console.log("❯");

function quit(why: string) {
  if (quitting) return;
  quitting = true;
  say(`退出（${why}）`);
  try {
    pi.stdin.end();
  } catch {
    /* 已关：Pi 正在退，等 exited 即可 */
  }
  setTimeout(() => pi.exitCode === null && pi.kill("SIGTERM"), 5_000).unref?.();
}

async function pumpStdout() {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of pi.stdout) {
    const out = splitJsonl(rest + dec.decode(chunk, { stream: true }));
    rest = out.rest;
    for (const line of out.lines) {
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        say(`(非协议输出) ${line.slice(0, 200)}`); // Pi 的 stdout 只该有协议记录；有别的说明版本变了，打出来便于排查
        continue;
      }
      const answer = autoAnswer(e);
      if (answer) (send(answer), say(`⚠ 扩展弹了 ${e.method} 对话框，无人可答，已取消：${e.title ?? ""}`));
      if (e.type === "agent_start") busy = true;
      const shown = renderEvent(e);
      if (shown) say(shown);
      if (e.type === "agent_settled") (busy = false, idlePrompt());
    }
  }
}

async function pumpStderr() {
  const dec = new TextDecoder();
  for await (const chunk of pi.stderr) for (const l of dec.decode(chunk).split("\n")) if (l.trim()) say(`[pi] ${l.slice(0, 300)}`);
}

async function pumpInput() {
  for await (const line of console) {
    const a = actionForLine(line, busy);
    if (a.kind === "quit") quit(line.trim());
    else if (a.kind === "rpc") send(a.cmd);
  }
}

process.on("SIGINT", () => (busy ? (say("打断当前回合"), send({ type: "abort" })) : quit("C-c")));
process.on("SIGTERM", () => quit("SIGTERM"));
process.on("SIGHUP", () => quit("SIGHUP"));

say(`起 Pi（rpc）：${piBin} --mode rpc …`);
void pumpStdout().catch((e) => say(`读 Pi 输出出错：${e}`));
void pumpStderr().catch((e) => say(`读 Pi stderr 出错：${e}`));
void pumpInput().catch((e) => say(`读窗口输入出错：${e}`));
setTimeout(idlePrompt, 1_500).unref?.();
const code = await pi.exited;
say(`Pi 退出（code ${code}）`);
process.exit(code);
