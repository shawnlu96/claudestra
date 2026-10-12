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

/** 只有这几个文件的合成仓库（不带 SYNTH 的底料），用来单独数某一种写法 */
function lone(files: Record<string, string>): string {
  const root = tmp("floka-inv-lone-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const fakeHome = () => tmp("floka-inv-home-");
const scan = (root: string, m: Manifest): InventoryReport => runInventory(root, m, { env: {}, home: fakeHome() });
const kinds = (r: InventoryReport) => r.failures.map((f) => f.kind);
const details = (r: InventoryReport) => r.failures.map((f) => `${f.kind} ${f.detail}`).join("\n");
/** 单个文件里某个登记项的 [文本出现, 调用点] */
const counts = (file: string, body: string, id = "cookie.device"): [number, number] => {
  const row = scan(lone({ [file]: body }), full()).identifiers.find((i) => i.id === id)!;
  return [row.textOccurrences, row.callSites];
};

/** 每个浏览器侧登记项（cookie / CSRF / 存储 / 消息 / 通知 tag）各一处真实写法：单独漏掉哪一项都必须报失败 */
const BROWSER_SAMPLES: Record<string, string> = {
  "cookie.device": 'export const COOKIE = "cstra_dev";',
  "cookie.local-claim": 'res.headers.append("set-cookie", "cstra_local_claim=1; Path=/");',
  "cookie.relay-home": 'const home = cookies.get("cstra_home");',
  "cookie.legacy-session": 'const LEGACY = "cstra_session";',
  "csrf.device-header": 'headers.set("x-cstra-device", "1");',
  "browser.idb": 'const req = indexedDB.open("cstra", 1);',
  "browser.local-storage": 'localStorage.setItem("cstra_theme", v);',
  "browser.sw-messages": 'w.postMessage({type: "cstra-open-agent"});',
  "browser.notification-tags": "const msg = { tag: `cstra-notice-${ts}` };",
};

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

  test("注释按列认：行中间的块注释、块注释收尾后同一行的代码、字符串里的 /* 和 //", () => {
    // 审查反例三则
    expect(counts("x.ts", "const x = 1; /* cstra_dev */\n")).toEqual([1, 0]);
    expect(counts("x.ts", '/* comment\n */ export const cookie = "cstra_dev";\n')).toEqual([1, 1]);
    expect(counts("x.ts", 'export const x="prefix /* suffix";\nexport const cookie="cstra_dev";\n')).toEqual([1, 1]);
    // 同一行里代码、块注释、代码、行尾注释各一处
    expect(counts("x.ts", 'const a = "cstra_dev"; /* cstra_dev */ const b = "cstra_dev"; // cstra_dev\n')).toEqual([4, 2]);
    // 字符串、模板字符串里的 // 不是注释；模板 ${ } 里的字符串也照常
    expect(counts("x.ts", 'const u = "http://h/x"; const c = "cstra_dev";\n')).toEqual([1, 1]);
    expect(counts("x.ts", "const u = `http://h/${id}\n  // cstra_dev 还在模板里\n  ${f(\"}\", `cstra_dev`)}`;\nconst c = 1; // cstra_dev\n")).toEqual([3, 2]);
    expect(counts("x.ts", "const s = 'it\\'s // not a comment'; const c = 'cstra_dev';\n")).toEqual([1, 1]);
    // 正则字面量里的引号和 /* 不开字符串、不开注释；除号不当正则
    expect(counts("x.ts", 'const q = s.replace(/"/g, ""); const c = "cstra_dev"; // cstra_dev\n')).toEqual([2, 1]);
    expect(counts("x.ts", 'const re = /[/*]+/;\nconst c = "cstra_dev";\n')).toEqual([1, 1]);
    expect(counts("x.ts", 'const half = (a + b) / 2; /* cstra_dev */ const c = "cstra_dev" / 1;\n')).toEqual([2, 1]);
    // 没闭合的引号只影响本行
    expect(counts("x.tsx", "<p>don't</p>\n{/* cstra_dev */}\n<b id=\"cstra_dev\" />\n")).toEqual([2, 1]);
  });

  test("别的语言：Rust 的生命周期标注不当字符串，CSS 没有 // 注释，shell 仍按整行 # 认", () => {
    expect(counts("x.rs", 'fn f<\'a>(s: &\'a str) {} // cstra_dev\nconst C: &str = "cstra_dev"; let q = \'"\'; /* cstra_dev */\n')).toEqual([3, 1]);
    expect(counts("x.css", '.a { background: url(//h/cstra_dev.png); } /* cstra_dev */\n')).toEqual([2, 1]);
    expect(counts("x.sh", "# cstra_dev\nNAME=cstra_dev\n")).toEqual([2, 1]);
    expect(counts("x.md", "`cstra_dev`\n")).toEqual([1, 0]);
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

  test("浏览器侧逐项遗漏：只删一项、别的都在，照样失败，且不进机械替换名单", () => {
    const ids = full().identifiers.filter((it) => ["cookie-csrf", "browser-storage"].includes(it.category)).map((it) => it.id);
    expect(Object.keys(BROWSER_SAMPLES).sort()).toEqual([...ids].sort());
    for (const [id, line] of Object.entries(BROWSER_SAMPLES)) {
      const root = lone({ "web/sw.ts": `${line}\n` });
      const whole = scan(root, full());
      expect(`${id} ${details(whole)}`).toBe(`${id} `);
      expect(whole.identifiers.find((i) => i.id === id)!.callSites).toBe(1);
      expect(whole.mechanical.filter((x) => x.id.startsWith("brand."))).toEqual([]);
      const m = full();
      m.identifiers = m.identifiers.filter((it) => it.id !== id);
      const r = scan(root, m);
      expect(`${id} ok=${r.ok}`).toBe(`${id} ok=false`);
      expect(r.totals.unregistered).toBe(1);
      expect(r.mechanical).toEqual([]);
    }
  });

  test("不带前缀的 cstra-<名字> 只认逐个点名：没登记的消息名不被品牌通配吞掉，点过名的进程内名字照常", () => {
    // 审查反例：只删 browser.sw-messages
    const m = full();
    m.identifiers = m.identifiers.filter((it) => it.id !== "browser.sw-messages");
    const r = scan(lone({ "sw.ts": 'postMessage({type: "cstra-open-agent"});\n' }), m);
    expect(r.ok).toBe(false);
    expect(details(r)).toContain("shape_unregistered cstra-open-agent");
    expect(details(r)).toContain("形状 short-dashed-name");
    expect(r.mechanical).toEqual([]);
    // 清单完整时，一个全新的消息名 / 缓存名同样失败，不管它写在什么语境里
    const fresh = scan(lone({ "sw.ts": 'const CACHE = "cstra-offline-cache";\nself.addEventListener("cstra-wake", f);\n' }), full());
    expect(fresh.totals.unregistered).toBe(2);
    expect(fresh.mechanical).toEqual([]);
    // 写法上就是进程内的（CSS / data- / 符号）和点过名的（DOM id、临时目录前缀族）可以机械替换
    const ok = scan(lone({
      "a.css": ".cstra-anything { color: var(--cstra-any-var); }\n",
      "a.tsx": 'const el = <div id="cstra-shell" data-cstra-whatever="1" className="x cstra-bubble" />;\nconst d = mkdtempSync(join(tmpdir(), "cstra-test-brand-new-"));\n',
    }), full());
    expect(details(ok)).toBe("");
    expect(ok.mechanical.map((x) => `${x.file} ${x.id} ${x.occurrences}`).sort()).toEqual(["a.css brand.short-internal 2", "a.tsx brand.short-internal 1", "a.tsx brand.short-names 3"]);
    // 品牌类的通配项就算把这个名字包进正则里，也不算点名
    const sneaky = full();
    sneaky.identifiers.find((it) => it.id === "brand.short-internal")!.match = "cstra-[a-z-]+";
    expect(scan(lone({ "sw.ts": 'const CACHE = "cstra-offline-cache";\n' }), sneaky).ok).toBe(false);
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

  test("源码 / 夹具里的 peer URL 与身份值按语境归协议，不看大小写、不看文件名", () => {
    const protocolOnly = (body: string, n: number) => {
      const r = scan(lone({ "fixture.ts": `${body}\n` }), full());
      expect(`${body} → ${details(r)}`).toBe(`${body} → `);
      expect(`${body} → ${r.allowed.protocol.occurrences}`).toBe(`${body} → ${n}`);
      expect(r.allowed.protocol.files).toEqual(["fixture.ts"]);
      expect(r.mechanical).toEqual([]);
      expect(r.totals.textOccurrences).toBe(0);
    };
    // 审查反例：主机名和中继路径段都是大写开头
    protocolOnly('const peer = { baseUrl: "https://Claudestra.example/r/Claudestra" };', 2);
    protocolOnly('const peer = { baseUrl: "https://claudestra.example/r/claudestra" };', 2);
    protocolOnly('const peer = { baseUrl: "https://CLAUDESTRA.example/r/CLAUDESTRA" };', 2);
    // 不靠字段名：任何语境里的网络地址都算，ws / relay 也算
    protocolOnly('await fetch("https://relay.example.com/r/Claudestra/api/v1/peers");', 1);
    protocolOnly('connect(`wss://Claudestra.example:8443/ws`, "relay://ab12cd/Claudestra");', 2);
    protocolOnly("// 对端在 http://10.0.0.2:3847/r/Claudestra", 1);
    // 不是 URL 的身份值：字段语境、句柄
    protocolOnly('const me = { instanceName: "Claudestra-Prod", slug: "Claudestra" };', 2);
    protocolOnly("peerName = 'Claudestra Lab'", 1);
    protocolOnly('send("Claudestra@Shawn", "reviewer@Claudestra");', 2);
  });

  test("地址语境不吞别的登记项：仓库地址仍归 repo.slug，地址旁边的品牌字样仍可机械替换", () => {
    const r = scan(lone({ "a.ts": 'const REPO = "https://github.com/shawnlu96/claudestra";\nconst title = "Claudestra"; const home = "https://x.example/Claudestra";\n' }), full());
    expect(details(r)).toBe("");
    expect(r.identifiers.find((i) => i.id === "repo.slug")!.callSites).toBe(1);
    expect(r.allowed.protocol.occurrences).toBe(1);
    expect(r.mechanical).toEqual([{ file: "a.ts", id: "brand.display", occurrences: 1 }]);
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

  test("--config / --manifest 落在状态、运行时目录里，或是指向那里的软链 → 读之前就拒绝", () => {
    const home = fakeHome();
    const state = join(home, ".claude-orchestrator");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "config.json"), JSON.stringify({ rename: { inventory: "off" } }));
    writeFileSync(join(state, "identifiers.json"), readFileSync(MANIFEST_PATH));
    const root = synthRepo();
    symlinkSync(join(state, "config.json"), join(root, "cfg-link.json"));
    symlinkSync(join(state, "identifiers.json"), join(root, "manifest-link.json"));
    symlinkSync(state, join(root, "state-link"));
    const before = treeHash(root);
    const refused = (args: string[], env: Record<string, string> = {}) => {
      const r = runCli(["--root", root, ...args], { env, home });
      expect(`${args.join(" ")} → ${r.code} ${r.stderr.split(":")[0]}`).toBe(`${args.join(" ")} → 2 refuse_state_input`);
      expect(r.stdout).toBe("");
    };
    // 审查反例：状态目录里的 config（原先返回 mode off / code 0）、清单（原先返回 ok true）
    refused(["--config", join(state, "config.json")]);
    refused(["--config", join(root, "cfg-link.json")]);
    refused(["--config", join(root, "state-link", "config.json")]);
    refused(["--manifest", join(state, "identifiers.json")]);
    refused(["--manifest", join(root, "manifest-link.json")]);
    // --mode 已经定了开关，给的 --config 也照样先核；相对路径按 cwd 解析后再核
    refused(["--mode", "observe", "--config", join(state, "config.json")]);
    expect(runCli(["--root", root, "--config", ".claude-orchestrator/config.json"], { env: {}, home, cwd: home }).stderr).toContain("refuse_state_input");
    // 环境变量指过去的状态 / 运行时目录同样算
    for (const key of ["CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"]) {
      const dir = tmp("floka-inv-envdir-");
      writeFileSync(join(dir, "c.json"), JSON.stringify({ rename: { inventory: "off" } }));
      refused(["--config", join(dir, "c.json")], { [key]: dir });
    }
    expect(treeHash(root)).toBe(before);
  });

  test("输入文件的例外只有状态目录下面仓库检出里的文件；不存在、不是文件都拒绝", () => {
    const home = fakeHome();
    const state = join(home, ".claude-orchestrator");
    const work = join(state, "lend", "work", "order-1");
    mkdirSync(join(work, "scripts"), { recursive: true });
    writeFileSync(join(work, "scripts", "identifiers.json"), readFileSync(MANIFEST_PATH));
    const root = synthRepo();
    const run = (manifest: string) => runCli(["--root", root, "--manifest", manifest], { env: {}, home });
    expect(run(join(work, "scripts", "identifiers.json")).stderr).toContain("refuse_state_input");
    mkdirSync(join(work, ".git"));
    const ok = run(join(work, "scripts", "identifiers.json"));
    expect(ok.code).toBe(0);
    expect((JSON.parse(ok.stdout) as InventoryReport).ok).toBe(true);
    // 状态目录自己带 .git 不算检出：它下面的状态文件仍然拒绝
    mkdirSync(join(state, ".git"));
    writeFileSync(join(state, "identifiers.json"), readFileSync(MANIFEST_PATH));
    expect(run(join(state, "identifiers.json")).stderr).toContain("refuse_state_input");
    expect(run(join(root, "no-such.json")).stderr).toContain("input_missing");
    expect(run(join(root, "src")).stderr).toContain("input_not_file");
    expect(runCli(["--root", root, "--config", join(root, "no-such.json")], { env: {}, home }).code).toBe(2);
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
