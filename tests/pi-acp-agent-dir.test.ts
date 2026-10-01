/**
 * PI_CODING_AGENT_DIR 的 `~` / file:// 写法（#300 r1 P1-2）：三层撞名检查（manager 切换预检、起窗口预检、适配器每次起 pi）、
 * 交给 pi 的环境、pi 里的挂载扩展都按 Pi 的规则算目录，查的文件 = Pi 实际读的文件。判据是上游原样移植的 normalizePath / getAgentDir。
 * bun 的 os.homedir() 进程内不跟 HOME 变，所以 `~` 的场景在临时 HOME 的子进程里跑。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { piChildEnv } from "../src/lib/acp/pi-adapter/main.ts";
import { normalizePiPath, piAgentDirOf } from "../src/lib/pi-path.ts";
import { getAgentDir, normalizePath } from "./pi-upstream-0.99.2.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("normalizePiPath = 上游 normalizePath（缺省选项）", () => {
  test("逐个输入对拍", () => {
    for (const input of ["~", "~/", "~/a/b", "~x", "~\\a", " ~/a", "/abs/x", "rel/x", "file:///tmp/a%20b", "file://localhost/tmp/x", "file:/nope", ""]) {
      expect({ input, got: normalizePiPath(input) }).toEqual({ input, got: normalizePath(input) });
    }
  });

  test("相对路径按会话 cwd 转成绝对（pi 在会话 cwd 里按相对路径读）；没设回落 ~/.pi/agent", () => {
    expect(piAgentDirOf({ PI_CODING_AGENT_DIR: "rel-agent" }, "/w/s")).toBe("/w/s/rel-agent");
    expect(piAgentDirOf({ PI_CODING_AGENT_DIR: "rel-agent" })).toBe("rel-agent");
    expect(piAgentDirOf({})).toBe(normalizePath("~/.pi/agent"));
    for (const raw of [undefined, "", "/abs/agent", "rel-agent", "~", "~/x", "file:///tmp/a%20b"]) {
      expect({ raw, ours: piAgentDirOf({ PI_CODING_AGENT_DIR: raw }) }).toEqual({ raw, ours: getAgentDir({ PI_CODING_AGENT_DIR: raw }) });
    }
  });
});

/** 子进程（HOME=临时目录）里把每一层都跑一遍，回传它们查的目录 / 结论，和上游 getAgentDir 的目录比 */
const PROBE = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from ${JSON.stringify(join(REPO, "tests/pi-upstream-0.99.2.ts"))};
import { piAgentDirOf } from ${JSON.stringify(join(REPO, "src/lib/pi-path.ts"))};
import { piAcpClash } from ${JSON.stringify(join(REPO, "src/lib/runtimes/pi-acp.ts"))};
import { transportRefusal } from ${JSON.stringify(join(REPO, "src/manager/acp-lifecycle.ts"))};
import { piChildEnv, piMountProblem } from ${JSON.stringify(join(REPO, "src/lib/acp/pi-adapter/main.ts"))};
import mount, { PI_MCP_SERVERS_ENV } from ${JSON.stringify(join(REPO, "src/lib/acp/pi-adapter/mcp-mount.ts"))};
const cwd = process.env.PROBE_CWD;
const env = { ...process.env };
const piDir = getAgentDir(env);
let status = null;
const mountEnv = { ...env, [PI_MCP_SERVERS_ENV]: JSON.stringify({ claudestra: { command: "x" } }) };
let started;
await mount({ on: (_e, h) => void (started = h({}, { cwd, ui: { setStatus: (_k, t) => (status = t) } })), getActiveTools: () => [] }, mountEnv, async () => {});
await started;
console.log(JSON.stringify({
  piDir, piReads: existsSync(join(piDir, "mcp.json")), ours: piAgentDirOf(env, cwd), childEnv: piChildEnv(env, {}, cwd).PI_CODING_AGENT_DIR,
  manager: piAcpClash(cwd, env), transport: transportRefusal({ runtime: "pi", cwd }, "x", "acp", env),
  adapter: piMountProblem(["claudestra"], cwd, [], env), mount: status,
}));
`;

describe("~ / file:// 写法：每一层都查到 Pi 实际读的那份 mcp.json", () => {
  const home = join(root, "home");
  const cwd = join(root, "work");
  mkdirSync(join(home, "agent-config"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, "agent-config", "mcp.json"), JSON.stringify({ mcpServers: { claudestra: { command: "evil", exposure: "hidden" } } }));
  const probe = join(root, "probe.ts");
  writeFileSync(probe, PROBE);

  for (const raw of ["~/agent-config", `file://${join(home, "agent-config")}`]) {
    test(`PI_CODING_AGENT_DIR=${raw.startsWith("~") ? raw : "file://<HOME>/agent-config"}`, () => {
      const r = Bun.spawnSync([process.execPath, probe], { env: testChildEnv({ HOME: home, PI_CODING_AGENT_DIR: raw, PROBE_CWD: cwd }), cwd });
      expect(r.exitCode, r.stderr.toString()).toBe(0);
      const got = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
      expect(got.piDir).toBe(join(home, "agent-config"));
      expect(got.piReads).toBe(true);
      expect(got.ours).toBe(got.piDir);
      expect(got.childEnv).toBe(got.piDir);
      for (const layer of ["manager", "transport", "adapter", "mount"]) expect({ layer, v: got[layer] }).toEqual({ layer, v: expect.stringContaining("顶掉") });
    }, 20_000);
  }

  test("交给 pi 的环境：相对路径按会话 cwd 解析成绝对路径；没设就不加", () => {
    expect(piChildEnv({ PI_CODING_AGENT_DIR: "rel", A: "1" }, { B: "2" }, cwd)).toEqual({ PI_CODING_AGENT_DIR: resolve(cwd, "rel"), A: "1", B: "2" });
    expect(piChildEnv({ A: "1" }, {}, cwd)).toEqual({ A: "1" });
  });
});
