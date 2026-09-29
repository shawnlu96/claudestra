/**
 * ACP 会话配置项（session/new|load 的 configOptions、set_config_option 的返回、config_option_update）。
 * codex-acp 的 configId：mode / collaboration_mode / model / reasoning_effort（模型支持才有）/ fast-mode（同上）；
 * 都是 select，选项是平铺的 {value, name, description}。值不在选项里适配器回 -32602，所以先在这里挡。
 * 额度卡的选项也从这里来（owner 定的规矩：额度菜单不替他选、也不推荐）：第一个是「等重置」，后面只列 configOptions
 * 里的模型，当前模型不列（切过去等于没切）。tests/acp-config.test.ts。
 */

interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  currentValue: string;
  choices: ConfigChoice[];
}

const MODEL_CONFIG_ID = "model";
const EFFORT_CONFIG_ID = "reasoning_effort";

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "boolean" ? String(v) : "");

/** 原始 configOptions → 规整后的列表；认不出的项（不是 select、没有 id）跳过 */
export function parseConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !Array.isArray(o.options)) continue;
    const choices = (o.options as unknown[])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as any).value === "string")
      .map((c) => ({ value: c.value as string, name: str(c.name) || (c.value as string), ...(str(c.description) ? { description: str(c.description) } : {}) }));
    out.push({ id: o.id, name: str(o.name) || o.id, currentValue: str(o.currentValue), choices });
  }
  return out;
}

export function currentValueOf(opts: readonly ConfigOption[], id: string): string | undefined {
  return opts.find((o) => o.id === id)?.currentValue || undefined;
}

/** set_config_option 之前的本地校验：拒绝就返回给人看的原因，放行返回 null */
export function configRefusal(opts: readonly ConfigOption[], id: string, value: string): string | null {
  const o = opts.find((x) => x.id === id);
  if (!o) return `这个会话没有「${id}」这一项（可用：${opts.map((x) => x.id).join(", ") || "无"}）`;
  if (!o.choices.some((c) => c.value === value)) return `「${o.name}」没有 ${value} 这个选项（可选：${o.choices.map((c) => c.value).join(", ")}）`;
  return null;
}

/** 顶栏要的 model / effort（与 codex-session.ts codexStateRecord 的 model_state 同形；没有模型项返回 null） */
export function modelStateEntry(opts: readonly ConfigOption[], ts: string): Record<string, unknown> | null {
  const model = currentValueOf(opts, MODEL_CONFIG_ID);
  if (!model) return null;
  return { type: "system", subtype: "model_state", timestamp: ts, model, effort: currentValueOf(opts, EFFORT_CONFIG_ID) ?? null };
}

/** 额度卡的一个选项：value=null 是「等重置」，否则是 set_config_option(model, value) */
export interface QuotaChoice {
  value: string | null;
  label: string;
}

export function quotaCardChoices(opts: readonly ConfigOption[], resetHint?: string): QuotaChoice[] {
  const model = opts.find((o) => o.id === MODEL_CONFIG_ID);
  const wait: QuotaChoice = { value: null, label: resetHint ? `等重置（${resetHint}）` : "等重置" };
  if (!model) return [wait];
  const others = model.choices.filter((c) => c.value !== model.currentValue);
  return [wait, ...others.map((c) => ({ value: c.value, label: c.name === c.value ? `切到 ${c.value}` : `切到 ${c.name}（${c.value}）` }))];
}
