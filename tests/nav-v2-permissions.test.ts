/**
 * navV2（新版整页宿主的全局开关）：缺省开、manage 才能写、写了落盘重读一致。走真的 handleSettings + config-store（隔离状态目录）。
 * 前端读失败保留上次值、两种外壳切换在 tests/web-dom-nav-v2.test.ts。
 */
import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readConfig, setNavV2 } from "../src/lib/config-store.js";
import { CONFIG_PATH } from "../src/lib/paths.js";
import { handleSettings } from "../src/bridge/local-api/settings.js";
import type { Principal } from "../src/lib/principals.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "t" };
const guest: Principal = { id: "guest:x", role: "external", agents: ["agent-calm"], createdAt: "t" };
const call = (method: string, principal: Principal, body?: unknown) => handleSettings(new Request("http://fixture/settings", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
}), "/settings", principal);

test("[验收线 2] navV2 defaults on when config has no value, for any credential", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh" }));
  expect(await (await call("GET", guest))!.json()).toMatchObject({ navV2: true });
  expect(await (await call("GET", owner))!.json()).toMatchObject({ navV2: true });
  expect((await readConfig()).navV2).toBeUndefined();
});

test("[验收线 2] non-manage write is rejected and leaves disk untouched", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", unrelated: { keep: 1 } }));
  const before = readFileSync(CONFIG_PATH, "utf8");
  expect((await call("PUT", guest, { navV2: false }))!.status).toBe(403);
  expect(readFileSync(CONFIG_PATH, "utf8")).toBe(before);
  expect(await (await call("GET", guest))!.json()).toMatchObject({ navV2: true });
});

test("[验收线 2] manage write persists, survives reread and other setters, strict boolean", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", unrelated: { keep: 1 } }));
  expect((await call("PUT", owner, { navV2: "false" }))!.status).toBe(400);
  expect(await (await call("PUT", owner, { navV2: false }))!.json()).toMatchObject({ navV2: false });
  expect((await readConfig()).navV2).toBe(false);
  expect(await (await call("PUT", owner, { lang: "en" }))!.json()).toMatchObject({ navV2: false, lang: "en" });
  expect(await (await call("GET", guest))!.json()).toMatchObject({ navV2: false });
  expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).unrelated).toEqual({ keep: 1 });
  await setNavV2(true);
  expect(await (await call("GET", owner))!.json()).toMatchObject({ navV2: true, lang: "en" });
});
