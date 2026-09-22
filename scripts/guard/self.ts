// 闸门自身防绕过（纯函数）。改一行 config 比写一条 raised[] 省事，所以：
// - scripts/guard/**（baseline.json 除外，它走数值放宽审计）相对比较基准有改动 → raised[] 里必须新增
//   {key: "guard:<path>", why ≥10 字}，比较基准里已有的记录不能复用；
// - package.json 的 guard/check 脚本、ci.yml 的 Guard 步骤（含严格模式）是硬接线，少了直接失败；
// - 严格模式（CI）下任何规则被跳过都算失败——依赖缺席时本地降级，CI 不降级。
import type { Raised } from "./types.ts";

const GUARD_DIR = "scripts/guard/";
export const BASELINE_REL = "scripts/guard/baseline.json";
const GUARD_SCRIPT = "bun scripts/guard/index.ts";
const MIN_WHY = 10;

export const isStrict = (env: Record<string, string | undefined>) => env.GUARD_STRICT === "1" || env.CI === "true";

/** 改动文件里属于闸门本身的那些。 */
export function guardSelfFiles(changed: string[]): string[] {
  return [...new Set(changed)].filter((f) => f.startsWith(GUARD_DIR) && f !== BASELINE_REL).sort();
}

const recordId = (r: Raised) => JSON.stringify([r.key, r.from, r.to, r.why, r.date ?? ""]);

/** 每个改过的闸门文件都要有一条比较基准里没有的 `guard:<path>` 记录；返回缺记录的文件。 */
export function checkSelfRaised(changedGuard: string[], baseRaised: Raised[], cur: Raised[]): string[] {
  const old = new Set(baseRaised.map(recordId));
  const fresh = cur.filter((r) => !old.has(recordId(r)) && [...(r.why ?? "").trim()].length >= MIN_WHY);
  return changedGuard.filter((f) => !fresh.some((r) => r.key === `guard:${f}`));
}

/** package.json / ci.yml 里把 guard 接进 check 与 CI 的那几行必须还在。 */
export function checkWiring(pkgText: string, ciText: string | null): string[] {
  const errs: string[] = [];
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(pkgText).scripts ?? {};
  } catch {
    errs.push("package.json 不是合法 JSON");
  }
  if (scripts.guard !== GUARD_SCRIPT) errs.push(`package.json 的 scripts.guard 必须是 "${GUARD_SCRIPT}"`);
  if (!/(^|&&\s*)bun run guard\s*($|&&)/.test(scripts.check ?? "")) {
    errs.push("package.json 的 scripts.check 必须包含 `&& bun run guard`");
  }
  if (ciText === null) return [...errs, ".github/workflows/ci.yml 不见了"];
  if (!/^\s*run:\s*bun run guard\s*$/m.test(ciText)) errs.push("ci.yml 缺少 `run: bun run guard` 这一步");
  if (!/^\s*GUARD_STRICT:\s*["']?1["']?\s*$/m.test(ciText)) errs.push('ci.yml 的 Guard 步骤缺少 `GUARD_STRICT: "1"`');
  return errs;
}
