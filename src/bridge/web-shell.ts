/**
 * 网页「新终端」：在独立 tmux session（lib/web-shell-policy.ts SHELL_SESSION，同一私有 socket）里按需开登录 shell，
 * 连接走与 agent 终端相同的 viewer（term-viewer.ts）。shell 与 viewer 解耦：网页断开（手机切后台）只回收 viewer，
 * shell 留着下次接上；只有显式关闭才 kill-window。鉴权见 terminal-auth.ts shellAllowed，四个端点都要。
 *   GET    /api/v1/shells               → {shells:[{id,cwd}], dirs:[{label,dir}], home, max}
 *   POST   /api/v1/shells {dir?}        → {shell:{id,cwd}}（dir 只收 dirs 里的，缺省家目录）
 *   DELETE /api/v1/shells/:id           → kill-window
 *   GET    /api/v1/shells/:id/terminal  → SSE（同 agent 终端）
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { readProjects } from "../lib/projects.js";
import { sandboxAgentDirProblem } from "../lib/sandbox.js";
import {
  isShellId, MAX_SHELLS, newShellId, parseShellWindow, resolveShellDir, SHELL_SESSION, shellDirChoices, shellTarget, shellWindowName,
  type ShellDir,
} from "../lib/web-shell-policy.js";
import { SHELL_AUTH_AGENT, shellAllowed } from "./terminal-auth.js";
import { tmuxRun } from "./term-fit.js";
import { authNoLimit, json, openTerminal } from "./term-viewer.js";

const HOME = process.env.HOME || "/";

interface ShellInfo {
  id: string;
  cwd: string;
}

/** 列 webshell session 的窗口；count 含改过名、不可寻址的窗口（上限按它算） */
async function readShells(): Promise<{ shells: ShellInfo[]; count: number }> {
  const r = await tmuxRun(["list-windows", "-t", `=${SHELL_SESSION}`, "-F", "#{window_name}\t#{pane_current_path}"]);
  if (r.code !== 0 || !r.out) return { shells: [], count: 0 }; // session 不在 = 一个都没开（最后一个窗口关掉时 tmux 自己收掉 session）
  const lines = r.out.split("\n");
  const shells = lines.flatMap((l) => {
    const [name, cwd = ""] = l.split("\t");
    const id = parseShellWindow(name);
    return id ? [{ id, cwd }] : [];
  });
  return { shells, count: lines.length };
}

/** 存在的目录才给选；沙箱里只给沙箱根下的（与 new-window 的沙箱闸同口径，生产恒为 null） */
function usableDir(d: string): boolean {
  try {
    return statSync(d).isDirectory() && !sandboxAgentDirProblem(d);
  } catch {
    return false; // 登记了但还没 clone / 已删的目录：不给选
  }
}

async function dirChoices(): Promise<ShellDir[]> {
  return shellDirChoices(HOME, (await readProjects()).projects, usableDir);
}

/** 新建串行：数上限 + 建窗口之间有 await，并发两次 POST 会一起读到「没满」 */
let createChain: Promise<unknown> = Promise.resolve();

async function createShell(dir: string): Promise<ShellInfo | string> {
  const { shells, count } = await readShells();
  if (count >= MAX_SHELLS) return `too many shells (max ${MAX_SHELLS}) — close one first`;
  const id = newShellId(new Set(shells.map((s) => s.id)), () => randomBytes(3).toString("hex"));
  const name = shellWindowName(id);
  // 不带命令 = tmux 按 default-shell 起登录 shell；-n 起名同时关掉 automatic-rename，名字就是寻址键
  const r = count > 0
    ? await tmuxRun(["new-window", "-d", "-t", `=${SHELL_SESSION}:`, "-n", name, "-c", dir])
    : await tmuxRun(["new-session", "-d", "-s", SHELL_SESSION, "-n", name, "-c", dir, "-x", "100", "-y", "30"]);
  if (r.code !== 0) return `tmux failed: ${r.err}`;
  console.log(`🖥️ [shell] created ${id} cwd=${dir}`);
  return { id, cwd: dir };
}

async function handleCreate(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { dir?: unknown }; // 空体 / 非 JSON = 没指定目录，按家目录开
  const dir = resolveShellDir(body.dir, await dirChoices());
  if (!dir) return json(400, { ok: false, error: "dir must be one of the listed choices (home or a registered project directory)" });
  const run = createChain.then(() => createShell(dir));
  createChain = run.catch(() => undefined); // 这次失败由下面的 await 报给调用方，链本身要能继续排下一个
  try {
    const res = await run;
    return typeof res === "string" ? json(409, { ok: false, error: res }) : json(200, { ok: true, shell: res });
  } catch (e) {
    return json(500, { ok: false, error: `create shell failed: ${(e as Error).message}` }); // 沙箱闸拒绝等会抛到这里
  }
}

export async function handleShellApi(req: Request, url: URL, path: string): Promise<Response | null> {
  const m = path.match(/^\/shells(?:\/([^/]+)(\/terminal)?)?$/);
  if (!m) return null;
  const auth = await authNoLimit(req);
  if (auth instanceof Response) return auth;
  if (!shellAllowed(auth)) {
    return json(403, { ok: false, error: "host shell needs terminal access that covers master (pair with terminal on)" });
  }
  const [, id, terminal] = m;
  if (!id) {
    if (req.method === "GET") {
      const [{ shells }, dirs] = await Promise.all([readShells(), dirChoices()]);
      return json(200, { ok: true, shells, dirs, home: HOME, max: MAX_SHELLS });
    }
    return req.method === "POST" ? handleCreate(req) : null;
  }
  if (!isShellId(id)) return json(404, { ok: false, error: "no such shell" });
  if (terminal && req.method === "GET") {
    return openTerminal(auth, url, {
      authAgent: SHELL_AUTH_AGENT,
      label: `shell "${id}"`,
      resolve: async () => ((await readShells()).shells.some((s) => s.id === id) ? shellTarget(id) : null),
    }, req.signal);
  }
  if (!terminal && req.method === "DELETE") {
    // 连着的 viewer 不用单独收：窗口没了 viewer session 随之空掉退出，PTY exit 走正常收尾
    const r = await tmuxRun(["kill-window", "-t", shellTarget(id)]);
    if (r.code !== 0) return json(404, { ok: false, error: "no such shell" });
    console.log(`🖥️ [shell] closed ${id}`);
    return json(200, { ok: true });
  }
  return null;
}
