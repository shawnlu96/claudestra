/**
 * 写 codex app-server 的 schema 锁（tests/fixtures/codex-app-server/）。生成逻辑在 src/lib/acp/codex-compat-lock.ts（更新闸也用）。
 * 用法：bun scripts/codex-schema/lock.ts [--cli <codex>] [--out <dir>] [--check]（--check 只在临时目录生成，按漂移分级和已提交的锁比）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, type LockSet } from "../../src/lib/acp/codex-compat-drift.ts";
import { FIXTURE_DIR, generateLockSet, lockProblems, PARTS, readLockSet } from "../../src/lib/acp/codex-compat-lock.ts";
import { sortKeys } from "../../src/lib/acp/codex-compat-project.ts";

export { buildOutbound, generateLockSet, lockProblems, overlayInbound, readLockSet } from "../../src/lib/acp/codex-compat-lock.ts";

function writeLockSet(dir: string, s: LockSet): void {
  mkdirSync(dir, { recursive: true });
  for (const [k, f] of Object.entries(PARTS)) writeFileSync(join(dir, f), `${JSON.stringify(sortKeys(s[k as keyof LockSet]), null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const say = (s: string) => void process.stdout.write(`${s}\n`);
  const set = generateLockSet(arg("--cli") ?? process.env.CODEX_SCHEMA_CLI ?? "codex");
  if (argv.includes("--check")) {
    const r = classify(readLockSet(arg("--out")), set);
    for (const f of r.findings) say(`[${f.level}] ${f.where}：${f.why}`);
    say(`漂移等级：${r.level}（新 CLI ${set.lock.cliVersion}）`);
    return r.level === "red" ? 1 : 0;
  }
  const problems = lockProblems(set);
  if (problems.length) {
    for (const p of problems) say(`不兼容：${p}`);
    say("protocol.ts 和这版 schema 对不上，锁文件没写；先改 protocol.ts");
    return 1;
  }
  writeLockSet(arg("--out") ?? FIXTURE_DIR, set);
  say(`已写入锁文件：codex-cli ${set.lock.cliVersion}，schemaFullSha256 ${set.lock.schemaFullSha256}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
