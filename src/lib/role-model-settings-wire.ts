/**
 * 角色模型档位在出借协议里的纯函数（TIER1b）：建议 / 实际的严格解析、带建议时的领单摘要、出借授权上限内的选档。
 * 不读文件、不碰台账：lend-wire.ts（A 收请求）与 lend-remote.ts（B 收应答）两边都用；带策略开关和落账的那一半在 role-model-settings-lend.ts。
 * 解析口径同出借协议其余部分：多字段、少字段、类型不对一律拒，不裁剪。tests/role-model-lend.test.ts。
 */
import { createHash } from "node:crypto";
import { CODEX_EFFORT_LEVELS } from "./codex-launch.js";
import { ACTUAL_SOURCES, SUGGEST_SOURCES, type LendFamily, type ModelActual, type ModelSuggest } from "./lend-wire-types.js";

/** 模型 id 会成为 --model 的参数值：小写字母数字、点、横线，首字符不能是 `-`（同 lend-config.ts CODEX_MODEL_RE） */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,56}$/;
const EFFORT = /^[a-z]{1,16}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isCodexLevel = (v: unknown): v is string => (CODEX_EFFORT_LEVELS as readonly unknown[]).includes(v);

/** 返回字符串 = 不合格的原因。只认 {model, source}（Claude 模型 id）或 {effort, source}（Codex 推理档 / null）两种形状，不能两样都带 */
export function parseModelSuggest(v: unknown): ModelSuggest | string {
  if (!isObj(v)) return "suggest 要是对象";
  if (!(SUGGEST_SOURCES as readonly unknown[]).includes(v.source)) return `suggest.source 只认 ${SUGGEST_SOURCES.join(" / ")}`;
  const source = v.source as ModelSuggest["source"];
  if (sameKeys(v, ["model", "source"])) return typeof v.model === "string" && CLAUDE_MODEL.test(v.model) ? { model: v.model, source } : "suggest.model 要是完整的 Claude 模型 id";
  if (sameKeys(v, ["effort", "source"])) return v.effort === null || isCodexLevel(v.effort) ? { effort: v.effort, source } : `suggest.effort 只认 null 或 ${CODEX_EFFORT_LEVELS.join(" / ")}`;
  return "suggest 只能是 { model, source } 或 { effort, source }";
}

/** 建议要和订单家族对得上：codex 单只收推理档，claude 单只收模型；null = 对得上 */
export function suggestFamilyProblem(family: string, s: ModelSuggest | null | undefined): string | null {
  if (!s) return null;
  if (family === "codex") return "effort" in s ? null : "codex 单的建议带了模型名";
  return family === "claude" && "model" in s ? null : `${family} 单的建议不是模型`;
}

export function parseModelActual(v: unknown): ModelActual | string {
  if (!isObj(v) || !sameKeys(v, ["model", "effort", "source"])) return "actual 只能是 { model, effort, source }";
  if (v.model !== null && !(typeof v.model === "string" && MODEL_ID.test(v.model))) return "actual.model 要是 null 或模型 id";
  if (v.effort !== null && !(typeof v.effort === "string" && EFFORT.test(v.effort))) return "actual.effort 要是 null 或档位名";
  if (!(ACTUAL_SOURCES as readonly unknown[]).includes(v.source)) return `actual.source 只认 ${ACTUAL_SOURCES.join(" / ")}`;
  return { model: v.model as string | null, effort: v.effort as string | null, source: v.source as ModelActual["source"] };
}

/** 对方报的实际要和这一单的家族对得上：codex 单只出现推理档（不带模型名），档位得是 Codex 的档；null = 对得上 */
export function actualFamilyProblem(family: LendFamily, a: ModelActual): string | null {
  if (family !== "codex") return null;
  if (a.model !== null) return "codex 单的 actual 不带模型名";
  return a.effort === null || isCodexLevel(a.effort) ? null : "codex 单的 actual.effort 不是 Codex 的推理档";
}

const canon = (s: ModelSuggest): string => JSON.stringify("model" in s ? ["model", s.model, s.source] : ["effort", s.effort, s.source]);
/** 带建议的领单摘要：派单全文 + 建议的定序串一起算，改了建议（或拿掉它）摘要就对不上；不带建议的摘要仍是全文的 sha256，不经这里 */
export const suggestDigest = (text: string, s: ModelSuggest): string => createHash("sha256").update(`${text}\nsuggest:${canon(s)}`, "utf8").digest("hex");

/** A 的 claim 应答：没有建议 = 原样（逐字节不变）；有 = 摘要换成带建议的那一个，再附 suggest */
export const withSuggest = <T extends { text: string; sha256: string }>(claimed: T, s: ModelSuggest | null): T | (T & { suggest: ModelSuggest }) =>
  s ? { ...claimed, sha256: suggestDigest(claimed.text, s), suggest: s } : claimed;

export interface GrantPick { use: string | null; source: ModelActual["source"]; diagnostic?: string }

/**
 * 出借授权是上限：建议的一档在对方明确开放的（opened）里就用它；不在，就取开放的里按 ranking 排最接近的一档（一样近取低的）。
 * opened / ranking 读不到（null）、对方没开放任何一档、或建议 / 开放的档在 ranking 里排不出位置 = 用对方原默认（use: null）并给诊断，不猜、不放宽。
 */
export function withinGrant(suggested: string | null, opened: readonly string[] | null, ranking: readonly string[] | null): GrantPick {
  if (suggested === null) return { use: null, source: "default" };
  if (opened === null) return { use: null, source: "default", diagnostic: `读不到对方的出借授权，建议的 ${suggested} 不用，照对方原默认` };
  if (opened.includes(suggested)) return { use: suggested, source: "suggest" };
  if (!opened.length) return { use: null, source: "default", diagnostic: `对方授权没有开放可选的档，建议的 ${suggested} 不用，照对方原默认` };
  const at = ranking ? ranking.indexOf(suggested) : -1;
  const ranked = (ranking ? opened.map((o) => ({ o, i: ranking.indexOf(o) })) : []).filter((x) => x.i >= 0);
  if (at < 0 || !ranked.length) return { use: null, source: "default", diagnostic: `核不出 ${suggested} 与对方开放档（${opened.join(" / ")}）的排序，照对方原默认` };
  const best = ranked.sort((a, b) => Math.abs(a.i - at) - Math.abs(b.i - at) || a.i - b.i)[0]!;
  return { use: best.o, source: "grant", diagnostic: `建议的 ${suggested} 对方没开放，用已开放里最接近的 ${best.o}` };
}

const argAfter = (args: readonly string[], flag: string): string | null => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1]! : null; };

/**
 * 起出借 worker 那一刻的实际（B）：args 是这次真正带给 manager create 的 --model / --effort（lend-grant-spawn.ts lendModelArgs：授权，
 * 或 TIER3b 在授权内接受的建议）。codex 只报推理档；claude 带了 --model 报它，没带是对方原默认。
 */
export function launchActual(family: string, suggest: ModelSuggest | null | undefined, args: readonly string[]): { actual: ModelActual; diagnostic?: string } {
  if (family !== "codex") {
    const want = suggest && "model" in suggest ? suggest.model : null;
    // TIER3b：出借方接受了授权内的建议（task-tier-lend.ts）时 create 带 --model，实际就是它
    const used = argAfter(args, "--model");
    if (used) return { actual: { model: used, effort: null, source: used === want ? "suggest" : "grant" } };
    return { actual: { model: null, effort: null, source: "default" }, ...(want ? { diagnostic: `出借授权没有开放 Claude 模型选择，建议的 ${want} 不用，照对方原默认` } : {}) };
  }
  const effort = argAfter(args, "--effort");
  const pick = withinGrant(suggest && "effort" in suggest ? suggest.effort : null, effort ? [effort] : [], CODEX_EFFORT_LEVELS);
  const source = pick.use !== null ? pick.source : effort || argAfter(args, "--model") ? "grant" : "default";
  return { actual: { model: null, effort, source }, ...(pick.diagnostic ? { diagnostic: pick.diagnostic } : {}) };
}
