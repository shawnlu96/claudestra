/**
 * /api/v1 早退分支的响应钉子（D5-5 的前置）：401 / 全权 403 / scope 403 / 坏 JSON 400 /
 * 非法路径编码 / 活会话 409。收敛样板代码（requireFullScope / notInScope / readJsonBody）
 * 前后，这些请求的 status + Content-Type + body 必须逐字节一致。
 *
 * 请求在子进程里跑（见 api-route-parity.runner.ts 头注释：临时 HOME，不碰真实状态）。
 * 期望值在 api-route-parity.golden.json；有意改行为时用
 *   UPDATE_API_GOLDEN=1 bun test tests/api-route-parity.test.ts
 * 重新生成，并在 commit 里说明哪一条变了、为什么。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Spec = { name: string; method: string; path: string; token?: "full" | "scoped" | "bogus"; body?: string; liveSession?: string };

const BAD = "{";
const specs: Spec[] = [
  { name: "no-auth", method: "GET", path: "/api/v1/agents" },
  { name: "bad-token", method: "GET", path: "/api/v1/agents", token: "bogus" },
  // ── 全权 token 才能用的端点，受限 token → 403（各自文案） ──
  ...([
    ["GET", "/api/v1/pi-models"],
    ["GET", "/api/v1/remote-access"],
    ["POST", "/api/v1/agents/a1/pi-settings"],
    ["POST", "/api/v1/sessions/x/cleanup"],
    ["POST", "/api/v1/sessions/x/adopt"],
    ["POST", "/api/v1/agents/a1/archive"],
    ["GET", "/api/v1/settings/archive-retention"],
    ["POST", "/api/v1/sessions/archived/x/restore"],
    ["GET", "/api/v1/sessions/archived"],
    ["POST", "/api/v1/sessions/x/manage"],
    ["GET", "/api/v1/sessions/x/history"],
    ["GET", "/api/v1/session-list"],
    ["POST", "/api/v1/agents"],
    ["POST", "/api/v1/agents/resume"],
    ["GET", "/api/v1/config/claude-defaults"],
    ["POST", "/api/v1/agents/a1/kill"],
    ["GET", "/api/v1/cron"],
    ["GET", "/api/v1/auto-compact"],
    ["POST", "/api/v1/update"],
    ["POST", "/api/v1/restart-all"],
    ["GET", "/api/v1/restart-all/log"],
    ["GET", "/api/v1/update/log"],
    ["GET", "/api/v1/projects"],
    ["GET", "/api/v1/memory-hygiene"],
    ["GET", "/api/v1/peers"],
  ] as const).map(([method, path]) => ({ name: `full-403 ${method} ${path}`, method, path, token: "scoped" as const })),
  // ── agent 不在 token scope → 403 ──
  ...([
    ["GET", "/api/v1/agents/zz/bg-tasks"],
    ["GET", "/api/v1/history/search?agent=zz&q=xx"],
    ["GET", "/api/v1/agents/zz/tasks"],
    ["GET", "/api/v1/agents/zz/history"],
    ["GET", "/api/v1/agents/zz/history/abc"],
    ["POST", "/api/v1/agents/zz/messages"],
    ["GET", "/api/v1/agents/zz/skills"],
    ["POST", "/api/v1/agents/zz/interrupt"],
    ["POST", "/api/v1/agents/zz/clear"],
    ["POST", "/api/v1/agents/zz/claude-settings"],
    ["POST", "/api/v1/agents/zz/answer"],
    ["GET", "/api/v1/agents/zz/pending"],
    ["POST", "/api/v1/agents/zz/notify-read"],
  ] as const).map(([method, path]) => ({ name: `scope-403 ${method} ${path}`, method, path, token: "scoped" as const })),
  { name: "scope-403 pi-settings master", method: "POST", path: "/api/v1/agents/master/pi-settings", token: "full" },
  // ── 坏 JSON body → 400 ──
  { name: "json-400 peers/redeem", method: "POST", path: "/api/v1/peers/redeem", body: BAD },
  ...([
    ["POST", "/api/v1/agents/a1/pi-settings"],
    ["POST", "/api/v1/agents/a1/claude-settings"],
    ["PUT", "/api/v1/config/claude-defaults"],
    ["POST", "/api/v1/cron"],
    ["POST", "/api/v1/cron/x/edit"],
    ["POST", "/api/v1/auto-compact"],
    ["POST", "/api/v1/projects"],
    ["POST", "/api/v1/memory-hygiene"],
    ["POST", "/api/v1/peers/invite-new"],
    ["POST", "/api/v1/peers/invite"],
    ["POST", "/api/v1/peers/x/scope"],
    ["POST", "/api/v1/agents"],
    ["POST", "/api/v1/agents/resume"],
  ] as const).map(([method, path]) => ({ name: `json-400 ${method} ${path}`, method, path, token: "full" as const, body: BAD })),
  // ── D5-11：非法百分号编码（decodeURIComponent 抛 URIError）→ 400 JSON，不是 Bun 的 HTML 500 ──
  { name: "bad-encoding skills", method: "GET", path: "/api/v1/agents/%E0%A4%A/skills", token: "full" },
  { name: "bad-encoding history", method: "GET", path: "/api/v1/agents/%E0%A4%A/history", token: "full" },
  // ── D1-5：目标会话正被本机活的 interactive Claude Code 占着、又没带 fork/takeover → 409 ──
  //    （runner 在自己的 pid 上伪造登记；body 里的 pid 被替换成 <pid> 以便 golden 稳定）
  {
    name: "resume-409 live session",
    method: "POST",
    path: "/api/v1/agents/resume",
    token: "full",
    body: JSON.stringify({ agent: "t1", sessionId: "11111111-2222-3333-4444-555555555555" }),
    liveSession: "11111111-2222-3333-4444-555555555555",
  },
];

test("早退分支响应逐字节不变（golden）", () => {
  const home = mkdtempSync(join(tmpdir(), "api-parity-"));
  try {
    // 沙箱：子进程 PATH 里的 bun / tmux 都是假的。runManager 按 PATH 找 bun 去 spawn manager，
    // tmux 包装按 PATH 找 tmux（而 socket 是写死的 master.sock）——万一哪个改动让请求越过了
    // 早退分支，拿到的也只是假 manager 的 ok:false（golden 对不上而失败），碰不到真实 tmux / registry。
    const fakeBin = join(home, "fakebin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "bun"), `#!/bin/sh\necho '{"ok":false,"error":"manager blocked in parity runner"}'\n`, { mode: 0o755 });
    writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "api-route-parity.runner.ts"), JSON.stringify(specs)], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, CONTROL_CHANNEL_ID: "", LANG: "C" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = r.stdout.toString().trim().split("\n");
    if (r.exitCode !== 0 || !lines.length) throw new Error(`runner failed: ${r.stderr.toString().slice(-2000)}`);
    const got = JSON.parse(lines[lines.length - 1]);
    const goldenPath = join(import.meta.dir, "api-route-parity.golden.json");
    if (process.env.UPDATE_API_GOLDEN === "1") {
      writeFileSync(goldenPath, JSON.stringify(got, null, 2) + "\n");
    }
    expect(got).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
