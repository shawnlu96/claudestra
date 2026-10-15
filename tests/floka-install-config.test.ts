import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rollbackInstallConfig, runInstallConfig } from "../src/lib/floka-install-config/run.ts";
import { familyAllow, familyToolName, planEnvText, planInstallConfig, planTemplate } from "../src/lib/floka-install-config/plan.ts";
import { chooseFreshStateRoot } from "../src/lib/floka-install-config/fresh-root.ts";
import { installConfigWarnings } from "../src/lib/floka-install-config/install.ts";
import { defaultStateRoot } from "../src/lib/floka-config/default-root.ts";
import { LEGACY_FAMILY, NEW_FAMILY } from "../src/lib/floka-mcp/families.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `floka-installcfg-${name}-`)); roots.push(d); return d; };

const OLD_ALLOW = familyAllow(LEGACY_FAMILY), NEW_ALLOW = familyAllow(NEW_FAMILY);
const ENV_TEXT = [
  "# 用户自己的注释",
  "DISCORD_BOT_TOKEN=keep-me-untouched",
  "MCP_NAME=claudestra",
  "CLAUDESTRA_STATE_DIR=/srv/state",
  "export CLAUDESTRA_ACP_MODEL=\"opus\"",
  "CLAUDESTRA_PI_ARGS=--a",
  "FLOKA_PI_ARGS=--user-choice",
  "CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN=secret-not-twinned",
  "",
].join("\n");

/** 临时 HOME + 临时仓库：settings（旧 allow、用户 allow、本仓 hook、别的插件 hook）、.env、三种 skills 软链 */
function fixture() {
  const home = tmp("home"), repoRoot = tmp("repo"), journalDir = join(home, ".claudestra-maintenance", "install-config");
  mkdirSync(join(repoRoot, "master"), { recursive: true });
  writeFileSync(join(repoRoot, "master", "CLAUDE.md.template"), readFileSync(join(REPO, "master", "CLAUDE.md.template")));
  for (const n of ["owned", "foreign", "userdir"]) {
    mkdirSync(join(repoRoot, "skills", n), { recursive: true });
    writeFileSync(join(repoRoot, "skills", n, "SKILL.md"), `---\nname: ${n}\n---\n调用 reply 工具。\n`);
  }
  const skills = join(home, ".claude", "skills"), elsewhere = tmp("other");
  mkdirSync(join(skills, "userdir"), { recursive: true });
  writeFileSync(join(skills, "userdir", "SKILL.md"), "mine");
  symlinkSync(join(repoRoot, "skills", "owned"), join(skills, "owned"));
  symlinkSync(elsewhere, join(skills, "foreign"));
  const settings = {
    theme: "dark",
    permissions: { allow: [OLD_ALLOW, "Bash(ls:*)", "mcp__other_plugin__*"], deny: ["Bash(rm:*)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `/bun ${repoRoot}/src/hooks/typing-hook.ts` }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/other-plugin hook" }] }],
    },
  };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(repoRoot, ".env"), ENV_TEXT, { mode: 0o600 });
  return { home, repoRoot, journalDir, txId: "install-config-1", skills, elsewhere };
}
type F = ReturnType<typeof fixture>;
const settingsOf = (f: F) => JSON.parse(readFileSync(join(f.home, ".claude", "settings.json"), "utf8"));
const envOf = (f: F) => readFileSync(join(f.repoRoot, ".env"), "utf8");
const on = { rename: { installConfig: "on" } };

/** 所有文件的字节 + 软链目标：零写入的判据 */
function snapshot(...dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n), s = lstatSync(p);
      if (s.isSymbolicLink()) out[p] = `link:${realpathSync(p)}`;
      else if (s.isDirectory()) walk(p);
      else out[p] = `${s.mode}:${readFileSync(p, "utf8")}`;
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

test("[验收线 1] 临时 HOME 合成 settings / env / 软链迁移幂等，旧新 allow 并存，自定义配置不变", async () => {
  const f = fixture();
  const before = settingsOf(f);
  const r = await runInstallConfig({ ...f, config: on });
  expect(r.status).toBe("committed");
  const after = settingsOf(f);
  expect(after.permissions.allow).toEqual([OLD_ALLOW, "Bash(ls:*)", "mcp__other_plugin__*", NEW_ALLOW]);
  expect({ ...after, permissions: { ...after.permissions, allow: before.permissions.allow } }).toEqual(before);
  expect(lstatSync(join(f.home, ".claude", "settings.json")).mode & 0o777).toBe(0o600);

  const env = envOf(f);
  expect(env).toContain("CLAUDESTRA_STATE_DIR=/srv/state\nFLOKA_STATE_DIR=/srv/state\n");
  expect(env).toContain("export CLAUDESTRA_ACP_MODEL=\"opus\"\nexport FLOKA_ACP_MODEL=\"opus\"\n");
  expect(env).toContain("FLOKA_PI_ARGS=--user-choice"); // 用户自己的新名值不被同值覆盖
  expect(env).not.toContain("FLOKA_PI_ARGS=--a");
  expect(env).not.toContain("FLOKA_PM_DEPLOY_LOCK_TOKEN"); // 凭据不复制
  expect(env.replace(/^(export )?FLOKA_(STATE_DIR|ACP_MODEL)=.*\n/gm, "")).toBe(ENV_TEXT);
  expect(lstatSync(join(f.repoRoot, ".env")).mode & 0o777).toBe(0o600);

  // 软链：本仓的保留、别处的和用户目录不动
  expect(realpathSync(join(f.skills, "owned"))).toBe(realpathSync(join(f.repoRoot, "skills", "owned")));
  expect(realpathSync(join(f.skills, "foreign"))).toBe(realpathSync(f.elsewhere));
  expect(readFileSync(join(f.skills, "userdir", "SKILL.md"), "utf8")).toBe("mine");
  const skills = Object.fromEntries(r.plan.filter(p => p.item === "skills").map(p => [p.key, p.action]));
  expect(skills).toEqual({ owned: "keep", foreign: "skip", userdir: "skip" });

  // 幂等：同一 txId 重跑、换一个 txId 再跑，文件逐字节不变
  const settled = snapshot(f.home, f.repoRoot);
  delete settled[join(f.journalDir, `${f.txId}.journal.json`)];
  expect((await runInstallConfig({ ...f, config: on })).status).toBe("committed");
  expect((await runInstallConfig({ ...f, txId: "install-config-2", config: on })).status).toBe("committed");
  const again = snapshot(f.home, f.repoRoot);
  for (const k of Object.keys(again)) if (k.startsWith(f.journalDir)) delete again[k];
  expect(again).toEqual(settled);
  const plan = await planInstallConfig(f);
  expect(plan.filter(p => p.action === "add")).toEqual([]);
});

test("[验收线 1] 计划逐项：hook 两族共用、兼容消费者列出、.env 只认登记变量", async () => {
  const f = fixture();
  const plan = await planInstallConfig(f);
  expect(plan.find(p => p.item === "settings.hooks")).toMatchObject({ key: "Stop:typing-hook.ts", action: "keep" });
  expect(plan.some(p => p.item === "settings.hooks" && p.key.includes("other-plugin"))).toBe(false);
  expect(plan.filter(p => p.item === "consumer").map(p => p.key)).toEqual(["transcripts", "project-graph", "memory-namespace", "master-render"]);
  expect(planEnvText(ENV_TEXT).map(p => [p.key, p.action])).toEqual([
    ["FLOKA_STATE_DIR", "add"], ["FLOKA_ACP_MODEL", "add"], ["FLOKA_PI_ARGS", "skip"],
  ]);
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: "x" } }));
  const r = await runInstallConfig({ ...f, config: on });
  expect(r.status).toBe("refused"); // allow 不是数组：拒绝，不整份覆写
  expect(JSON.parse(readFileSync(join(f.home, ".claude", "settings.json"), "utf8"))).toEqual({ permissions: { allow: "x" } });
});

test("[验收线 2] 旧会话模板仍调用旧工具，新会话调用新工具", () => {
  const tpl = readFileSync(join(REPO, "master", "CLAUDE.md.template"), "utf8");
  const entries = planTemplate(tpl);
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) {
    expect(e.action).toBe("keep");
    expect(tpl).toContain(familyToolName(LEGACY_FAMILY, e.key));
    expect(tpl).toContain(familyToolName(NEW_FAMILY, e.key));
  }
  expect(planTemplate("用 `mcp__claudestra__fleet`")[0]!.action).toBe("conflict"); // 只写旧名的模板会被计划标出来
});

const UUID_OLD = "11111111-1111-4111-8111-111111111111", UUID_NEW = "22222222-2222-4222-8222-222222222222";

/** 真实 typing-hook 进程打到假 bridge：只看它报上来的会话族 */
async function runHook(env: Record<string, string>, sessionId: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { body = await req.json() as Record<string, unknown>; return new Response("ok"); } });
  try {
    const child = testChildEnv({ ...env, DISCORD_CHANNEL_ID: "c1", BRIDGE_URL: `ws://127.0.0.1:${server.port}` });
    for (const k of ["CLAUDESTRA_STATE_DIR", "FLOKA_STATE_DIR", "FLOKA_RENAME_ENV"]) if (!(k in env)) delete child[k];
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(REPO, "src/hooks/typing-hook.ts")],
      { env: child, stdin: new Blob([JSON.stringify({ hook_event_name: "Notification", session_id: sessionId })]), stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
  } finally { server.stop(true); }
  return body;
}

test("[验收线 2] fake hook：旧名 / 新名环境落同一临时状态根，按会话族取工具名", async () => {
  const state = tmp("state"), run = tmp("run");
  mkdirSync(join(state, "mcp-family", "sessions"), { recursive: true });
  writeFileSync(join(state, "mcp-family", "sessions", `${UUID_NEW}.json`), JSON.stringify({ family: "floka", agent: "a", at: "x" }));
  const legacy = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: run };
  const renamed = { FLOKA_STATE_DIR: state, FLOKA_RUNTIME_DIR: run, FLOKA_RENAME_ENV: "on" };
  expect((await runHook(legacy, UUID_OLD)).mcpFamily).toBe("claudestra");
  expect((await runHook(legacy, UUID_NEW)).mcpFamily).toBe("floka");
  expect((await runHook(renamed, UUID_OLD)).mcpFamily).toBe("claudestra");
  expect((await runHook(renamed, UUID_NEW)).mcpFamily).toBe("floka");
  expect(readdirSync(join(state, "mcp-family", "sessions"))).toEqual([`${UUID_NEW}.json`]); // hook 只读，不新增记录
}, 30_000);

test("[验收线 3] off / observe 零写入，observe 只报差异", async () => {
  const f = fixture();
  const before = snapshot(f.home, f.repoRoot);
  for (const config of [{}, { rename: { installConfig: "typo" } }, { rename: { installConfig: "off" } }]) {
    expect(await runInstallConfig({ ...f, config })).toEqual({ mode: "off", status: "off", plan: [] });
    expect(await installConfigWarnings(f.repoRoot, config, f.home)).toEqual([]);
  }
  const r = await runInstallConfig({ ...f, config: { rename: { installConfig: "observe" } } });
  expect(r.status).toBe("observed");
  expect(r.plan.filter(p => p.action === "add").map(p => p.key)).toEqual([NEW_ALLOW, "FLOKA_STATE_DIR", "FLOKA_ACP_MODEL"]);
  const w = await installConfigWarnings(f.repoRoot, { rename: { installConfig: "observe" } }, f.home);
  expect(w[0]).toContain(`settings.allow ${NEW_ALLOW}: add`);
  expect(snapshot(f.home, f.repoRoot)).toEqual(before);
  expect(existsSync(f.journalDir)).toBe(false);
});

test("[验收线 3] 回滚仅撤新增项，不覆盖用户后续修改", async () => {
  const f = fixture();
  const originalEnv = envOf(f), originalSettings = settingsOf(f);
  expect((await runInstallConfig({ ...f, config: on })).status).toBe("committed");
  // 迁移之后用户又改了：加了自己的 allow、改了一个新名的值、别的设置也动了
  const s = settingsOf(f);
  s.permissions.allow.push("Read(*)");
  s.theme = "light";
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify(s));
  writeFileSync(join(f.repoRoot, ".env"), envOf(f).replace("export FLOKA_ACP_MODEL=\"opus\"", "export FLOKA_ACP_MODEL=\"sonnet\"") + "USER_LATER=1\n");

  const r = await rollbackInstallConfig(f);
  expect(r.status).toBe("rolled_back");
  const after = settingsOf(f);
  expect(after.permissions.allow).toEqual([...originalSettings.permissions.allow, "Read(*)"]);
  expect(after.theme).toBe("light");
  const env = envOf(f);
  expect(env).not.toContain("FLOKA_STATE_DIR"); // 本迁移加的、没被改过：撤掉
  expect(env).toContain("export FLOKA_ACP_MODEL=\"sonnet\""); // 用户改过：留下
  expect(env).toContain("FLOKA_PI_ARGS=--user-choice\n");
  expect(env.replace("export FLOKA_ACP_MODEL=\"sonnet\"\n", "")).toBe(originalEnv + "USER_LATER=1\n");

  // 回滚幂等，同一 txId 不会再次执行
  const settled = snapshot(f.home, f.repoRoot);
  expect((await rollbackInstallConfig(f)).status).toBe("refused");
  expect((await runInstallConfig({ ...f, config: on })).status).toBe("refused");
  expect(snapshot(f.home, f.repoRoot)).toEqual(settled);
});

test("[验收线 3] 迁移前已有的新族 allow / 新名，回滚时保留", async () => {
  const f = fixture();
  const s = settingsOf(f);
  s.permissions.allow.push(NEW_ALLOW);
  writeFileSync(join(f.home, ".claude", "settings.json"), JSON.stringify(s));
  writeFileSync(join(f.repoRoot, ".env"), ENV_TEXT + "FLOKA_STATE_DIR=/srv/state\n");
  expect((await runInstallConfig({ ...f, config: on })).status).toBe("committed");
  expect((await rollbackInstallConfig(f)).status).toBe("rolled_back");
  expect(settingsOf(f).permissions.allow).toContain(NEW_ALLOW);
  expect(envOf(f)).toBe(ENV_TEXT + "FLOKA_STATE_DIR=/srv/state\n");
});

const pem = () => String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
function startup(home: string) {
  const env = testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "run"), BRIDGE_PORT: "9" });
  for (const k of ["CLAUDESTRA_STATE_DIR", "FLOKA_STATE_DIR", "FLOKA_RENAME_ENV"]) delete env[k];
  return spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", "-e", 'const m = await import("./src/lib/paths.ts"); console.log(m.STATE_DIR);'],
    { env, encoding: "utf8", timeout: 20_000, cwd: REPO });
}

test("全新机器只有 ~/.floka：装前起不来，装完（缺省选旧根）能正常启动", () => {
  const home = tmp("fresh");
  mkdirSync(join(home, ".floka"));
  writeFileSync(join(home, ".floka", "notes.txt"), "user dir");
  expect(startup(home).status).not.toBe(0); // 先红：CONFIG1 保留的拒绝
  const r = chooseFreshStateRoot(home);
  expect(r).toMatchObject({ status: "chosen", choice: "legacy", root: join(home, ".claude-orchestrator") });
  expect(readdirSync(join(home, ".floka"))).toEqual(["notes.txt"]); // 用户的目录一个字节不动
  const s = startup(home);
  expect(s.stderr).not.toContain("refusing");
  expect(s.status).toBe(0);
  expect(s.stdout.trim()).toBe(join(home, ".claude-orchestrator"));
  expect(chooseFreshStateRoot(home)).toMatchObject({ status: "not-fresh" }); // 幂等
});

test("全新机器的 ~/.floka 已有身份：缺省选新根（旧根成别名），选旧根拒绝", () => {
  const home = tmp("fresh-id");
  mkdirSync(join(home, ".floka"));
  writeFileSync(join(home, ".floka", "instance-id"), "floka-instance\n");
  writeFileSync(join(home, ".floka", "instance-key.pem"), pem());
  expect(chooseFreshStateRoot(home, "legacy").status).toBe("refused");
  expect(existsSync(join(home, ".claude-orchestrator"))).toBe(false);
  expect(chooseFreshStateRoot(home)).toMatchObject({ status: "chosen", choice: "floka" });
  expect(realpathSync(join(home, ".claude-orchestrator"))).toBe(realpathSync(join(home, ".floka")));
  expect(readFileSync(join(home, ".floka", "instance-id"), "utf8")).toBe("floka-instance\n");
  const s = startup(home);
  expect(s.status).toBe(0);
  expect(realpathSync(s.stdout.trim())).toBe(realpathSync(join(home, ".floka")));
  expect(() => defaultStateRoot(home, join(home, ".claude-orchestrator"))).not.toThrow();
});

test("全新机器显式选新根：空 ~/.floka 里生成身份", () => {
  const home = tmp("fresh-pick");
  mkdirSync(join(home, ".floka"));
  expect(chooseFreshStateRoot(home, "floka")).toMatchObject({ status: "chosen", choice: "floka" });
  expect(readdirSync(join(home, ".floka")).sort()).toEqual(["instance-id", "instance-key.pem"]);
  expect(startup(home).status).toBe(0);
});
