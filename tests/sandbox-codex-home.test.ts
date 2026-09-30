/**
 * T73：沙箱 manager / bridge 的 Codex 根（CODEX_HOME）与 ACP 链同一个值，缺失 / 在沙箱根外时定位入口拒绝，
 * 不回落宿主 ~/.codex。全部是假目录：假宿主 HOME 与假沙箱根都在临时目录，不碰真实 ~/.codex。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAcpHome } from "../src/lib/acp/stub.js";
import { codexRolloutRoot } from "../src/lib/codex-home.js";
import { codexAuthPath, readCodexCredential } from "../src/lib/quota-credentials.js";
import { sandboxCodexHomeProblem } from "../src/lib/sandbox.js";
import { sandboxEnv, sandboxLayout } from "../src/lib/sandbox-env.js";
import { codexAuth, fakeCredDeps } from "./quota-fixtures.js";
import { testChildEnv } from "./test-env.js";

const tmp = mkdtempSync(join(tmpdir(), "sbx-codex-home-"));
const hostHome = join(tmp, "host-home"); // 假宿主家目录：它的 .codex 放一份「不该被读」的 rollout
const root = join(tmp, "sbx"); // 假沙箱根
const layout = sandboxLayout(root);
const SID = "019a7373-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const TS = "2026-09-30T01:02:03.000Z";
const cwd = join(root, "work", "cx");
const env = sandboxEnv({ PATH: process.env.PATH, HOME: hostHome, TMPDIR: process.env.TMPDIR }, {
  layout, port: 25173, deny: { ports: [3847], dirs: [join(hostHome, ".claude-orchestrator")] },
});
const withoutCodexHome = (e: Record<string, string>) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "CODEX_HOME"));

function writeRollout(codexHome: string, marker: string): string {
  const p = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T01-02-03-${SID}.jsonl`);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ timestamp: TS, type: "session_meta", payload: { id: SID, cwd, marker } }) + "\n");
  return p;
}

for (const d of [layout.stateDir, layout.runtimeDir, cwd, hostHome]) mkdirSync(d, { recursive: true });
const hostRollout = writeRollout(join(hostHome, ".codex"), "HOST-MUST-NOT-BE-READ");
const sbxRollout = writeRollout(sandboxAcpHome(root).CODEX_HOME, "sandbox");
chmodSync(hostRollout, 0o000); // 宿主那份连读权限都没有：真去读它，首行 id 核对就对不上、归档 ok:false

afterAll(() => {
  chmodSync(hostRollout, 0o644);
  rmSync(tmp, { recursive: true, force: true });
});

const ARCHIVE_SCRIPT = `
const { archiveAgentSession } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/session-archive.ts"))});
const { archiveRoot, cwd, sid } = JSON.parse(process.argv.at(-1));
console.log(JSON.stringify(await archiveAgentSession("agent-cx", { cwd, sessionId: sid, runtime: "codex" }, undefined, { archiveRoot })));
`;

/** 用沙箱环境起子进程归档（paths.ts 的沙箱总闸照常生效） */
function archiveIn(childEnv: Record<string, string>, archiveRoot: string): { ok: boolean; note?: string } {
  const r = Bun.spawnSync([process.execPath, "-e", ARCHIVE_SCRIPT, JSON.stringify({ archiveRoot, cwd, sid: SID })], {
    env: testChildEnv(childEnv), cwd: root,
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
}

describe("sandboxEnv 的 CODEX_HOME", () => {
  test("与 ACP 链的 sandboxAcpHome(root).CODEX_HOME 是同一个值，在沙箱根下", () => {
    expect(env.CODEX_HOME).toBe(sandboxAcpHome(root).CODEX_HOME);
    expect(env.CODEX_HOME.startsWith(`${root}/`)).toBe(true);
    expect(sandboxCodexHomeProblem(env)).toBeNull();
    expect(codexRolloutRoot(env)).toBe(join(sandboxAcpHome(root).CODEX_HOME, "sessions"));
  });

  test("调用者自己的 CODEX_HOME 不继承；沙箱根不是绝对路径照旧抛", () => {
    const e = sandboxEnv({ HOME: hostHome, CODEX_HOME: join(hostHome, ".codex") }, { layout, port: 25173, deny: { ports: [], dirs: [] } });
    expect(e.CODEX_HOME).toBe(sandboxAcpHome(root).CODEX_HOME);
    expect(() => sandboxEnv({}, { layout: sandboxLayout("rel/sbx"), port: 25173, deny: { ports: [], dirs: [] } })).toThrow("不是绝对路径");
  });
});

describe("用沙箱环境归档", () => {
  test("宿主 HOME/.codex 与沙箱 acp-home/.codex 各有一份同 id rollout：只拷沙箱那份", () => {
    const dest = join(tmp, "archive-ok");
    const r = archiveIn(env, dest);
    expect(r.ok).toBe(true);
    const got = readFileSync(join(dest, "agent-cx", `${SID}.jsonl`), "utf8");
    expect(got).toBe(readFileSync(sbxRollout, "utf8"));
    expect(got).not.toContain("HOST-MUST-NOT-BE-READ");
  });

  test("沙箱里 CODEX_HOME 被清掉：归档拒绝（ok:false 带原因），不回落宿主", () => {
    const dest = join(tmp, "archive-refused");
    const r = archiveIn(withoutCodexHome(env), dest);
    expect(r.ok).toBe(false);
    expect(r.note).toContain("没设 CODEX_HOME");
    expect(existsSync(join(dest, "agent-cx"))).toBe(false);
  });
});

describe("沙箱里的 Codex auth.json", () => {
  test("路径落在沙箱根下，读的也是那一份", async () => {
    expect(codexAuthPath(env, hostHome)).toBe(join(sandboxAcpHome(root).CODEX_HOME, "auth.json"));
    const inSbx = join(sandboxAcpHome(root).CODEX_HOME, "auth.json");
    const deps = fakeCredDeps({ env, files: { [inSbx]: codexAuth(), [join(hostHome, ".codex", "auth.json")]: codexAuth() } });
    expect((await readCodexCredential(deps)).ok).toBe(true);
    expect(deps.reads).toEqual([inSbx]);
  });

  test("CODEX_HOME 被清掉 / 指到沙箱根外：路径入口抛错，凭据按 auth_missing 降级且一次都不读", async () => {
    for (const bad of [withoutCodexHome(env), { ...env, CODEX_HOME: join(hostHome, ".codex") }]) {
      expect(() => codexAuthPath(bad, hostHome)).toThrow("沙箱");
      const deps = fakeCredDeps({ env: bad, files: { [join(hostHome, ".codex", "auth.json")]: codexAuth() } });
      expect(await readCodexCredential(deps)).toEqual({ ok: false, code: "auth_missing" });
      expect(deps.reads).toEqual([]);
    }
  });
});

describe("Codex 会话根的定位入口", () => {
  test("沙箱里 CODEX_HOME 缺失 / 相对路径 / 在沙箱根外 / 正好是沙箱根：拒绝，不回落 ~/.codex", () => {
    expect(() => codexRolloutRoot(withoutCodexHome(env))).toThrow("没设 CODEX_HOME");
    expect(() => codexRolloutRoot({ ...env, CODEX_HOME: "acp-home/.codex" })).toThrow("绝对路径");
    expect(() => codexRolloutRoot({ ...env, CODEX_HOME: join(hostHome, ".codex") })).toThrow("不在沙箱根");
    expect(() => codexRolloutRoot({ ...env, CODEX_HOME: `${root}/../host-home/.codex` })).toThrow("不在沙箱根");
    expect(() => codexRolloutRoot({ ...env, CODEX_HOME: root })).toThrow("不在沙箱根");
  });

  test("生产（非沙箱）行为不变：CODEX_HOME 优先，没设才是 ~/.codex（只算路径，不读）", () => {
    expect(codexRolloutRoot({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/sessions");
    expect(codexRolloutRoot({})).toMatch(/\/\.codex\/sessions$/);
    expect(codexAuthPath({}, "/home/u")).toBe("/home/u/.codex/auth.json");
    expect(sandboxCodexHomeProblem({ CODEX_HOME: "/anywhere" })).toBeNull();
  });
});
