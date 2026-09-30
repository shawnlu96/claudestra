/**
 * doctor 的「API 源 / CC Switch」分区（台账 i02 的 A0，报告 docs/02-03-cc-switch.md 第 4 条）：
 *   - Claude Code 现在走哪个源：settings.json 的 env.ANTHROPIC_BASE_URL（有 = 第三方，只报主机名，密钥一律不读不报）
 *   - 终端里的 ANTHROPIC_* 环境变量会盖过 settings.json：两边不一致时 agent 实际用哪个不好说
 *   - 装了 CC Switch 时：它切换供应商会**整份重写** ~/.claude/settings.json，Claudestra 挂的 hooks 可能被冲掉
 * 只读、不联网。判定是纯函数 ccSwitchChecks（tests/doctor-ccswitch.test.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./doctor.js";

const GROUP = "API 源 / CC Switch";
const OVERRIDE_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export interface CcSwitchInputs {
  ccSwitchInstalled: boolean;
  /** ~/.claude/settings.json 解析结果；读不到 / 坏了 = null（typing hooks 那项会报） */
  settings: Record<string, unknown> | null;
  env: Record<string, string | undefined>;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60); // 不是合法 URL：原样截一段给人看
  }
};

export function ccSwitchChecks(i: CcSwitchInputs): Check[] {
  const out: Check[] = [];
  const env = (i.settings?.env ?? {}) as Record<string, unknown>;
  const base = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
  out.push({ group: GROUP, name: "Claude Code 的 API 源", status: "ok",
    detail: base ? `第三方：${hostOf(base)}（~/.claude/settings.json）` : "官方（claude.ai 账号登录，settings.json 没设 ANTHROPIC_BASE_URL）" });
  const shellVars = OVERRIDE_VARS.filter((k) => i.env[k]);
  if (shellVars.length) {
    out.push({ group: GROUP, name: "终端环境变量", status: "warn",
      detail: `终端里设了 ${shellVars.join(" / ")}，会盖过 settings.json——从这个终端起的 Claude Code 和 settings 里写的可能不是同一个源`,
      fix: "统一写进 ~/.claude/settings.json 的 env（或 CC Switch），再从 shell 配置里删掉这几个变量" });
  }
  if (!i.ccSwitchInstalled) return out;
  const hooks = JSON.stringify(i.settings?.hooks ?? {});
  const hooked = hooks.includes("typing-hook");
  out.push(hooked
    ? { group: GROUP, name: "CC Switch", status: "ok", detail: "装了 CC Switch；当前 settings.json 里 Claudestra 的 hooks 都在" }
    : { group: GROUP, name: "CC Switch", status: "warn",
        detail: "装了 CC Switch，settings.json 里没有 Claudestra 的 hooks——CC Switch 切换供应商会整份重写这个文件，多半是被冲掉了",
        fix: "在 CC Switch 的「通用配置片段」里放进 hooks 并对当前供应商勾选应用；或每次切换后重跑 bun src/manager.ts install-hooks" });
  return out;
}

export function checkCcSwitch(home = process.env.HOME || ""): Check[] {
  let settings: Record<string, unknown> | null = null;
  try {
    settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    settings = null; // 没有 / 写坏了：typing hooks 那项已经在报，这里按「没设第三方源」处理
  }
  return ccSwitchChecks({ ccSwitchInstalled: existsSync(join(home, ".cc-switch")), settings, env: process.env });
}

/** doctor 入口：本分区 + AI 能力清单一行（lib/ai-inventory-format.ts：装了哪些运行时、各自接官方还是第三方） */
export async function checkApiSources(): Promise<Check[]> {
  const { checkAiInventory } = await import("./ai-inventory-format.js");
  return [...checkCcSwitch(), ...(await checkAiInventory())];
}
