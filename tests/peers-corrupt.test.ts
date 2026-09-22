/**
 * peers.json 损坏：读者不抛（当空），写者拒写并留 .corrupt 备份——manager 的 peer 命令
 * 是读改写，以前把「坏了」当「空」照写会抹掉全部 peer 和双方 token（D7-4）。
 * 路径是模块常量，借 CLAUDESTRA_STATE_DIR 在子进程里指向临时目录。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const MOD = join(import.meta.dir, "../src/lib/peers.ts");

function run(stateDir: string, body: string) {
  const r = spawnSync(process.execPath, ["-e", `import * as m from ${JSON.stringify(MOD)};\n${body}`], {
    env: { ...process.env, CLAUDESTRA_STATE_DIR: stateDir },
    encoding: "utf-8",
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("peers.json", () => {
  test("损坏 → 读当空，写拒绝，原文件不变且留备份", () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-bad-"));
    const p = join(dir, "peers.json");
    writeFileSync(p, "{bad");
    const r = run(dir, `
      const d = await m.readPeers();
      console.log(d.httpPeers.length);
      try { await m.writePeers({ httpPeers: [], pendingInvites: [] }); console.log("wrote"); }
      catch (e) { console.log("refused:" + e.name); }`);
    expect(r.out.split("\n")).toEqual(["0", "refused:StateCorruptError"]);
    expect(readFileSync(p, "utf-8")).toBe("{bad");
    expect(readdirSync(dir).some((f) => f.startsWith("peers.json.corrupt-"))).toBe(true);
  });

  test("正常写 → 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-ok-"));
    const r = run(dir, `await m.writePeers({ httpPeers: [], pendingInvites: [] }); console.log("ok");`);
    expect(r.out).toBe("ok");
    expect(statSync(join(dir, "peers.json")).mode & 0o777).toBe(0o600);
  });
});
