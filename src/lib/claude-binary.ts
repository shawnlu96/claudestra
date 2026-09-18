/**
 * v2.23.2+ Claude Code 二进制的「真身」定位 + quarantine 挂死修复配方。
 *
 * 背景（master 2026-09-18 报：2.1.258/259/267/274 连续四次复发，每次人肉救）：
 * brew cask 升级后的新二进制带 com.apple.quarantine，首次 exec 永久卡在 _dyld_start，
 * 所有新启动的 agent「启动超时」。launcher 本来有体检 + 自动修，但四次全没触发，根因是
 * **体检的不是 agent 跑的那个文件**：launchd 给 launcher 的 PATH 是
 * `~/.bun/bin:~/.local/bin:/opt/homebrew/bin…`，裸 `claude --version` 解析到原生安装器
 * 留下的 ~/.local/bin/claude（旧版 2.1.258，健康），于是「升级未生效」+ 体检通过，
 * 而 agent 在 tmux 登录 shell 里解析到 /opt/homebrew/bin/claude → 新的带 quarantine 的
 * 文件 → 挂死。所以这里一律按**登录 shell 的 PATH**（与 tmux 里的 agent 同一口径）
 * 定位，并且探测/修复都按绝对路径，不再让 launchd 的 PATH 说话。
 *
 * 修复配方是 master 实测的唯一有效路径：直接 `xattr -d` 或原地覆盖都无效——该路径的
 * vnode 已被内核/Gatekeeper 评估缓存钉住——必须 cp 出新文件名副本 → 副本 xattr -c →
 * 验证副本能跑 → rm 原文件 → mv 副本回原名（新 vnode）。执行器可注入，配方本身可单测。
 */
export interface ClaudeBinary {
  /** 登录 shell 里 `command -v claude` 的结果（通常是 /opt/homebrew/bin/claude 这个 symlink） */
  link: string;
  /** 解析 symlink 后的真实文件 */
  real: string;
}

export interface CmdResult {
  ok: boolean;
  out: string;
  err: string;
}
export type Runner = (cmd: string[], timeoutMs?: number) => Promise<CmdResult>;

/** 与 tmux 里 agent 同一口径：登录 shell 的 PATH 解析 `claude`，再 realpath。 */
export async function resolveClaudeBinary(run: Runner): Promise<ClaudeBinary | null> {
  const r = await run(["/bin/sh", "-lc", 'p="$(command -v claude)" && printf "%s\\n%s\\n" "$p" "$(realpath "$p")"'], 15_000);
  if (!r.ok) return null;
  const [link, real] = r.out.trim().split("\n");
  if (!link || !real) return null;
  return { link, real };
}

/** 按绝对路径探版本号；挂死（超时）/失败 → null。 */
export async function probeClaudeVersion(run: Runner, bin: string, timeoutMs = 20_000): Promise<string | null> {
  const r = await run([bin, "--version"], timeoutMs);
  if (!r.ok) return null;
  const m = r.out.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export interface DequarantineResult {
  ok: boolean;
  /** 依次执行到的步骤（日志/单测用） */
  steps: string[];
  error?: string;
}

/**
 * master 配方：cp 副本 → 副本 xattr -c → 验证副本 → rm 原文件 → mv 回原名 → 验证原名。
 * probe：给定路径能否在超时内跑通（调用方用 --version）。任何一步失败都不再尝试
 * 原地 xattr -d（实测无效），交给调用方告警。
 */
export async function dequarantineByReplace(
  real: string,
  run: Runner,
  probe: (bin: string) => Promise<boolean>,
): Promise<DequarantineResult> {
  const steps: string[] = [];
  const copy = `${real}.claudestra-new`;
  const fail = (error: string): DequarantineResult => ({ ok: false, steps, error });

  const cp = await run(["cp", "-p", real, copy], 120_000);
  steps.push("cp");
  if (!cp.ok) return fail(`cp 失败: ${cp.err || cp.out}`);

  const xa = await run(["xattr", "-c", copy], 20_000);
  steps.push("xattr -c");
  if (!xa.ok) {
    await run(["rm", "-f", copy], 20_000);
    return fail(`xattr -c 失败: ${xa.err || xa.out}`);
  }

  steps.push("probe copy");
  if (!(await probe(copy))) {
    await run(["rm", "-f", copy], 20_000);
    return fail("副本仍无法启动（不是 quarantine 问题，或 Gatekeeper 缓存按内容钉住）");
  }

  const rm = await run(["rm", "-f", real], 20_000);
  steps.push("rm original");
  if (!rm.ok) {
    await run(["rm", "-f", copy], 20_000);
    return fail(`rm 原文件失败: ${rm.err || rm.out}`);
  }

  const mv = await run(["mv", copy, real], 20_000);
  steps.push("mv back");
  if (!mv.ok) return fail(`mv 回原名失败（原文件已删，副本在 ${copy}）: ${mv.err || mv.out}`);

  steps.push("probe original");
  if (!(await probe(real))) return fail("替换后原路径仍无法启动");
  return { ok: true, steps };
}
