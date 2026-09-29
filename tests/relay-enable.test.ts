/**
 * Peer 面板「一键接入中继」（bridge/relay-link.ts enableRelay / parseRelaySetup）：写 .env 的 RELAY_URL 后当场连；
 * 连不了就把 .env 恢复原样、撤副作用；同一时刻只有一次在做；地址里的 $ 不收（Bun 读 .env 会展开）。
 * .env 都写在临时目录，Bun 读回用真的 `bun --env-file` 子进程，环境是 testChildEnv 的最小集。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableRelay, parseRelaySetup, type EnableRelayDeps, type RelayStart } from "../src/bridge/relay-link.js";
import { readDotenvFileSync } from "../src/lib/env-file.js";
import { DEFAULT_RELAY_URL } from "../src/lib/setup-remote-access.js";
import { testChildEnv } from "./test-env.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ORIGINAL = "# Claudestra 运行时配置\nDISCORD_BOT_TOKEN=abc\nBRIDGE_PORT=3847\n";

function harness(over: { env?: string | null; start?: () => Promise<RelayStart>; state?: string | null; sandbox?: string | null; current?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-enable-"));
  dirs.push(dir);
  const envPath = join(dir, ".env");
  const env = over.env === undefined ? ORIGINAL : over.env;
  if (env !== null) {
    writeFileSync(envPath, env);
    chmodSync(envPath, 0o600);
  }
  let starts = 0, undos = 0;
  const d: EnableRelayDeps = {
    envPath, lockPath: join(dir, "env-write.lock"),
    sandbox: () => over.sandbox ?? null,
    current: () => over.current ?? readDotenvFileSync(envPath)?.RELAY_URL?.trim() ?? "",
    start: async () => (starts++, over.start ? over.start() : { ok: true }),
    undo: async () => void undos++,
    state: () => over.state ?? "online",
  };
  return { d, dir, envPath, starts: () => starts, undos: () => undos, text: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null) };
}

/** 真的让 Bun 读这份 .env：cwd 放在空目录里，免得 Bun 顺手再读别的 .env */
function bunReads(envPath: string, key: string, extraEnv: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "relay-env-read-"));
  dirs.push(cwd);
  const r = Bun.spawnSync([process.execPath, `--env-file=${envPath}`, "--print", `process.env.${key}`], {
    cwd, env: testChildEnv(extraEnv),
  });
  return r.stdout.toString().trim();
}

describe("enableRelay", () => {
  test("不给地址 = 官方中继：写进 .env 后当场连，其余配置逐字节不动", async () => {
    const h = harness();
    expect(await enableRelay(undefined, h.d)).toEqual({ ok: true, relayUrl: DEFAULT_RELAY_URL, state: "online" });
    expect(h.text()).toBe(`${ORIGINAL}RELAY_URL=${DEFAULT_RELAY_URL}\n`);
    expect(h.starts()).toBe(1);
  });
  test("给了地址按 setup 的规矩规整（裸主机名补 wss://）", async () => {
    expect(await enableRelay("relay.example.com/", harness().d)).toMatchObject({ ok: true, relayUrl: "wss://relay.example.com" });
  });
  test("已经配了、沙箱、地址不对：不写不连", async () => {
    for (const [h, arg, status] of [[harness({ current: "wss://x" }), undefined, 409], [harness({ sandbox: "沙箱" }), undefined, 409], [harness(), "not a url", 400]] as const) {
      expect(await enableRelay(arg, h.d)).toMatchObject({ ok: false, status });
      expect(h.text()).toBe(ORIGINAL);
      expect(h.starts()).toBe(0);
    }
  });
  test("「离线在重连」不算失败：不回滚，把状态带回去让前端单列", async () => {
    const h = harness({ state: "offline" });
    expect(await enableRelay(undefined, h.d)).toMatchObject({ ok: true, state: "offline" });
    expect(h.undos()).toBe(0);
    expect(readDotenvFileSync(h.envPath)?.RELAY_URL).toBe(DEFAULT_RELAY_URL);
  });
});

describe("连不了就回滚", () => {
  test("start 报失败（比如没有实例密钥）：.env 恢复成写之前的字节、权限不变，副作用撤掉", async () => {
    const h = harness({ start: async () => ({ ok: false, error: "本机没有实例密钥" }) });
    expect(await enableRelay(undefined, h.d)).toMatchObject({ ok: false, status: 500 });
    expect(h.text()).toBe(ORIGINAL);
    expect(statSync(h.envPath).mode & 0o777).toBe(0o600);
    expect(h.undos()).toBe(1);
  });
  test("start 抛异常同样回滚；原来没有 .env 的，回滚后也没有", async () => {
    const h = harness({ env: null, start: async () => { throw new Error("boom"); } });
    expect(await enableRelay(undefined, h.d)).toMatchObject({ ok: false, status: 500 });
    expect(h.text()).toBeNull();
    expect(h.undos()).toBe(1);
  });
  test("写 .env 是 tmp + rename：成功后权限还是 0600，目录里不留临时文件", async () => {
    const h = harness();
    await enableRelay(undefined, h.d);
    expect(statSync(h.envPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.dir).sort()).toEqual([".env"]);
  });
});

describe("并发", () => {
  test("两个请求同时进来：只有一个写、一个连，另一个 409", async () => {
    let open!: () => void;
    const barrier = new Promise<void>((r) => (open = r));
    const h = harness({ start: async () => (await barrier, { ok: true }) });
    const both = Promise.all([enableRelay(undefined, h.d), enableRelay("relay.other.example", h.d)]);
    open();
    const rs = await both;
    expect(rs.map((r) => (r.ok ? 200 : r.status)).sort()).toEqual([200, 409]);
    expect(h.starts()).toBe(1);
    expect(readDotenvFileSync(h.envPath)?.RELAY_URL).toBe(DEFAULT_RELAY_URL);
  });
  test("锁在上一次结束后释放；锁里重读 .env，已经配上的第二次 409", async () => {
    const h = harness();
    expect((await enableRelay(undefined, h.d)).ok).toBe(true);
    expect(await enableRelay(undefined, h.d)).toMatchObject({ ok: false, status: 409 });
    expect(existsSync(h.d.lockPath)).toBe(false);
  });
});

describe("Bun 读 .env 会展开 $：地址里带 $ 一律不收", () => {
  test("测试本身有效：原样写进去的 $FAKE_SECRET 会被 Bun 换成环境变量", () => {
    const h = harness({ env: "RELAY_URL=wss://relay.example.test/$FAKE_SECRET\n" });
    expect(bunReads(h.envPath, "RELAY_URL", { FAKE_SECRET: "leaked" })).toBe("wss://relay.example.test/leaked");
  });
  test("$VAR / ${VAR} / 主机名里的 $：400，.env 不动", async () => {
    for (const bad of ["wss://relay.example.test/$FAKE_SECRET", "wss://relay.example.test/${HOME}", "$HOME.example.test"]) {
      const h = harness();
      expect(await enableRelay(bad, h.d)).toMatchObject({ ok: false, status: 400 });
      expect(h.text()).toBe(ORIGINAL);
    }
  });
  test("收下的地址写进 .env 后，Bun 读回来和原值一模一样", async () => {
    for (const url of ["wss://relay.example.test", "wss://relay.example.test:8443/a/b", "ws://10.0.0.2:7000", "wss://relay.example.test/it's", "wss://relay.example.test/%24x"]) {
      const h = harness();
      const r = await enableRelay(url, h.d);
      expect(r.ok).toBe(true);
      expect(bunReads(h.envPath, "RELAY_URL", { x: "leaked" })).toBe(r.ok ? r.relayUrl : "");
    }
  });
});

describe("parseRelaySetup：只有空 body / 省略字段才用官方中继", () => {
  test("空 body、{}：用默认", () => {
    expect(parseRelaySetup("")).toEqual({ ok: true });
    expect(parseRelaySetup("{}")).toEqual({ ok: true });
    expect(parseRelaySetup('{"relayUrl":"relay.example.com"}')).toEqual({ ok: true, relayUrl: "relay.example.com" });
  });
  test("坏 JSON、拼错字段、类型不对、空字符串、数组：400", () => {
    for (const bad of ["{", '{"url":"x"}', '{"relayUrl":{}}', '{"relayUrl":false}', '{"relayUrl":""}', "[]", "null", '"wss://x"']) {
      expect(parseRelaySetup(bad).ok).toBe(false);
    }
  });
});
