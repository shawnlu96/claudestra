/**
 * `manager create` 的 argv 解析（从 manager.ts create 分支搬出，单测见 tests/manager-create-args.test.ts）。
 * ⚠ --purpose 必须第一个抽：它的值是自由文本（web 经 POST /api/v1/agents 传进来），排在别的 flag 提取后面时，
 * `{"purpose":"--parent=master"}` / `--external` / `--model=x` 会先被当成 flag 吃掉（core.ts extractPurposeFlag 注释）。
 */
import {
  extractBoolFlag, extractEffortFlag, extractModeFlag, extractModelFlag, extractPermFlags, extractPurposeFlag, extractStringFlag, rejectFlagLikePositional,
} from "./core.js";
import { extractTeamFlags, type TeamFlags } from "./team.js";

export const CREATE_USAGE =
  'create <name> <dir> [purpose|--purpose <text>] [--project <id>] [--runtime claude-code|pi] [--pi-base inherit|minimal] [--preset <preset>] ' +
  '[--disallowed "..."] [--effort <level>] [--mode <permission-mode>] [--model <model>] [--external] [--parent <agent|master|none>] [--task "<text>"]';

export interface CreateArgs {
  name: string;
  dir: string;
  purpose: string;
  perms: { preset?: string; disallowedRaw?: string };
  effort?: string;
  mode?: string;
  model?: string;
  external: boolean;
  projectFlag?: string;
  runtimeFlag?: string;
  /** T60：--transport acp（只有 codex 支持，缺省 tmux） */
  transportFlag?: string;
  piBaseFlag?: string;
  /** --pi-preset <name>：能力档案预设（如 codemode），比手拼 base+extensions 省事 */
  piPresetFlag?: string;
  teamFlags: TeamFlags;
}

export function parseCreateArgs(args: string[]): CreateArgs | { error: string } {
  const { rest: afterPurpose, purpose: purposeFlag } = extractPurposeFlag(args);
  // v2.21+ --project <id>(也接受 --project=id):显式指定归属 project
  let projectFlag: string | undefined;
  const afterProject: string[] = [];
  for (let i = 0; i < afterPurpose.length; i++) {
    const a = afterPurpose[i];
    if (a === "--project") projectFlag = afterPurpose[++i] || undefined;
    else if (a.startsWith("--project=")) projectFlag = a.slice("--project=".length) || undefined;
    else afterProject.push(a);
  }
  const { rest: afterTeam, flags: teamFlags, error: teamError } = extractTeamFlags(afterProject); // --parent / --task（manager/team.ts）
  if (teamError) return { error: teamError };
  const { rest: afterExternal, value: external } = extractBoolFlag(afterTeam, "--external");
  const { rest: afterRuntime, value: runtimeFlag } = extractStringFlag(afterExternal, "--runtime");
  const { rest: afterTransport, value: transportFlag } = extractStringFlag(afterRuntime, "--transport");
  if (transportFlag && transportFlag !== "acp" && transportFlag !== "tmux") return { error: `--transport 只能是 tmux 或 acp（收到 ${transportFlag}）` };
  const { rest: afterPiBase, value: piBaseFlag } = extractStringFlag(afterTransport, "--pi-base");
  const { rest: afterPiPreset, value: piPresetFlag } = extractStringFlag(afterPiBase, "--pi-preset");
  const { rest: afterModel, model } = extractModelFlag(afterPiPreset);
  const { rest: afterMode, mode } = extractModeFlag(afterModel);
  const { rest: afterEffort, effort } = extractEffortFlag(afterMode);
  const { rest: posArgs, preset, disallowedRaw } = extractPermFlags(afterEffort);
  const [name, dir, ...purposeParts] = posArgs;
  const flagLike = rejectFlagLikePositional(name, dir);
  if (flagLike) return { error: flagLike };
  if (!name || !dir) return { error: CREATE_USAGE };
  return {
    name, dir, purpose: purposeFlag ?? purposeParts.join(" "), perms: { preset, disallowedRaw }, effort, mode, model, external, projectFlag, runtimeFlag, transportFlag, piBaseFlag, piPresetFlag, teamFlags,
  };
}
