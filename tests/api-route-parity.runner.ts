/**
 * api-route-parity.test.ts 的子进程执行体（不是测试文件本身）。
 *
 * 为什么要子进程：api-routes 的依赖在 import 时就按 HOME 定好了路径（principals.json、
 * cron 的日志目录……），而 bun test 的所有测试文件共用一个模块缓存——在测试进程里改 HOME
 * 已经晚了，会读到真实的 ~/.claude-orchestrator。这里由父进程带着临时 HOME 起一个干净的
 * bun，import 时一切都落在临时目录里。
 *
 * 选的请求都在 runManager / tmux 之前就返回（403 / 400 / 401 / 409 这些早退分支），
 * 不会 spawn manager、也不会碰 master.sock。
 *
 * 输入：argv[2] = JSON 请求清单；输出：stdout 一行 JSON 结果数组。
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

interface Spec {
  name: string;
  method: string;
  path: string;
  token?: "full" | "scoped" | "bogus";
  body?: string;
  /** 在本进程 pid 上伪造一条「活的 interactive Claude Code」登记，sessionId 取这个值 */
  liveSession?: string;
}

const specs: Spec[] = JSON.parse(process.argv[2] || "[]");
const home = process.env.HOME!;

// 两个 token：全权（"*"）与只含 a1 的受限 token
const cfg = join(home, ".claude-orchestrator");
mkdirSync(cfg, { recursive: true });
writeFileSync(
  join(cfg, "principals.json"),
  JSON.stringify({
    principals: [
      { id: "token:tok_full", role: "owner", name: "full", agents: ["*"], secret: "s-full", createdAt: "2026-01-01T00:00:00Z" },
      { id: "token:tok_scoped", role: "external", name: "scoped", agents: ["a1"], secret: "s-scoped", createdAt: "2026-01-01T00:00:00Z" },
    ],
  }),
);

function psLstart(pid: number): string {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.stdout.toString().trim();
}

const { initApiRoutes, handleApiRequest } = await import("../src/bridge/api-routes.ts");
initApiRoutes({
  clients: new Map(),
  deliver: async () => {
    throw new Error("deliver must not be reached in parity runner");
  },
  mirrorApiExchange: async () => {},
  startTypingWithSafety: () => {},
  lastMessageSource: new Map(),
  handleEventsRequest: () => new Response("events"),
  scheduleClearRotation: () => {},
});

const out: unknown[] = [];
for (const s of specs) {
  if (s.liveSession) {
    const dir = join(home, ".claude", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: s.liveSession, cwd: home, kind: "interactive", procStart: psLstart(process.pid) }),
    );
  }
  const headers: Record<string, string> = {};
  if (s.token) headers.Authorization = `Bearer ${s.token === "full" ? "s-full" : s.token === "scoped" ? "s-scoped" : "nope"}`;
  if (s.body !== undefined) headers["Content-Type"] = "application/json";
  const url = `http://127.0.0.1:3847${s.path}`;
  const req = new Request(url, { method: s.method, headers, body: s.body });
  try {
    const res = await Promise.race([
      handleApiRequest(req, new URL(url)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
    ]);
    out.push({ name: s.name, status: res.status, contentType: res.headers.get("Content-Type"), body: await res.text() });
  } catch (e) {
    out.push({ name: s.name, threw: (e as Error).name, message: (e as Error).message });
  }
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
