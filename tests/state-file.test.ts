import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readJsonState,
  readJsonStateSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
  writeJsonStateGuarded,
  StateCorruptError,
} from "../src/lib/state-file";
import { readPrincipals, syncDiscordOwnersFromEnv, writePrincipals } from "../src/lib/principals";
import { readProjects, writeProjects } from "../src/lib/projects";

const tmp = () => mkdtempSync(join(tmpdir(), "state-file-"));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

describe("readJsonState 三态", () => {
  test("不存在 / 损坏 / 正常", async () => {
    const d = tmp();
    expect(await readJsonState(join(d, "nope.json"))).toEqual({ status: "missing" });
    writeFileSync(join(d, "bad.json"), "{bad");
    expect((await readJsonState(join(d, "bad.json"))).status).toBe("corrupt");
    writeFileSync(join(d, "ok.json"), '{"a":1}');
    expect(await readJsonState(join(d, "ok.json"))).toEqual({ status: "ok", data: { a: 1 } });
    expect(readJsonStateSync(join(d, "ok.json"))).toEqual({ status: "ok", data: { a: 1 } });
  });

  test("结构校验不过也算损坏", async () => {
    const d = tmp();
    writeFileSync(join(d, "x.json"), '{"principals":{}}');
    const r = await readJsonState(join(d, "x.json"), (v: any) => Array.isArray(v?.principals));
    expect(r.status).toBe("corrupt");
  });
});

describe("原子写", () => {
  test("mode 生效、不残留 tmp、并发写后仍是合法 JSON", async () => {
    const d = tmp();
    const p = join(d, "s.json");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(p, { i }, { mode: 0o600 })));
    expect(JSON.parse(readFileSync(p, "utf-8")).i).toBeGreaterThanOrEqual(0);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("preserveMode 沿用原文件权限；同步版一致", () => {
    const d = tmp();
    const p = join(d, "settings.json");
    writeFileSync(p, "{}", { mode: 0o640 });
    writeJsonAtomicSync(p, { x: 1 }, { preserveMode: true, trailingNewline: true });
    expect(statSync(p).mode & 0o777).toBe(0o640);
    expect(readFileSync(p, "utf-8").endsWith("}\n")).toBe(true);
  });

  test("guarded：磁盘上是坏文件就拒写、字节不变、留 .corrupt-* 备份", async () => {
    const d = tmp();
    const p = join(d, "cron.json");
    writeFileSync(p, "[{bad");
    await expect(writeJsonStateGuarded(p, [], { validate: Array.isArray })).rejects.toBeInstanceOf(StateCorruptError);
    expect(readFileSync(p, "utf-8")).toBe("[{bad");
    expect(readdirSync(d).some((f) => f.startsWith("cron.json.corrupt-"))).toBe(true);
  });
});

describe("principals.json 损坏时不抹掉 token（D7-4）", () => {
  test("owner 同步读到坏文件：抛错、文件字节不变", async () => {
    const d = tmp();
    const p = join(d, "principals.json");
    writeFileSync(p, '{"principals":[{"id":"token:tok_1"');
    await expect(syncDiscordOwnersFromEnv(["123456789012345678"], p)).rejects.toBeInstanceOf(StateCorruptError);
    expect(readFileSync(p, "utf-8")).toBe('{"principals":[{"id":"token:tok_1"');
  });

  test("读者按空处理（fail-closed），写者拒绝覆盖", async () => {
    const d = tmp();
    const p = join(d, "principals.json");
    writeFileSync(p, "{bad");
    const file = await quiet(() => readPrincipals(p));
    expect(file.principals).toEqual([]);
    await expect(writePrincipals({ principals: [] }, p)).rejects.toBeInstanceOf(StateCorruptError);
    expect(readFileSync(p, "utf-8")).toBe("{bad");
  });

  test("正常路径：不存在时 owner 同步建文件，0600", async () => {
    const d = tmp();
    const p = join(d, "principals.json");
    expect(await syncDiscordOwnersFromEnv(["123456789012345678"], p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect((await readPrincipals(p)).principals[0].id).toBe("discord:123456789012345678");
  });
});

describe("projects.json", () => {
  test("坏文件读成空但不被覆盖", async () => {
    const d = tmp();
    const p = join(d, "projects.json");
    writeFileSync(p, "{oops");
    expect((await quiet(() => readProjects(p))).projects).toEqual([]);
    await expect(writeProjects({ projects: [] }, p)).rejects.toBeInstanceOf(StateCorruptError);
    expect(readFileSync(p, "utf-8")).toBe("{oops");
  });
});
