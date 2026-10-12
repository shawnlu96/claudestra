/**
 * 改名清点（scripts/rename-floka/inventory.ts + identifiers.json）的验收测试。
 * 只在临时目录里造合成仓库来扫，不扫真仓库：真仓库的清点由 PM 手动跑，不进 bun test，免得别的卡新增一个标识就把这里弄红。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, runInventory, type InventoryReport, type Manifest } from "../scripts/rename-floka/inventory.ts";

const MANIFEST_PATH = join(import.meta.dir, "..", "scripts", "rename-floka", "identifiers.json");
const full = (): Manifest => JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const without = (categories: string[]): Manifest => {
  const m = full();
  return { ...m, identifiers: m.identifiers.filter((it) => !categories.includes(it.category)) };
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

const SYNTH: Record<string, string> = {
  "README.md": "# Claudestra\n\nClaudestra 把 agent 跑在 tmux 里。\n",
  "src/sign.ts": [
    "// 邀请证明的签名用途 claudestra-invite-pop-v1：改名时要双认",
    'export const INVITE_PROOF_PURPOSE = "claudestra-invite-pop-v1";',
    "",
  ].join("\n"),
  "src/install.ts": 'export const WRAPPER = "~/.local/bin/claudestra";\nexport const LABEL = "com.claudestra.bridge";\n',
  "src/env.ts": "export const dir = process.env.CLAUDESTRA_STATE_DIR;\n",
  "web/store.ts": 'export const theme = () => localStorage.getItem("cstra_theme");\nexport const COOKIE = "cstra_dev";\n',
  "web/header.ts": 'export const CSRF = "x-cstra-device";\n',
  "sessions/2026-10-01.jsonl": '{"type":"tool_use","name":"mcp__claudestra__reply","text":"Claudestra 已启动 claudestra-future-thing-v9"}\n',
  "state/peers.json": '{"peers":[{"name":"claudestra@Shawn","baseUrl":"https://relay.example.com/r/claudestra","slug":"claudestra"}]}\n',
  "state/identity.json": '{"instanceName":"agent-claudestra","fp":"ab12"}\n',
  "docs/migrations/floka.md": "# Claudestra → Floka\n\n旧名 claudestra、cstra_dev 在这里出现是为了描述迁移。\n",
};

function synthRepo(extra: Record<string, string> = {}): string {
  const root = tmp("floka-inv-repo-");
  for (const [rel, body] of Object.entries({ ...SYNTH, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** 目录哈希：每个条目的相对路径、类型、大小、修改时间、内容。多一个文件、改一个字节、碰一下 mtime 都会变 */
function treeHash(root: string): string {
  const h = createHash("sha256");
  const visit = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      h.update(`${rel}/${name}\0${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}\0${st.size}\0${st.mtimeMs}\0`);
      if (st.isDirectory()) visit(full, `${rel}/${name}`);
      else if (st.isFile()) h.update(readFileSync(full));
    }
  };
  visit(root, "");
  return h.digest("hex");
}

const fakeHome = () => tmp("floka-inv-home-");
const scan = (root: string, m: Manifest): InventoryReport => runInventory(root, m, { env: {}, home: fakeHome() });
const kinds = (r: InventoryReport) => r.failures.map((f) => f.kind);
const details = (r: InventoryReport) => r.failures.map((f) => `${f.kind} ${f.detail}`).join("\n");

describe("[验收线 1] 遗漏即失败，完整清单通过，计数分两种", () => {
  test("完整清单扫合成仓库通过", () => {
    const r = scan(synthRepo(), full());
    expect(details(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(r.totals.unregistered).toBe(0);
  });

  test("计数区分文本出现与调用点：注释里的那次只算文本出现", () => {
    const r = scan(synthRepo(), full());
    const sign = r.identifiers.find((i) => i.id === "sign.invite-pop")!;
    expect(sign.textOccurrences).toBe(2);
    expect(sign.callSites).toBe(1);
    // README 里的品牌名是文本出现，不是调用点
    const brand = r.identifiers.find((i) => i.id === "brand.display")!;
    expect(brand.textOccurrences).toBe(2);
    expect(brand.callSites).toBe(0);
    expect(r.totals.textOccurrences).toBeGreaterThan(r.totals.callSites);
  });

  test("块注释跨行、行尾注释都不算调用点", () => {
    const body = ["/*", " * 设备 cookie 叫 cstra_dev", " */", 'export const A = "cstra_dev"; // 也叫 cstra_dev', ""].join("\n");
    const r = scan(synthRepo({ "web/store.ts": body }), full());
    const cookie = r.identifiers.find((i) => i.id === "cookie.device")!;
    expect(cookie.textOccurrences).toBe(3);
    expect(cookie.callSites).toBe(1);
  });

  test("清单漏了签名用途 → 失败，并指出具体是哪个用途", () => {
    const r = scan(synthRepo(), without(["sign-purpose"]));
    expect(r.ok).toBe(false);
    expect(kinds(r)).toContain("category_missing");
    expect(details(r)).toContain("shape_unregistered claudestra-invite-pop-v1");
  });

  test("清单漏了外部安装副本 → 失败", () => {
    const r = scan(synthRepo(), without(["external-copy"]));
    expect(r.ok).toBe(false);
    expect(details(r)).toContain("类别 external-copy 一项都没登记");
    expect(details(r)).toContain("形状 external-install-path");
  });

  test("清单漏了浏览器标识（cookie / CSRF / 存储键）→ 失败", () => {
    const r = scan(synthRepo(), without(["cookie-csrf", "browser-storage"]));
    expect(r.ok).toBe(false);
    expect(details(r)).toContain("类别 cookie-csrf 一项都没登记");
    expect(details(r)).toContain("类别 browser-storage 一项都没登记");
    expect(details(r)).toContain("cstra_theme");
    expect(details(r)).toContain("x-cstra-device");
  });

  test("仓库里冒出清单没有的签名用途 / 环境变量 / cookie → 失败，兜底的品牌项不能把它吞掉", () => {
    const r = scan(synthRepo({
      "src/new-sign.ts": 'export const P = "claudestra-brand-new-proof-v1";\n',
      "src/new-env.ts": "export const v = process.env.CLAUDESTRA_BRAND_NEW_KNOB;\n",
      "web/new-cookie.ts": 'export const C = "cstra_brand_new_cookie";\n',
    }), full());
    expect(r.ok).toBe(false);
    expect(r.totals.unregistered).toBe(3);
    expect(details(r)).toContain("claudestra-brand-new-proof-v1");
    expect(details(r)).toContain("CLAUDESTRA_BRAND_NEW_KNOB");
    expect(details(r)).toContain("cstra_brand_new_cookie");
  });

  test("每项必须登记齐七个字段", () => {
    for (const field of ["old", "new", "definition", "consumers", "compat", "card", "exitEvidence"] as const) {
      const m = full();
      const target = m.identifiers.find((it) => it.id === "sign.req")! as unknown as Record<string, unknown>;
      target[field] = Array.isArray(target[field]) ? [] : " ";
      const r = scan(synthRepo(), m);
      expect(r.ok).toBe(false);
      expect(details(r)).toContain(`field_missing sign.req 缺 ${field}`);
    }
  });

  test("带旧名的文件名也要有登记项认领", () => {
    const m = full();
    m.identifiers = m.identifiers.filter((it) => it.category !== "brand");
    const r = scan(synthRepo({ "deploy/claudestra-thing.conf": "listen 443;\n" }), m);
    expect(details(r)).toContain("deploy/claudestra-thing.conf");
  });
});

describe("[验收线 2] 三类允许表，历史 / 身份 / peer 不进机械替换名单", () => {
  test("清单里三类都有，且分别标注", () => {
    const classes = new Set(full().allow.map((a) => a.class));
    expect([...classes].sort()).toEqual(["brand", "history", "protocol"]);
  });

  test("少一类就失败", () => {
    for (const cls of ["history", "protocol", "brand"]) {
      const m = full();
      m.allow = m.allow.filter((a) => a.class !== cls);
      expect(details(scan(synthRepo(), m))).toContain(`allow_class_missing 允许表缺 ${cls} 类`);
    }
  });

  test("transcript 归历史、身份与 peer URL / slug 归协议、迁移说明归品牌", () => {
    const r = scan(synthRepo(), full());
    expect(r.allowed.history.files).toEqual(["sessions/2026-10-01.jsonl"]);
    expect(r.allowed.protocol.files).toEqual(["state/identity.json", "state/peers.json"]);
    expect(r.allowed.brand.files).toEqual(["docs/migrations/floka.md"]);
    expect(r.allowed.history.occurrences).toBe(3);
    expect(r.allowed.protocol.occurrences).toBe(4);
  });

  test("机械替换名单里没有这些文件，也没有要手工迁移的标识", () => {
    const m = full();
    const r = scan(synthRepo(), m);
    const files = new Set(r.mechanical.map((x) => x.file));
    for (const f of ["sessions/2026-10-01.jsonl", "state/peers.json", "state/identity.json", "docs/migrations/floka.md"]) expect(files.has(f)).toBe(false);
    expect(files.has("README.md")).toBe(true);
    const manual = new Set(m.identifiers.filter((it) => it.replace === "manual").map((it) => it.id));
    expect(manual.has("sign.invite-pop")).toBe(true);
    expect(r.mechanical.filter((x) => manual.has(x.id))).toEqual([]);
  });

  test("历史文件里即使有没登记的用途字样也不报失败（历史不追认）", () => {
    // 合成 transcript 里带着 claudestra-future-thing-v9；换到普通源码文件里就是失败
    expect(scan(synthRepo(), full()).ok).toBe(true);
    const r = scan(synthRepo({ "src/x.ts": 'export const X = "claudestra-future-thing-v9";\n' }), full());
    expect(details(r)).toContain("claudestra-future-thing-v9");
  });

  test("明确不改的几项都在「不改」名单里，缺一项就失败", () => {
    const m = full();
    const values = m.unchanged.map((u) => u.value).join("\n");
    for (const v of ["tok_", "dev_", "relay://<指纹>", "v:1", "master.sock", "BRIDGE_URL"]) expect(values).toContain(v);
    for (const id of m.requiredUnchanged) {
      const cut = { ...m, unchanged: m.unchanged.filter((u) => u.id !== id) };
      expect(details(scan(synthRepo(), cut))).toContain(`unchanged_missing 「不改」名单缺 ${id}`);
    }
  });

  test("不改的无品牌标识不会被当成旧品牌命中", () => {
    const r = scan(synthRepo({ "src/plain.ts": 'export const a = ["tok_1a2b", "dev_ffee", "relay://ab12cd/api/v1", "master.sock", process.env.BRIDGE_URL];\n' }), full());
    expect(r.ok).toBe(true);
    expect(r.mechanical.some((x) => x.file === "src/plain.ts")).toBe(false);
  });
});

describe("[验收线 3] observe 不改输入，不读真实状态目录", () => {
  const io = () => ({ env: {}, home: fakeHome() });

  test("缺省就是 observe：输入目录哈希前后一致，什么都不写", () => {
    const root = synthRepo();
    const before = treeHash(root);
    const r = runCli(["--root", root], io());
    expect(r.code).toBe(0);
    expect(r.wrote).toBeNull();
    const report = JSON.parse(r.stdout) as InventoryReport;
    expect(report.mode).toBe("observe");
    expect(report.ok).toBe(true);
    expect(treeHash(root)).toBe(before);
  });

  test("observe 下报告失败也只是报告：退出码 0、不写文件；给了 --out 直接拒绝", () => {
    const root = synthRepo({ "src/x.ts": 'export const X = "claudestra-unknown-v3";\n' });
    const before = treeHash(root);
    const r = runCli(["--root", root, "--mode", "observe"], io());
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as InventoryReport).ok).toBe(false);
    const out = join(tmp("floka-inv-out-"), "report.json");
    const refused = runCli(["--root", root, "--mode", "observe", "--out", out], io());
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("out_needs_on");
    expect(existsSync(out)).toBe(false);
    expect(treeHash(root)).toBe(before);
  });

  test("off 什么都不做（连目录都不看）", () => {
    const r = runCli(["--root", "/nonexistent/floka-inv", "--mode", "off"], io());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ mode: "off", skipped: true });
  });

  test("on 只写显式指定的那一个输出，被扫目录照样不变", () => {
    const root = synthRepo();
    const outDir = tmp("floka-inv-out-");
    const out = join(outDir, "report.json");
    const before = treeHash(root);
    const r = runCli(["--root", root, "--mode", "on", "--out", out], io());
    expect(r.code).toBe(0);
    expect(r.wrote).toBe(join(realpathSync(outDir), "report.json"));
    expect(readdirSync(outDir)).toEqual(["report.json"]);
    expect((JSON.parse(readFileSync(out, "utf8")) as InventoryReport).mode).toBe("on");
    expect(treeHash(root)).toBe(before);
  });

  test("on 没给 --out、输出落在被扫目录里、输出已存在 → 都拒绝，且没有写入", () => {
    const root = synthRepo();
    const before = treeHash(root);
    expect(runCli(["--root", root, "--mode", "on"], io()).stderr).toContain("out_required");
    expect(runCli(["--root", root, "--mode", "on", "--out", join(root, "report.json")], io()).stderr).toContain("out_inside_root");
    const existing = join(tmp("floka-inv-out-"), "report.json");
    writeFileSync(existing, "keep");
    expect(runCli(["--root", root, "--mode", "on", "--out", existing], io()).stderr).toContain("out_exists");
    expect(readFileSync(existing, "utf8")).toBe("keep");
    expect(treeHash(root)).toBe(before);
  });

  test("on 且报告失败 → 退出码 1", () => {
    const root = synthRepo({ "src/x.ts": 'export const X = "claudestra-unknown-v3";\n' });
    const r = runCli(["--root", root, "--mode", "on", "--out", join(tmp("floka-inv-out-"), "r.json")], io());
    expect(r.code).toBe(1);
  });

  test("开关也能从显式给的配置文件读 rename.inventory；值不合法就拒绝", () => {
    const root = synthRepo();
    const cfgDir = tmp("floka-inv-cfg-");
    writeFileSync(join(cfgDir, "nested.json"), JSON.stringify({ rename: { inventory: "off" } }));
    writeFileSync(join(cfgDir, "dotted.json"), JSON.stringify({ "rename.inventory": "observe" }));
    writeFileSync(join(cfgDir, "empty.json"), "{}");
    writeFileSync(join(cfgDir, "bad.json"), JSON.stringify({ rename: { inventory: "yes" } }));
    expect(JSON.parse(runCli(["--root", root, "--config", join(cfgDir, "nested.json")], io()).stdout)).toEqual({ mode: "off", skipped: true });
    expect((JSON.parse(runCli(["--root", root, "--config", join(cfgDir, "dotted.json")], io()).stdout) as InventoryReport).mode).toBe("observe");
    expect((JSON.parse(runCli(["--root", root, "--config", join(cfgDir, "empty.json")], io()).stdout) as InventoryReport).mode).toBe("observe");
    expect(runCli(["--root", root, "--config", join(cfgDir, "bad.json")], io()).stderr).toContain("invalid_mode");
    expect(runCli(["--root", root, "--mode", "dry"], io()).stderr).toContain("invalid_mode");
  });

  test("扫描根是状态目录、运行时目录、或它们的上级 → 拒绝", () => {
    const home = fakeHome();
    const state = join(home, ".claude-orchestrator");
    mkdirSync(join(state, "archive"), { recursive: true });
    writeFileSync(join(state, "config.json"), '{"note":"claudestra-secret-v9"}');
    const m = full();
    expect(() => runInventory(state, m, { env: {}, home })).toThrow("refuse_state_dir");
    expect(() => runInventory(join(state, "archive"), m, { env: {}, home })).toThrow("refuse_state_dir");
    expect(() => runInventory(home, m, { env: {}, home })).toThrow("refuse_state_dir");
    const override = tmp("floka-inv-state-");
    expect(() => runInventory(override, m, { env: { CLAUDESTRA_STATE_DIR: override }, home })).toThrow("refuse_state_dir");
    const runtime = tmp("floka-inv-runtime-");
    expect(() => runInventory(runtime, m, { env: { CLAUDESTRA_RUNTIME_DIR: runtime }, home })).toThrow("refuse_state_dir");
    expect(runCli(["--root", state], { env: {}, home }).code).toBe(2);
  });

  test("仓库里指向状态目录的软链不跟：状态文件里的内容进不了报告", () => {
    const home = fakeHome();
    const state = join(home, ".claude-orchestrator");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), '{"note":"claudestra-secret-v9"}');
    const root = synthRepo();
    symlinkSync(state, join(root, "state-link"));
    symlinkSync(join(state, "config.json"), join(root, "config-link.json"));
    const r = runInventory(root, full(), { env: {}, home });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("claudestra-secret-v9");
  });

  test("状态目录下面带 .git 的检出（出借 worker 的工作副本）可以扫，不带 .git 的不行", () => {
    const home = fakeHome();
    const work = join(home, ".claude-orchestrator", "lend", "work", "order-1");
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "a.ts"), 'export const L = "com.claudestra.bridge";\n');
    const m = full();
    expect(() => runInventory(work, m, { env: {}, home })).toThrow("refuse_state_dir");
    mkdirSync(join(work, ".git"));
    const r = runInventory(work, m, { env: {}, home });
    expect(r.ok).toBe(true);
    expect(r.identifiers.find((i) => i.id === "daemon.bridge")!.callSites).toBe(1);
  });
});

describe("[验收线 4] 清单自身守规矩", () => {
  test("格式正确、类别齐全、id 不重复、每个标识的匹配口径都能编译", () => {
    const m = full();
    expect(m.format).toBe("claudestra.rename-inventory");
    expect(m.requiredCategories.length).toBe(18);
    expect(new Set(m.identifiers.map((it) => it.id)).size).toBe(m.identifiers.length);
    const r = scan(tmp("floka-inv-empty-"), m);
    expect(details(r)).toBe("");
  });

  test("清单与清点脚本都在 800 行以内", () => {
    for (const f of ["identifiers.json", "inventory.ts"]) {
      const lines = readFileSync(join(dirname(MANIFEST_PATH), f), "utf8").split("\n").length;
      expect(lines).toBeLessThanOrEqual(800);
    }
  });

  test("format / version 不对、正则写坏 → manifest_invalid，不抛异常", () => {
    const bad = { ...full(), version: 2 };
    expect(kinds(scan(synthRepo(), bad))).toContain("manifest_invalid");
    const broken = full();
    broken.identifiers[0]!.match = "(";
    delete broken.identifiers[0]!.members;
    const r = scan(synthRepo(), broken);
    expect(r.ok).toBe(false);
    expect(details(r)).toContain("正则不合法");
  });
});
