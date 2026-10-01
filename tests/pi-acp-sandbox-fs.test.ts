/**
 * 沙箱 Pi 状态的真实路径边界与凭据权限（#301 r1 P1-1/P1-2）：目录链接、文件链接、上次中断留下的 tmp（链接 / 0644 普通文件）、
 * 已存在的 0755 目录、不同 umask。读侧：链接到根外的会话目录 / 文件当不存在；写侧：不跟链接写到根外，最终一定是 0700 目录 + 0600 文件。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPiSessionBySessionId, listPiSessionJsonls, piSessionPath, piSessionsDir } from "../src/lib/pi-session.ts";
import { piAdapter } from "../src/lib/runtimes/pi.ts";
import { piMountProblem } from "../src/lib/acp/pi-adapter/main.ts";
import { SANDBOX_PI_FLAGS, sandboxPiProblem } from "../src/lib/acp/pi-adapter/sandbox-policy.ts";
import { sandboxPiAgentDirProblem } from "../src/lib/sandbox.ts";
import { assertSandboxSession } from "../src/lib/sandbox-sessions.ts";
import { copyPiCredential } from "../scripts/sandbox-pi-auth.ts";

const KEYS = ["CLAUDESTRA_SANDBOX", "CLAUDESTRA_SANDBOX_ROOT", "PI_CODING_AGENT_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** 一个新沙箱根 + 根外的一块「owner 地盘」 */
function world() {
  const base = mkdtempSync(join(tmpdir(), "pi-sbx-fs-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const piDir = join(root, "pi-agent");
  const env = { CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: root, PI_CODING_AGENT_DIR: piDir };
  return { root, outside, piDir, env };
}

const session = (dir: string, id: string, cwd: string) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`);
  return f;
};

describe("读侧：会话目录 / 文件经链接指到根外的当不存在", () => {
  test("Pi 目录本身是链接：起 pi 前的闸拒（字面路径对也不行）", () => {
    const w = world();
    symlinkSync(w.outside, w.piDir);
    expect(sandboxPiAgentDirProblem(w.env)).toContain("符号链接");
    const w2 = world();
    expect(sandboxPiAgentDirProblem(w2.env)).toBeNull(); // 还不存在：pi 会在根下新建
    mkdirSync(w2.piDir);
    expect(sandboxPiAgentDirProblem(w2.env)).toBeNull();
  });

  test("Pi 目录是真实目录、里面的全局文件 / sessions 是指向根外的链接：起 pi 前三处闸都拒；根内链接与不存在的放行", () => {
    const cases: [string, (w: ReturnType<typeof world>) => void][] = [
      ["auth.json", (w) => (writeFileSync(join(w.outside, "auth.json"), "{}"), symlinkSync(join(w.outside, "auth.json"), join(w.piDir, "auth.json")))],
      ["settings.json", (w) => (writeFileSync(join(w.outside, "s.json"), "{}"), symlinkSync(join(w.outside, "s.json"), join(w.piDir, "settings.json")))],
      ["sessions", (w) => symlinkSync(w.outside, join(w.piDir, "sessions"))],
      ["mcp.json", (w) => symlinkSync(join(w.outside, "nope.json"), join(w.piDir, "mcp.json"))], // 悬空链接：pi 写它会落到根外
    ];
    for (const [name, plant] of cases) {
      const w = world();
      mkdirSync(w.piDir);
      plant(w);
      expect({ name, v: sandboxPiAgentDirProblem(w.env) }).toEqual({ name, v: expect.stringContaining(join(w.piDir, name)) });
      expect({ name, v: sandboxPiProblem(w.env, [...SANDBOX_PI_FLAGS]) }).toEqual({ name, v: expect.stringContaining(name) }); // 宿主起适配器前
      expect({ name, v: piMountProblem(["claudestra"], w.root, [], w.env) }).toEqual({ name, v: expect.stringContaining(name) }); // 适配器每次起 pi（含 /clear）
    }
    const ok = world();
    mkdirSync(join(ok.piDir, "sessions"), { recursive: true });
    writeFileSync(join(ok.root, "real-settings.json"), "{}");
    symlinkSync(join(ok.root, "real-settings.json"), join(ok.piDir, "settings.json")); // 指向根内：放行
    expect(sandboxPiAgentDirProblem(ok.env)).toBeNull();
    expect(piMountProblem(["claudestra"], ok.root, [], ok.env)).toBeNull();
  });

  test("会话项目目录是链接、会话文件是链接：查找 / 列表 / 扫描都看不见，set-session 拒；根内的真会话照常", async () => {
    const w = world();
    const work = join(w.root, "work");
    mkdirSync(work);
    const sessions = join(w.piDir, "sessions");
    const own = piSessionsDir(work, w.piDir);
    const okFile = session(own, "pi-ok", work);
    session(join(w.outside, "proj"), "pi-dirlink", work); // cwd 在沙箱里，但文件在根外
    symlinkSync(join(w.outside, "proj"), join(sessions, "--dirlink--"));
    const outFile = session(join(w.outside, "single"), "pi-filelink", work);
    symlinkSync(outFile, join(own, `2026-10-01T00-00-00-000Z_pi-filelink.jsonl`));
    Object.assign(process.env, w.env);

    expect(findPiSessionBySessionId("pi-ok")).toBe(okFile);
    expect(findPiSessionBySessionId("pi-dirlink")).toBeNull();
    expect(findPiSessionBySessionId("pi-filelink")).toBeNull();
    expect(piSessionPath(work, "pi-filelink")).toBeNull();
    expect(() => assertSandboxSession("pi-ok")).not.toThrow();
    expect(() => assertSandboxSession("pi-dirlink")).toThrow("找不到会话");
    expect(() => assertSandboxSession("pi-filelink")).toThrow("找不到会话");
    const scanned = (await piAdapter.scanSessions!()).map((s) => s.sessionId).sort();
    expect(scanned).toEqual(["pi-ok"]);
    expect(listPiSessionJsonls(work)).toEqual([okFile]);

    delete process.env.CLAUDESTRA_SANDBOX; // 生产不查真实路径（生产的会话目录本来就可能是链接）
    expect(findPiSessionBySessionId("pi-dirlink", w.piDir)).toContain("--dirlink--");
  });
});

describe("写侧：pi-auth 不跟链接写到根外", () => {
  const src = mkdtempSync(join(tmpdir(), "pi-sbx-src-"));
  writeFileSync(join(src, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "sk-SECRET" } }));

  test("目标目录是链接：拒，根外目录里什么都没写", () => {
    const w = world();
    symlinkSync(w.outside, w.piDir);
    expect(copyPiCredential("deepseek", src, w.piDir, w.root)).toEqual({ error: expect.stringContaining("符号链接") });
    expect(existsSync(join(w.outside, "auth.json"))).toBe(false);
  });

  test("已有的 auth.json 是链接：拒，根外文件原样", () => {
    const w = world();
    mkdirSync(w.piDir);
    writeFileSync(join(w.outside, "victim.json"), "{}");
    symlinkSync(join(w.outside, "victim.json"), join(w.piDir, "auth.json"));
    expect(copyPiCredential("deepseek", src, w.piDir, w.root)).toEqual({ error: expect.stringContaining(join(w.piDir, "auth.json")) }); // 目录闸先拦
    expect(readFileSync(join(w.outside, "victim.json"), "utf8")).toBe("{}");
  });

  test("上次中断留下的固定名 tmp 是链接 / 0644 普通文件：都不复用，最终 auth.json 是新 inode 的 0600", () => {
    const w = world();
    mkdirSync(w.piDir);
    writeFileSync(join(w.outside, "victim.json"), "untouched");
    symlinkSync(join(w.outside, "victim.json"), join(w.piDir, "auth.json.tmp"));
    writeFileSync(join(w.piDir, "models.json.tmp"), "old", { mode: 0o644 });
    const oldTmp = statSync(join(w.piDir, "models.json.tmp")).ino;
    expect(copyPiCredential("deepseek", src, w.piDir, w.root)).toEqual({ written: [join(w.piDir, "auth.json")] });
    expect(readFileSync(join(w.outside, "victim.json"), "utf8")).toBe("untouched");
    const st = lstatSync(join(w.piDir, "auth.json"));
    expect([st.isFile(), st.mode & 0o777, st.ino === oldTmp]).toEqual([true, 0o600, false]);
  });

  test("已存在的 0755 目录改成 0700；不同 umask 下新建的目录 / 文件也一定是 0700 / 0600", () => {
    for (const mask of [0o000, 0o022, 0o277]) {
      const w = world();
      if (mask === 0o022) mkdirSync(w.piDir, { mode: 0o755 }), chmodSync(w.piDir, 0o755);
      const prev = process.umask(mask);
      try {
        expect(copyPiCredential("deepseek", src, w.piDir, w.root)).toEqual({ written: [join(w.piDir, "auth.json")] });
      } finally {
        process.umask(prev);
      }
      expect({ mask, dir: statSync(w.piDir).mode & 0o777, file: statSync(join(w.piDir, "auth.json")).mode & 0o777 }).toEqual({ mask, dir: 0o700, file: 0o600 });
    }
  });
});
