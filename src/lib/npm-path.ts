/**
 * 在 launchd 阉割版 PATH 下解析 npm 绝对路径。
 *
 * launchd daemon 的 plist PATH（bridge / launcher / cron）不含 nvm 目录——只有
 * `com.claudestra.web` 的 plist 特意补了 node 路径。任何从这些 daemon 里
 * `Bun.spawn(["npm", ...])` 的地方都会 ENOENT，而 stdout/stderr 若被 ignore
 * 就是静默失败：v2.17.2 web 构建（manager e11500e）、CC 自动更新检查
 * （launcher，peer 2026-08-09）先后踩过同一个坑。收敛到这个共享解析器，
 * 「同一个坑第三次踩」不再是必然。
 *
 * 解析顺序：当前进程 PATH 的 `which npm` → nvm 最新版本 → homebrew → /usr/local。
 * 返回 npm 绝对路径与其 bin 目录（npm scripts 里要能找到 node，调用方把 binDir
 * 补进子进程 PATH）。找不到返回 null。
 */

import { readdirSync, existsSync } from "fs";

/** 版本目录名（"v20.19.6" / "20.19.6"）按语义数值降序——字典序会把 v9 排在
 *  v10 前（'9' > '1'）、v100 排在 v20 后，选到过时的 node（peer 2026-08-09 指出）。 */
export function sortNodeVersionsDesc(dirs: string[]): string[] {
  const parse = (s: string) =>
    s.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  return [...dirs].sort((a, b) => {
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}

export function resolveNpm(): { npm: string; binDir: string } | null {
  // 当前 PATH 能找到就直接用（前台/被正确 PATH 的进程调用时的快路径）
  const w = Bun.spawnSync(["/usr/bin/which", "npm"], { env: process.env as Record<string, string> });
  const hit = w.exitCode === 0 ? w.stdout.toString().trim() : "";
  if (hit) return { npm: hit, binDir: hit.replace(/\/npm$/, "") };

  const home = process.env.HOME || "";
  const candidates: string[] = [];
  try {
    const nvmDir = `${home}/.nvm/versions/node`;
    for (const v of sortNodeVersionsDesc(readdirSync(nvmDir))) {
      candidates.push(`${nvmDir}/${v}/bin/npm`);
    }
  } catch { /* 无 nvm */ }
  candidates.push("/opt/homebrew/bin/npm", "/usr/local/bin/npm", `${home}/.local/bin/npm`);
  for (const c of candidates) {
    if (existsSync(c)) return { npm: c, binDir: c.replace(/\/npm$/, "") };
  }
  return null;
}
