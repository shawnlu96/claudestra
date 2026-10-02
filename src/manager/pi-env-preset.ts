/**
 * `--pi-preset` / `pi-env-set --preset` 的解析与展开。
 *
 * 放在这里而不是 manager.ts：那个文件在 guard 的 baseline 大文件名单里，**只许缩不许涨**；
 * 新逻辑一律进 src/manager/ 下的模块，manager.ts 里只留一行调用（AGENTS.md 防腐规则 3）。
 */
import { piEnvPreset, piEnvPresetNames } from "../lib/pi-presets.js";
import type { PiEnvProfile } from "../lib/pi-env.js";
import { extractBoolFlag, extractMultiFlag, extractStringFlag } from "./core.js";

/** 未知预设的报错文案（两个入口共用，措辞保持一致） */
function unknownPreset(flag: string, name: string, extra = ""): string {
  return `未知的 ${flag}: "${name}"。可用: ${piEnvPresetNames().join(", ")}${extra}`;
}

/**
 * 新建 agent：`--pi-preset` 展开成档案，随后 `--pi-base` 覆盖它的 base（预设是默认，不是锁）。
 * 未知预设返回 error（调用方 output 后 return）。
 */
export function resolveCreatePiEnv(
  baseFlag?: string,
  presetFlag?: string,
): { piEnv?: PiEnvProfile } | { error: string } {
  if (baseFlag && baseFlag !== "minimal" && baseFlag !== "inherit") return { error: `未知的 --pi-base: "${baseFlag}"。可用: inherit, minimal` };
  let piEnv: PiEnvProfile | undefined;
  if (presetFlag) {
    const preset = piEnvPreset(presetFlag);
    if (!preset) return { error: unknownPreset("--pi-preset", presetFlag, "（先建再改: manager pi-env-set）") };
    piEnv = { ...preset };
  }
  if (baseFlag) piEnv = { ...(piEnv ?? {}), base: baseFlag as PiEnvProfile["base"] };
  return { piEnv };
}

/**
 * `pi-env-set`：预设先铺基底，调用方随后的 `--base` / `--add-ext` 覆盖它。未知预设返回 error。
 * 就地改 `next`（调用方已经把 registry 里现有档案归一化进来了）。
 */
export function applyPiEnvPreset(next: PiEnvProfile, presetName?: string): { error?: string } {
  if (!presetName) return {};
  const preset = piEnvPreset(presetName);
  if (!preset) return { error: unknownPreset("--preset", presetName) };
  if (preset.base) next.base = preset.base;
  if (preset.extensions?.length) {
    next.extensions = [...new Set([...(next.extensions ?? []), ...preset.extensions])];
  }
  return {};
}

/** `pi-env-set` 的旗标解析（同样为了不给 manager.ts 加行数） */
export function parsePiEnvSetFlags(args: string[]): {
  preset?: string;
  base?: string;
  mcpConfig?: string;
  addExt: string[];
  addSkill: string[];
  excludeTool: string[];
  trust?: boolean;
  reset?: boolean;
  rest: string[];
} {
  const p0 = extractStringFlag(args, "--preset");
  const a1 = extractStringFlag(p0.rest, "--base");
  const a2 = extractStringFlag(a1.rest, "--mcp-config");
  const a3 = extractMultiFlag(a2.rest, "--add-ext");
  const a4 = extractMultiFlag(a3.rest, "--add-skill");
  const a5 = extractMultiFlag(a4.rest, "--exclude-tool");
  const a6 = extractBoolFlag(a5.rest, "--no-trust");
  const a7 = extractBoolFlag(a6.rest, "--trust");
  const last = extractBoolFlag(a7.rest, "--reset");
  return {
    preset: p0.value,
    base: a1.value,
    mcpConfig: a2.value,
    addExt: a3.values,
    addSkill: a4.values,
    excludeTool: a5.values,
    trust: a6.value ? false : a7.value ? true : undefined,
    reset: last.value,
    rest: last.rest,
  };
}
