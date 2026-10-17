import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ciIoTraceChild, testChildEnv } from "./test-env.ts";

// 没加载 preload 的 bun test（--config=/dev/null、仓库外 cwd）由 src/lib/test-guard.ts 兜底装运行临时根，跑完由看门子进程删根。
// 本进程的 tmpdir() 是 preload 的运行临时根：test-guard 认出路径里的 cstra-test-run- 会跳过兜底，所以检查目录放在它的父目录
// （启动时的系统临时目录），用后即删。
const SPAWN_TIMEOUT = 60_000;
const repo = join(import.meta.dir, "..");
const systemTmp = dirname(realpathSync(tmpdir()));
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function probe(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tmp-root-fallback-"));
  cleanup.push(dir);
  const file = join(dir, "probe.test.ts");
  writeFileSync(file, `import ${JSON.stringify(join(repo, "src/lib/test-guard.ts"))};
import { test } from "bun:test"; import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
test("probe", () => { ${body} });`);
  return file;
}

test("没 preload 的 runner 成功跑完：兜底根连同测试和不传 env 的子进程建的目录一起删掉，检查目录顶层为空", () => {
  const file = probe(`
    mkdtempSync(join(tmpdir(), "probe-own-"));
    const child = Bun.spawnSync([process.execPath, "-e", "require('fs').mkdtempSync(require('os').tmpdir() + '/probe-child-')"]);
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  `);
  const trace = ciIoTraceChild();
  const run = Bun.spawnSync([process.execPath, ...trace.argv, join(repo, "scripts/test-tmp-leak.ts"), "--config=/dev/null", file], {
    cwd: dirname(file),
    env: testChildEnv({ ...trace.env, TMPDIR: systemTmp, TMP: systemTmp, TEMP: systemTmp }),
  });
  const stderr = run.stderr.toString();
  expect(stderr).toContain("1 pass");
  expect(stderr).toContain("顶层为空");
  expect(run.exitCode).toBe(0);
}, SPAWN_TIMEOUT);

test("兜底根被换成别的目录：看门子进程不删", async () => {
  const parent = mkdtempSync(join(systemTmp, "cstra-tmpleak-fb-"));
  cleanup.push(parent);
  // 测试里把自己的根换成同名的另一个目录（dev/ino 变了），runner 退出后它必须原样留着
  const file = probe(`
    const { renameSync, mkdirSync, writeFileSync } = require("node:fs");
    const root = tmpdir();
    renameSync(root, root + "-moved");
    mkdirSync(root);
    writeFileSync(join(root, "keep"), "x");
  `);
  const trace = ciIoTraceChild();
  const run = Bun.spawn([process.execPath, "test", ...trace.argv, "--config=/dev/null", file], {
    cwd: dirname(file),
    env: testChildEnv({ ...trace.env, TMPDIR: parent, TMP: parent, TEMP: parent }),
    stderr: "pipe",
  });
  // 看门子进程继承 runner 的 stderr：读到 EOF 时它也退出了（spawnSync 只等 runner，不等它）
  const stderr = await new Response(run.stderr).text();
  expect(stderr).toContain("1 pass");
  expect(stderr).toContain("已被替换，不删");
  const kept = readdirSync(parent).find((n) => !n.endsWith("-moved"))!;
  expect(readdirSync(join(parent, kept))).toEqual(["keep"]);
}, SPAWN_TIMEOUT);
