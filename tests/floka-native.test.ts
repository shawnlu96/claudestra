import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkStaticConfig, INVITE_SCHEMES, NATIVE_ITEM, OLD_IDENTITY, parseInviteUrl, planNativeIdentity, PROPOSED_IDENTITY, type PlatformConfig,
} from "../scripts/rename-floka/native/identity.ts";
import { applyImport, planImport, rollbackImport, SHELL_FORMAT } from "../scripts/rename-floka/native/import.ts";
import { runNativeCli } from "../scripts/rename-floka/native/cli.ts";

// 全程只在临时目录里:合成的壳配置、合成的平台配置。不碰真设备、不签名、不连 APNs、不连网络。
const ROOT = join(import.meta.dir, "..");
const SCOPED = [
  "native/capacitor.config.ts", "native/ios/App/App/Info.plist", "native/ios/App/App/AppDelegate.swift",
  "native/ios/App/App.xcodeproj/project.pbxproj", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Info.plist",
];

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "floka-native-"))); roots.push(d); return d; };

const PAIRING = { deviceId: "dev_0123456789", token: "cst_synthetic-token-ä-🔑", peers: [{ name: "home", url: "https://h.example" }], n: 1.5 };
const OLD_PUSH = { topic: OLD_IDENTITY.ios.apnsTopic, token: "a1b2c3d4e5f6" };

/** 合成旧壳配置(模拟从旧 App 导出的那份) */
function oldShell(dir: string, over: Record<string, unknown> = {}): string {
  const p = join(dir, "old-shell.json");
  const cfg = {
    format: SHELL_FORMAT, version: 1, bundleId: OLD_IDENTITY.ios.bundleId,
    defaults: { "cstra.serverURL": "https://server.example:8443" }, pairing: PAIRING, push: OLD_PUSH, ...over,
  };
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}

const FULL_PLATFORM: PlatformConfig = {
  ios: { teamId: "ABCDE12345", provisioningProfile: "Floka App Store", apnsKeyId: "KEY1234567", apnsTopic: PROPOSED_IDENTITY.ios.bundleId, apsEnvironment: "production" },
  desktop: { signingIdentity: "Developer ID Application: Example", notaryProfile: "floka-notary" },
};

const snapshot = (dir: string, files: string[]) => Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const listDir = (dir: string) => readdirSync(dir).sort();

async function cli(...args: string[]) {
  const r = await runNativeCli(args, ROOT);
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

describe("[验收线 1] 新身份:off 保持旧身份、observe 零改动、on 缺平台配置拒绝发布", () => {
  test("off(缺省)只报旧身份,不出计划", async () => {
    const r = planNativeIdentity({ mode: "off" });
    expect(r).toMatchObject({ item: NATIVE_ITEM, mode: "off", status: "off", writes: 0, identity: OLD_IDENTITY });
    expect(r.fileChanges).toEqual([]);
    expect(r.publishSteps).toEqual([]);
    const c = await cli("identity");
    expect(c.code).toBe(0);
    expect(c.json).toMatchObject({ mode: "off", status: "off" });
  });

  test("observe 只出新身份计划,仓库与目录零改动", async () => {
    const before = snapshot(ROOT, SCOPED);
    const dir = tmp();
    const old = oldShell(dir);
    const listing = listDir(dir);
    const c = await cli("identity", "--mode", "observe");
    const i = await cli("import", "--mode", "observe", "--old", old, "--new", join(dir, "new-shell.json"));
    expect(c.code).toBe(0);
    expect(i.code).toBe(0);
    expect(c.json).toMatchObject({ status: "planned", writes: 0, identity: { from: OLD_IDENTITY, to: PROPOSED_IDENTITY }, publishSteps: [] });
    expect(i.json).toMatchObject({ status: "planned", writes: 0 });
    expect(c.json.fileChanges.map((f: { to: string }) => f.to)).toContain(PROPOSED_IDENTITY.ios.bundleId);
    expect(snapshot(ROOT, SCOPED)).toEqual(before);
    expect(listDir(dir)).toEqual(listing);
  });

  test("on 不给平台配置:签名 / APNs 前提缺,发布步骤全拒、退出码 1", async () => {
    const r = planNativeIdentity({ mode: "on" });
    expect(r.status).toBe("blocked");
    expect(r.publishReady).toBe(false);
    expect(r.publishSteps.length).toBeGreaterThan(0);
    expect(r.publishSteps.every((s) => s.status === "refused")).toBe(true);
    const missing = r.prerequisites.filter((p) => p.status === "missing").map((p) => p.id);
    expect(missing).toEqual(expect.arrayContaining(["ios.signing.team", "ios.signing.profile", "ios.entitlements.aps", "ios.apns.key", "ios.apns.topic"]));
    expect((await cli("identity", "--mode", "on")).code).toBe(1);
  });

  test("on 的 APNs topic 不是新 bundle:照样拒", () => {
    const r = planNativeIdentity({ mode: "on", platform: { ...FULL_PLATFORM, ios: { ...FULL_PLATFORM.ios, apnsTopic: OLD_IDENTITY.ios.apnsTopic } } });
    expect(r.status).toBe("blocked");
    expect(r.refusals.join("\n")).toContain("ios.apns.topic");
  });

  test("on 平台配置齐:只列人工发布步骤,本工具仍零写入、不声称迁移完成", async () => {
    const dir = tmp();
    const pf = join(dir, "platform.json");
    writeFileSync(pf, JSON.stringify(FULL_PLATFORM));
    const c = await cli("identity", "--mode", "on", "--platform", pf);
    expect(c.code).toBe(0);
    expect(c.json).toMatchObject({ status: "planned", writes: 0, publishReady: true, releaseClaim: "none" });
    expect(c.json.publishSteps.every((s: { status: string }) => s.status === "manual")).toBe(true);
  });

  test("平台配置里放凭据本体:拒读", () => {
    const bad = { ios: { ...FULL_PLATFORM.ios, apnsKeyId: "-----BEGIN PRIVATE KEY-----\nMIGT" } };
    expect(() => planNativeIdentity({ mode: "on", platform: bad })).toThrow(/凭据/);
  });

  test("仓库里的构建配置仍是旧身份(构建脚本不自动切新 bundle)", () => {
    const r = checkStaticConfig(ROOT);
    const identity = r.checks.filter((c) => c.id.startsWith("identity."));
    expect(identity.length).toBeGreaterThanOrEqual(4);
    expect(identity.filter((c) => !c.ok)).toEqual([]);
  });

  test("参数错:非法 mode / 未知子命令 / 未知参数 退出码 2", async () => {
    expect((await cli("identity", "--mode", "yes")).code).toBe(2);
    expect((await cli("publish")).code).toBe(2);
    expect((await cli("identity", "--bogus", "1")).code).toBe(2);
  });
});

describe("[验收线 2] 导入幂等、配对凭据原样、新旧 scheme 都能解析", () => {
  async function importOnce(dir: string, old: string) {
    const newPath = join(dir, "new-shell.json");
    const plan = planImport({ mode: "observe", oldPath: old, newPath });
    return { newPath, plan, result: applyImport({ mode: "on", oldPath: old, newPath, plan }) };
  }

  test("导入两次:第二次 unchanged、零写入,字节不变", async () => {
    const dir = tmp();
    const old = oldShell(dir);
    const oldBytes = readFileSync(old, "utf8");
    const first = await importOnce(dir, old);
    expect(first.result).toMatchObject({ status: "imported", refusals: [] });
    const bytes = readFileSync(first.newPath, "utf8");
    const second = await importOnce(dir, old);
    expect(second.result).toMatchObject({ status: "unchanged", writes: 0 });
    expect(readFileSync(first.newPath, "utf8")).toBe(bytes);
    expect(readFileSync(old, "utf8")).toBe(oldBytes);
    expect(statSync(first.newPath).mode & 0o777).toBe(0o600);
  });

  test("配对凭据与服务器地址原样带过去;推送 token 不搬(新 topic 要重新注册)", async () => {
    const dir = tmp();
    const { newPath } = await importOnce(dir, oldShell(dir));
    const cfg = JSON.parse(readFileSync(newPath, "utf8"));
    expect(cfg.bundleId).toBe(PROPOSED_IDENTITY.ios.bundleId);
    expect(cfg.pairing).toEqual(PAIRING);
    expect(JSON.stringify(cfg.pairing)).toBe(JSON.stringify(PAIRING));
    expect(cfg.defaults).toEqual({ "cstra.serverURL": "https://server.example:8443" });
    expect(cfg.push).toBeNull();
  });

  test("新壳配置已存在且不是本工具写的:拒绝覆盖", () => {
    const dir = tmp();
    const old = oldShell(dir);
    const newPath = join(dir, "new-shell.json");
    writeFileSync(newPath, "{\"someone\":\"else\"}\n");
    const plan = planImport({ mode: "observe", oldPath: old, newPath });
    expect(plan.status).toBe("blocked");
    expect(applyImport({ mode: "on", oldPath: old, newPath, plan }).status).toBe("blocked");
    expect(readFileSync(newPath, "utf8")).toBe("{\"someone\":\"else\"}\n");
  });

  test("计划之后旧配置变了:on 拒绝", () => {
    const dir = tmp();
    const old = oldShell(dir);
    const newPath = join(dir, "new-shell.json");
    const plan = planImport({ mode: "observe", oldPath: old, newPath });
    oldShell(dir, { defaults: { "cstra.serverURL": "https://other.example" } });
    const r = applyImport({ mode: "on", oldPath: old, newPath, plan });
    expect(r.status).toBe("blocked");
    expect(existsSync(newPath)).toBe(false);
  });

  test("旧配置不是旧 bundle 导出的:拒绝", () => {
    const dir = tmp();
    const r = planImport({ mode: "observe", oldPath: oldShell(dir, { bundleId: "com.example.other" }), newPath: join(dir, "n.json") });
    expect(r.status).toBe("blocked");
  });

  test("邀请链接:旧 claudestra:// 与新 floka:// 都解析,别的不认", () => {
    expect(INVITE_SCHEMES).toEqual(["claudestra", "floka"]);
    expect(parseInviteUrl("claudestra://join#abc")).toBe("abc");
    expect(parseInviteUrl("floka://join#abc")).toBe("abc");
    expect(parseInviteUrl("FLOKA://join#xyz")).toBe("xyz");
    expect(parseInviteUrl("floka://join")).toBeNull();
    expect(parseInviteUrl("floka://other#abc")).toBeNull();
    expect(parseInviteUrl("https://join#abc")).toBeNull();
  });

  test("iOS 壳同时注册并处理新旧 scheme", () => {
    const r = checkStaticConfig(ROOT);
    for (const id of ["scheme.info-plist", "scheme.app-delegate"]) expect(r.checks.find((c) => c.id === id)).toMatchObject({ ok: true });
  });
});

describe("[验收线 3] 回旧壳:旧配置可读、旧推送凭据仍在、sandbox 不自动继承", () => {
  test("回滚删掉导入出的新壳配置,旧壳配置逐字节不变", () => {
    const dir = tmp();
    const old = oldShell(dir);
    const oldBytes = readFileSync(old, "utf8");
    const newPath = join(dir, "new-shell.json");
    applyImport({ mode: "on", oldPath: old, newPath, plan: planImport({ mode: "observe", oldPath: old, newPath }) });
    const obs = rollbackImport({ mode: "observe", newPath });
    expect(obs).toMatchObject({ status: "planned", writes: 0 });
    expect(existsSync(newPath)).toBe(true);
    const r = rollbackImport({ mode: "on", newPath });
    expect(r).toMatchObject({ status: "rolled-back", oldShell: { readable: true, pushRetained: true }, sandbox: { inherited: false } });
    expect(r.sandbox.note).toContain("sandbox");
    expect(existsSync(newPath)).toBe(false);
    expect(readFileSync(old, "utf8")).toBe(oldBytes);
    expect(JSON.parse(readFileSync(old, "utf8")).push).toEqual(OLD_PUSH);
    expect(rollbackImport({ mode: "on", newPath }).status).toBe("unchanged");
  });

  test("新壳导入后又改过配置:回滚拒删", () => {
    const dir = tmp();
    const old = oldShell(dir);
    const newPath = join(dir, "new-shell.json");
    applyImport({ mode: "on", oldPath: old, newPath, plan: planImport({ mode: "observe", oldPath: old, newPath }) });
    writeFileSync(newPath, "{\"changed\":true}\n");
    expect(rollbackImport({ mode: "on", newPath }).status).toBe("blocked");
    expect(existsSync(newPath)).toBe(true);
  });

  test("身份计划与导入计划都写明 sandbox 不能自动继承", () => {
    const dir = tmp();
    const id = planNativeIdentity({ mode: "observe" });
    const imp = planImport({ mode: "observe", oldPath: oldShell(dir), newPath: join(dir, "n.json") });
    for (const r of [id, imp]) expect(r.sandbox).toMatchObject({ inherited: false });
    expect(id.prerequisites.find((p) => p.id === "ios.sandbox")).toMatchObject({ status: "manual" });
  });
});

describe("[验收线 4] 静态配置校验;无设备 / 签名 / 推送操作", () => {
  test("静态校验全过", async () => {
    const r = checkStaticConfig(ROOT);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect((await cli("check")).code).toBe(0);
  });

  test("plist 语法(有 plutil 的机器上)", () => {
    if (!Bun.which("plutil")) return;
    for (const f of ["native/ios/App/App/Info.plist", "desktop/src-tauri/Info.plist"]) {
      expect(Bun.spawnSync(["plutil", "-lint", join(ROOT, f)]).exitCode).toBe(0);
    }
  });

  test("工具源码不调设备 / 签名 / 推送 / 网络", () => {
    const dir = join(ROOT, "scripts/rename-floka/native");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/child_process|Bun\.(?:spawn|\$)|\bfetch\s*\(|node:(?:net|http|https|tls)\b/);
    }
  });
});
