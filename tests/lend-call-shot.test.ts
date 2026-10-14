/**
 * LENDUI2 出站命令 `manager lend call <peer> shot --meta '<json>' --png-file <path>`（src/manager/lend-call.ts）：调度服务环境闸、
 * 拷贝只认 LEND_ROOT/work 下的普通文件（不跟软链、nlink 1、≤ 1 MiB）、meta 封闭、请求体上限，token 不进参数也不进输出；
 * 其他 op 的形状与行为不变。出站换成假 fetch（不连网），peers 记录用假的，LEND_ROOT 用临时目录。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shotArgv } from "../src/lib/lend-deps.js";
import { LEND_SHOT_LIMITS, parseLendShot } from "../src/lib/lend-ui-wire.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { cmdLendCall, type LendCallIo } from "../src/manager/lend-call.js";

const TOKEN = "out-token-SECRET-1234567890";
const PEER = { name: "mate", addedAt: "x", fp: "abcd", baseUrl: "relay://abcd", outToken: TOKEN, publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const H2 = "c".repeat(40);
const META = { orderId: "lend:T9:1", gen: 1, head: H2, view: "home", size: "390x844", phase: "before" };

function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  b.set(data, 8);
  return b;
}
function png(seed: string, pad = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(390, 0);
  d.writeUInt32BE(844, 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", d), chunk("IDAT", Buffer.concat([Buffer.from(seed), Buffer.alloc(pad)])),
    chunk("IEND", Buffer.alloc(0))]);
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["CLAUDESTRA_SCHEDULER_SERVICE", "DISCORD_CHANNEL_ID", "CLAUDESTRA_LEND_WORKER", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
let lendRoot: string;
let copy: string;
let sent: { url: string; init: RequestInit }[];

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.CLAUDESTRA_SCHEDULER_SERVICE = "1";
  lendRoot = mkdtempSync(join(tmpdir(), "lend-call-shot-"));
  copy = join(lendRoot, "work", "o1", ".git", "lend-ui-shots");
  mkdirSync(copy, { recursive: true });
  sent = [];
});
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const io = (over: Partial<LendCallIo> = {}): LendCallIo => ({
  lendRoot, findPeer: async () => PEER,
  fetch: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ ok: true, v: 1, ref: "s01.png" }), { status: 200 }); },
  ...over,
});
async function run(args: string[], o: LendCallIo = io()): Promise<{ out: Record<string, any>; raw: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => lines.push(s);
  try { await cmdLendCall(args, o); } finally { console.log = log; }
  return { out: JSON.parse(lines[0]!), raw: lines.join("\n") };
}
/** 拷贝按 lend submit 的样子起名：<去过元数据的字节的 sha256>.png */
const put = (b: Buffer, name = `${createHash("sha256").update(b).digest("hex")}.png`): string => { const f = join(copy, name); writeFileSync(f, b); return f; };
const shot = (file: string, meta: unknown = META) => ["mate", "shot", "--meta", typeof meta === "string" ? meta : JSON.stringify(meta), "--png-file", file];

describe("[验收线 4] lend call shot", () => {
  test("合法：子进程自己读拷贝、用 lendShotBody 拼请求体（A 的解析器认），E2E 出站带 Bearer；argv 与输出里都没有 token", async () => {
    const file = put(png("before"));
    const argv = shotArgv("mate", { meta: META, file });
    expect(argv).toEqual(["lend", "call", ...shot(file)]);
    const { out, raw } = await run(argv.slice(2));
    expect(out).toEqual({ ok: true, status: 200, body: { ok: true, v: 1, ref: "s01.png" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("relay://abcd/api/v1/lend/shot");
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const parsed = parseLendShot(JSON.parse(String(sent[0]!.init.body)));
    expect(parsed).toMatchObject({ ok: true, value: { ...META, width: 390, height: 844 } });
    expect(argv.join(" ")).not.toContain(TOKEN);
    expect(raw).not.toContain(TOKEN);
  });

  test("不是调度服务环境 → forbidden，不发请求", async () => {
    const file = put(png("b"));
    for (const env of [{ CLAUDESTRA_SCHEDULER_SERVICE: "" }, { DISCORD_CHANNEL_ID: "123" }, { CLAUDESTRA_LEND_WORKER: "1" }]) {
      process.env.CLAUDESTRA_SCHEDULER_SERVICE = "1";
      delete process.env.DISCORD_CHANNEL_ID;
      delete process.env.CLAUDESTRA_LEND_WORKER;
      Object.assign(process.env, env);
      expect((await run(shot(file))).out).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(sent).toHaveLength(0);
  });

  test("png-file 是软链 / 硬链 / 在 LEND_ROOT/work 外 / 超过 1 MiB → 本地拒，不发请求", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "lend-call-out-")), "x.png");
    writeFileSync(outside, png("o"));
    const inside = join(copy, "real.png");
    writeFileSync(inside, png("r"));
    symlinkSync(outside, join(copy, "link-out.png"));
    symlinkSync(inside, join(copy, "link-in.png"));
    linkSync(outside, join(copy, "hard.png"));
    writeFileSync(join(lendRoot, "push.png"), png("p"));
    writeFileSync(join(copy, "big.png"), png("b", LEND_SHOT_LIMITS.png));
    const cases: [string, string][] = [
      [join(copy, "link-out.png"), "软链"], [join(copy, "link-in.png"), "软链不收"], [join(copy, "hard.png"), "硬链接"],
      [outside, "不在这张单的工作副本里"], [join(lendRoot, "push.png"), "不在这张单的工作副本里"], [join(copy, "big.png"), `超过 ${LEND_SHOT_LIMITS.png}`],
    ];
    for (const [file, why] of cases) {
      const { out } = await run(shot(file));
      expect({ file, ok: out.ok, code: out.code }).toEqual({ file, ok: false, code: "invalid" });
      expect(out.error).toContain(why);
    }
    expect(sent).toHaveLength(0);
  });

  test("子进程只发自己读到、摘要等于文件名并已去干净元数据的字节；核过之后被换掉 → 本地拒，不发请求（审查 upload-reread-privacy-race）", async () => {
    const clean = png("a");
    const name = `${createHash("sha256").update(clean).digest("hex")}.png`;
    const iend = clean.length - 12;
    const priv = Buffer.concat([clean.subarray(0, iend), chunk("tEXt", Buffer.from("Comment\0/Users/he/secret")), clean.subarray(iend)]);
    const swapped = put(priv, name); // 父进程核过原拷贝后，worker 把同名文件换成带私有元数据的 PNG
    const r1 = await run(shot(swapped));
    expect(r1.out).toMatchObject({ ok: false, code: "local_changed" });
    expect(r1.raw).not.toContain("secret");
    const iccp = Buffer.concat([clean.subarray(0, 33), chunk("iCCP", Buffer.from("MacBook Display\0\0x")), clean.subarray(33)]);
    for (const dirty of [priv, iccp]) expect((await run(shot(put(dirty)))).out).toMatchObject({ ok: false, code: "invalid", error: "截图拷贝没去干净元数据" });
    expect((await run(shot(put(clean, "a.png")))).out).toMatchObject({ ok: false, code: "invalid" }); // 不是 <sha256>.png
    expect(sent).toHaveLength(0);
    put(clean, name);
    expect((await run(shot(swapped))).out).toMatchObject({ ok: true, status: 200 });
    const got = parseLendShot(JSON.parse(String(sent[0]!.init.body)));
    expect(got.ok && Buffer.from(got.value.png).equals(clean)).toBe(true);
  });

  test("meta 多键 / 少键 / 字段不对 / 超过 1 KiB → 拒；拼出的请求体超过上限 → 拒；都不发请求", async () => {
    const file = put(png("a"));
    const { phase: _p, ...missing } = META;
    for (const meta of [{ ...META, png: "x" }, missing, { ...META, gen: 0 }, { ...META, head: "abc" }, { ...META, phase: "during" }, "不是 JSON",
      { ...META, view: "v".repeat(1100) }]) {
      expect((await run(shot(file, meta))).out).toMatchObject({ ok: false, code: "invalid" });
    }
    // 1 MiB 的 PNG 编码后到不了 1.5 MiB：上限换小来验「超了就在本地拒」这条路
    const { out } = await run(shot(file), io({ bodyMax: 200 }));
    expect(out).toMatchObject({ ok: false, code: "invalid", error: "请求体超过 200 字节" });
    expect(sent).toHaveLength(0);
  });

  test("参数形状不对 → usage；对方回 4xx 照样 ok:true 带状态码；抛错 = transport", async () => {
    const file = put(png("a"));
    for (const args of [["mate", "shot", "--body", "{}"], ["mate", "shot", "--meta", JSON.stringify(META)], [...shot(file), "extra"], ["mate", "shot", "--png-file", file, "--meta", "{}"]]) {
      expect((await run(args)).out.error).toContain("usage");
    }
    const refused = await run(shot(file), io({ fetch: async () => new Response(JSON.stringify({ ok: false, code: "shots_off" }), { status: 403 }) }));
    expect(refused.out).toEqual({ ok: true, status: 403, body: { ok: false, code: "shots_off" } });
    const broken = await run(shot(file), io({ fetch: async () => { throw new Error("断了"); } }));
    expect(broken.out).toMatchObject({ ok: false, code: "transport" });
  });

  test("poll / claim / lease / result / hello / beat / ask 的行为不变：--body 原样发到 /api/v1/lend/<op>，不收 --meta / --png-file", async () => {
    for (const op of ["poll", "claim", "lease", "result", "hello", "beat", "ask"]) {
      sent = [];
      const body = JSON.stringify({ op });
      expect((await run(["mate", op, "--body", body])).out).toEqual({ ok: true, status: 200, body: { ok: true, v: 1, ref: "s01.png" } });
      expect([sent[0]!.url, sent[0]!.init.body]).toEqual([`relay://abcd/api/v1/lend/${op}`, body]);
      expect((await run(["mate", op, "--meta", "{}", "--png-file", "x"])).out.error).toContain("usage");
    }
    expect((await run(["mate", "poll", "--body", "x".repeat(96 * 1024 + 1)])).out).toEqual({ ok: false, error: `请求体超过 ${96 * 1024} 字节` });
    expect((await run(["mate", "nope", "--body", "{}"])).out.error).toContain("usage");
  });
});
