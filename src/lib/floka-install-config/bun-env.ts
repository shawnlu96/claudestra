/**
 * .env 改写前后的等价复核用真实 Bun 的加载口径（CRLF 规范化、引号、`$VAR` / `${VAR}` 展开、前向引用），
 * 不用本仓的简化解析器：插一条新名可能改变别的变量的展开结果，只有 Bun 自己说了算。
 * 子进程空环境、空临时目录作 cwd（不自动加载别的 .env、不读 bunfig），文件 0600（.env 里可能有凭据），用完即删。
 * 读不出来（不是 Bun 进程、子进程失败）返回 null，调用方按「无法确认」拒绝写入。tests/floka-install-config.test.ts。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function bunLoadedEnv(text: string): Record<string, string> | null {
  if (!process.versions.bun) return null;
  const dir = mkdtempSync(join(tmpdir(), "floka-installcfg-env-"));
  try {
    const file = join(dir, "probe.env");
    writeFileSync(file, text, { mode: 0o600 });
    const r = spawnSync(process.execPath, ["--config=/dev/null", `--env-file=${file}`, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: {}, cwd: dir, encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0) return null;
    const out = JSON.parse(r.stdout) as unknown;
    return out && typeof out === "object" ? out as Record<string, string> : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
