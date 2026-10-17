/**
 * FRESHENTRY1 · 全新 Floka 根从真实安装入口启动（lib/floka-install-config/fresh-entry-policy.ts、fresh-root-preload.ts）。
 * 子进程跑真实的 `manager.ts install-cli` 与 `setup.ts`：临时 HOME、两种 STATE_DIR 与改名覆盖变量都去掉；带沙箱标记，
 * 越过状态根解析后停在沙箱闸（受控阶段），不写 launchd、不碰真实服务或用户文件。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkFreshEntry, freshEntryMode, freshEntryTarget, runFreshEntry } from "../src/lib/floka-install-config/fresh-entry-policy.ts";
import { defaultStateRoot } from "../src/lib/floka-config/default-root.ts";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.ts";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const tmp = (name: string) => { const d = mkdtempSync(join(tmpdir(), `floka-freshentry-${name}-`)); roots.push(d); return d; };
const pem = () => String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
const OLD = (home: string) => join(home, ".claude-orchestrator");
const NEW = (home: string) => join(home, ".floka");

function freshHome(name: string, identity = false): string {
  const home = tmp(name);
  mkdirSync(NEW(home));
  if (identity) {
    writeFileSync(join(NEW(home), "instance-id"), "floka-instance\n");
    writeFileSync(join(NEW(home), "instance-key.pem"), pem());
  }
  return home;
}
function setMode(root: string, mode: string | null, at: "key" | "project" = "key") {
  mkdirSync(root, { recursive: true });
  const project = mode === null ? {} : at === "key" ? { keys: { installFreshEntry: mode } } : { mode };
  writeFileSync(join(root, "recovery-policy.json"), JSON.stringify({ projects: { "claude-orchestrator": project } }));
}
const ENTRIES = { "manager:install-cli": ["src/manager.ts", "install-cli"], setup: ["src/setup.ts"], "manager:list": ["src/manager.ts", "list"] } as const;
function entry(home: string, which: keyof typeof ENTRIES, extra: Record<string, string> = {}) {
  const env = testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "run"), CLAUDESTRA_SANDBOX: "1", ...extra });
  for (const k of ["CLAUDESTRA_STATE_DIR", "FLOKA_STATE_DIR", "FLOKA_RENAME_ENV"]) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", ...ENTRIES[which]],
    { env, encoding: "utf8", timeout: 40_000, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
}
const MISSING = "legacy state root missing";
const FENCE = "沙箱模式（CLAUDESTRA_SANDBOX=1）拒绝启动";

describe("[验收线 1] 只有新根的临时 HOME，真实两个入口越过旧根缺失错误", () => {
  for (const which of ["manager:install-cli", "setup"] as const) {
    test(`${which}：缺省选旧根，停在沙箱闸；~/.floka 一个字节不动`, () => {
      const home = freshHome(`entry-${which.replace(":", "-")}`);
      writeFileSync(join(NEW(home), "notes.txt"), "user dir");
      const r = entry(home, which);
      expect(r.stderr).not.toContain(MISSING);
      expect(r.stderr).toContain("全新机器：状态根选 legacy");
      expect(r.stderr).toContain(FENCE); // 受控阶段：状态根已解析，安装动作之前被沙箱闸挡下
      expect(r.status).not.toBe(0);
      expect(readdirSync(NEW(home))).toEqual(["notes.txt"]);
      expect(readdirSync(OLD(home)).sort()).toEqual(["instance-id", "instance-key.pem"]);
      expect(defaultStateRoot(home, OLD(home))).toBe(OLD(home));
    }, 60_000);
  }

  test("manager install-cli：~/.floka 已有身份 → 旧根成别名，身份沿用不重造", () => {
    const home = freshHome("entry-id", true);
    const before = readFileSync(join(NEW(home), "instance-key.pem"), "utf8");
    const r = entry(home, "manager:install-cli");
    expect(r.stderr).not.toContain(MISSING);
    expect(r.stderr).toContain("全新机器：状态根选 floka");
    expect(lstatSync(OLD(home)).isSymbolicLink()).toBe(true);
    expect(realpathSync(OLD(home))).toBe(realpathSync(NEW(home)));
    expect(readFileSync(join(NEW(home), "instance-key.pem"), "utf8")).toBe(before);
  }, 60_000);

  test("基线对照：manager 的其他子命令不归本卡，照旧报旧根缺失、不选根", () => {
    const home = freshHome("entry-list");
    const r = entry(home, "manager:list");
    expect(r.stderr).toContain(MISSING);
    expect(existsSync(OLD(home))).toBe(false);
    expect(freshEntryTarget(["bun", "/x/src/manager.ts", "list"])).toBeNull();
    expect(freshEntryTarget(["bun", "/x/src/manager.ts", "install-cli"])).toBe("manager:install-cli");
    expect(freshEntryTarget(["bun", "/x/src/setup.ts"])).toBe("setup");
    expect(freshEntryTarget(["bun", "-e", "x"])).toBeNull();
  }, 60_000);
});

describe("[验收线 2] 只有旧根、双根、显式覆盖、坏身份 / 中断迁移与 off 都不动手", () => {
  test("只有旧根 / 双根 → not-fresh，不写任何东西", () => {
    const onlyOld = tmp("only-old");
    mkdirSync(OLD(onlyOld));
    expect(checkFreshEntry(onlyOld, {})).toEqual({ status: "skip", reason: "not-fresh" });
    expect(runFreshEntry("setup", onlyOld, {}, "t")).toMatchObject({ action: "none" });
    expect(readdirSync(onlyOld)).toEqual([".claude-orchestrator"]);
    const both = freshHome("both");
    mkdirSync(OLD(both));
    expect(runFreshEntry("manager:install-cli", both, {}, "t")).toMatchObject({ action: "none", check: { reason: "not-fresh" } });
    expect(readdirSync(OLD(both))).toEqual([]);
  });

  test("显式覆盖（旧名或新名 STATE_DIR）→ 不碰 HOME", () => {
    for (const env of [{ CLAUDESTRA_STATE_DIR: "/srv/s" }, { FLOKA_STATE_DIR: "/srv/s" }]) {
      const home = freshHome("override");
      expect(runFreshEntry("setup", home, env, "t")).toMatchObject({ action: "none", check: { reason: "override" } });
      expect(existsSync(OLD(home))).toBe(false);
    }
  });

  test("坏身份（缺一份 / id 非法 / key 不是 ed25519）→ 拒绝，不补不重造", () => {
    const cases: Record<string, string>[] = [
      { "instance-id": "only-id\n" },
      { "instance-key.pem": pem() },
      { "instance-id": "bad id with spaces\n", "instance-key.pem": pem() },
      { "instance-id": "ok\n", "instance-key.pem": "not a key" },
    ];
    for (const files of cases) {
      const home = freshHome("bad-id");
      for (const [n, v] of Object.entries(files)) writeFileSync(join(NEW(home), n), v);
      expect(runFreshEntry("setup", home, {}, "t")).toMatchObject({ action: "none", check: { status: "refuse", reason: "bad-identity" } });
      expect(existsSync(OLD(home))).toBe(false);
      expect(readdirSync(NEW(home)).sort()).toEqual(Object.keys(files).sort());
    }
  });

  test("中断迁移（维护根留有状态日志）/ 维护屏障 → 不当全新机器", () => {
    const home = freshHome("journal", true);
    mkdirSync(join(home, ".claudestra-maintenance", "state", "journals", "run1"), { recursive: true });
    expect(runFreshEntry("manager:install-cli", home, {}, "t")).toMatchObject({ action: "none", check: { status: "refuse", reason: "interrupted-migration" } });
    expect(existsSync(OLD(home))).toBe(false);
    const barred = freshHome("barrier");
    mkdirSync(join(barred, ".claudestra-maintenance", "state", "control"), { recursive: true });
    writeFileSync(join(barred, ".claudestra-maintenance", "state", "control", "barrier.json"), "{}");
    expect(checkFreshEntry(barred, {})).toEqual({ status: "skip", reason: "not-fresh" });
  });

  test("拒绝情形走真实入口：照旧报 paths 的错，且没有生成任何身份", () => {
    const home = freshHome("bad-entry");
    writeFileSync(join(NEW(home), "instance-id"), "only-id\n");
    const r = entry(home, "setup");
    expect(r.stderr).toContain(MISSING);
    expect(existsSync(OLD(home))).toBe(false);
    expect(readdirSync(NEW(home))).toEqual(["instance-id"]);
  }, 60_000);

  test("off：入口与基线一致（照旧报旧根缺失，不动手）", () => {
    const home = freshHome("off-entry");
    setMode(NEW(home), "off");
    const r = entry(home, "manager:install-cli");
    expect(r.stderr).toContain(MISSING);
    expect(r.stderr).not.toContain(FENCE);
    expect(existsSync(OLD(home))).toBe(false);
  }, 60_000);
});

describe("[验收线 3] on / observe / off、运行中切档与上游开关组合", () => {
  test("恢复键已登记，缺省 on", () => {
    expect(RECOVERY_KEYS).toContain("installFreshEntry");
    expect(defaultRecoveryMode("installFreshEntry")).toBe("on");
    expect(freshEntryMode(freshHome("default"))).toBe("on");
  });

  test("模式解析：key 优先于项目 mode；两根取最保守；坏文件 / 未知值 → off", () => {
    const home = freshHome("modes");
    setMode(NEW(home), "observe", "project");
    expect(freshEntryMode(home)).toBe("observe");
    writeFileSync(join(NEW(home), "recovery-policy.json"), JSON.stringify({ projects: { "claude-orchestrator": { mode: "off", keys: { installFreshEntry: "on" } } } }));
    expect(freshEntryMode(home)).toBe("on");
    setMode(OLD(home), "observe");
    expect(freshEntryMode(home)).toBe("observe");
    rmSync(OLD(home), { recursive: true });
    writeFileSync(join(NEW(home), "recovery-policy.json"), "{not json");
    expect(freshEntryMode(home)).toBe("off");
    setMode(NEW(home), "maybe");
    expect(freshEntryMode(home)).toBe("off");
    setMode(NEW(home), null);
    expect(freshEntryMode(home)).toBe("on");
  });

  test("observe 只记样本（按入口@版本去重，无路径 / 身份内容），不改业务结果；运行中切 on 下一次即动手，切 off 即停", () => {
    const home = freshHome("observe", true);
    setMode(NEW(home), "observe");
    const a = runFreshEntry("setup", home, {}, "9.9.9");
    expect(a).toMatchObject({ mode: "observe", action: "observed", recorded: true });
    expect(runFreshEntry("setup", home, {}, "9.9.9")).toMatchObject({ action: "observed", recorded: false });
    expect(runFreshEntry("manager:install-cli", home, {}, "9.9.9")).toMatchObject({ action: "observed", recorded: true });
    expect(existsSync(OLD(home))).toBe(false); // 业务结果与 off 相同：没选根
    const log = readFileSync(join(home, ".claudestra-maintenance", "state", "observe", "installFreshEntry.jsonl"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(2);
    expect(log).not.toContain(home);
    expect(log).not.toContain("floka-instance");
    expect(log).toContain("9.9.9:floka");

    setMode(NEW(home), "off"); // 运行中切档：同一进程下一次动作前现读
    expect(runFreshEntry("setup", home, {}, "9.9.9")).toMatchObject({ mode: "off", action: "none" });
    setMode(NEW(home), "on");
    const on = runFreshEntry("setup", home, {}, "9.9.9");
    expect(on).toMatchObject({ mode: "on", action: "chosen", result: { status: "chosen", choice: "floka" } });
    expect(realpathSync(OLD(home))).toBe(realpathSync(NEW(home)));
  });

  test("observe 走真实入口：照旧报旧根缺失，留一条样本", () => {
    const home = freshHome("observe-entry");
    setMode(NEW(home), "observe");
    const r = entry(home, "setup");
    expect(r.stderr).toContain(MISSING);
    expect(r.stderr).toContain("installFreshEntry=observe");
    expect(existsSync(OLD(home))).toBe(false);
    expect(readFileSync(join(home, ".claudestra-maintenance", "state", "observe", "installFreshEntry.jsonl"), "utf8")).toContain('"target":"setup"');
  }, 60_000);

  test("上游开关组合：~/.floka 里 rename.state on / off 时选新根后都能解析，不抛", () => {
    for (const state of ["on", "off", "observe"]) {
      const home = freshHome(`rename-${state}`, true);
      writeFileSync(join(NEW(home), "config.json"), JSON.stringify({ rename: { state } }));
      expect(runFreshEntry("manager:install-cli", home, {}, "t")).toMatchObject({ action: "chosen", result: { status: "chosen", choice: "floka" } });
      expect(() => defaultStateRoot(home, OLD(home))).not.toThrow();
      expect(runFreshEntry("manager:install-cli", home, {}, "t")).toMatchObject({ action: "none", check: { reason: "not-fresh" } }); // 幂等
    }
  });
});
