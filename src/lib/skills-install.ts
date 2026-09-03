/**
 * v2.21.3+ 仓库自带 skill(`<repo>/skills/<name>/SKILL.md`)→ `~/.claude/skills/<name>`
 * 的安装/体检。
 *
 * 背景(owner 2026-09-03):save-compact 一直在仓库里,但**没有任何东西把它装进
 * ~/.claude/skills**——本机是某次手工建的硬链接;MacBook 是指向仓库路径的软链,
 * 而那台的仓库停在 v2.5.3(skills/ 目录还不存在),软链一直是悬空的,那台从来没有
 * 过 save-compact。仓库里改 skill 对用户零效果,除非有这一步。
 *
 * 策略:软链(仓库更新即生效,不用再同步)。对已有的目标只做安全动作:
 *   - 缺失 / 悬空软链 / 指向本仓库的软链 → 建/重建/保留
 *   - 指向别处且存在的软链 → 不动,warn(可能是另一份 clone,用户自己的选择)
 *   - 真目录:内容与仓库一致(硬链接或复制) → ok;不一致 → warn 不覆盖
 *     (删用户目录是破坏性操作,只提示)
 * 纯文件系统操作,不碰 git,单测在 tests/skills-install.test.ts。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, mkdirSync, symlinkSync, unlinkSync, realpathSync } from "fs";
import { join, resolve } from "path";

export type SkillInstallAction = "linked" | "relinked" | "ok" | "warn";

export interface SkillInstallResult {
  name: string;
  action: SkillInstallAction;
  detail: string;
}

/** 仓库里可安装的 skill 名(有 SKILL.md 的子目录)。 */
export function listRepoSkills(repoRoot: string): string[] {
  const dir = join(repoRoot, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && existsSync(join(dir, n, "SKILL.md")))
    .sort();
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * 装/体检一个 skill。`apply=false` 只报告不动文件(doctor 用)。
 * `home` 可注入(单测);目标目录 `<home>/.claude/skills/<name>`。
 */
export function installRepoSkill(
  repoRoot: string,
  name: string,
  opts: { home?: string; apply?: boolean } = {},
): SkillInstallResult {
  const home = opts.home ?? process.env.HOME ?? "";
  const apply = opts.apply ?? true;
  const src = resolve(join(repoRoot, "skills", name));
  const skillsDir = join(home, ".claude", "skills");
  const dst = join(skillsDir, name);

  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(dst);
  } catch {
    st = null;
  }

  if (!st) {
    if (!apply) return { name, action: "warn", detail: "未安装(~/.claude/skills 里没有)" };
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(src, dst);
    return { name, action: "linked", detail: `软链 → ${src}` };
  }

  if (st.isSymbolicLink()) {
    const target = readlinkSync(dst);
    const targetExists = existsSync(dst); // existsSync 会跟随软链:false = 悬空
    if (targetExists && sameRealPath(dst, src)) {
      return { name, action: "ok", detail: `软链 → ${src}` };
    }
    if (!targetExists) {
      if (!apply) return { name, action: "warn", detail: `悬空软链 → ${target}` };
      unlinkSync(dst);
      symlinkSync(src, dst);
      return { name, action: "relinked", detail: `悬空软链(→ ${target})已重指向 ${src}` };
    }
    return { name, action: "warn", detail: `软链指向别处:${target}(不动;要用本仓库的就删掉它再重跑)` };
  }

  // 真目录 / 真文件:比对 SKILL.md 内容(硬链接/复制都走这里)
  try {
    const mine = readFileSync(join(src, "SKILL.md"), "utf8");
    const theirs = readFileSync(join(dst, "SKILL.md"), "utf8");
    if (mine === theirs) return { name, action: "ok", detail: "本地副本与仓库一致(非软链)" };
    return { name, action: "warn", detail: "本地副本与仓库不一致(非软链,不覆盖);要跟仓库走就删掉它再重跑" };
  } catch {
    return { name, action: "warn", detail: "目标存在但不是 skill 目录(不动)" };
  }
}

/** 装/体检仓库全部 skill。 */
export function installRepoSkills(
  repoRoot: string,
  opts: { home?: string; apply?: boolean } = {},
): SkillInstallResult[] {
  return listRepoSkills(repoRoot).map((n) => installRepoSkill(repoRoot, n, opts));
}
