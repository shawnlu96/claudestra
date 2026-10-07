/**
 * 适配器的启动配置与会话配置项：
 * - 环境（B13、B15、B38）：CODEX_PATH 必填；INITIAL_AGENT_MODE 只认 4 个名字，认不出就拒起（不降级）；CODEX_CONFIG 必须是 JSON 对象。
 *   任何一条不过，initialize 回 -32603 带 data.fatal（宿主固定一张卡、不再重起）。
 * - 线程的 config 覆盖层：和 2.1.0 一样加 projects.<cwd>.trust_level、features.cwd_relative_turn_diffs=false；
 *   另把控制标记写进覆盖层里每个 MCP server 自己的 env（I12：只有 MCP 进程带它，模型跑的命令继承不到）。
 * - configOptions 只给 model 和 reasoning_effort（B40–B42），改了从下一次 turn/start 生效。
 * tests/codex-adapter-session.test.ts。
 */
import type { ResultOf } from "./protocol.js";

type Rec = Record<string, unknown>;
type Model = ResultOf<"model/list">["data"][number];

const WORKSPACE = { type: "workspaceWrite" as const, writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
/** 2.1.0 AgentMode.ts 的四个预设；每次 turn/start 都带上 */
const MODES = {
  "read-only": { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false } },
  "workspace-write": { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: WORKSPACE },
  agent: { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: WORKSPACE },
  "agent-full-access": { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
} as const;
type TurnPolicy = (typeof MODES)[keyof typeof MODES];

export interface AdapterConfig {
  codexPath: string;
  policy: TurnPolicy;
  /** CODEX_CONFIG 原样（没设是 {}） */
  overlay: Rec;
}

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** 不设 INITIAL_AGENT_MODE 时和 2.1.0 一样用 agent；设了就必须是四个之一 */
export function parseAdapterEnv(env: Record<string, string | undefined>): { ok: true; cfg: AdapterConfig } | { ok: false; why: string } {
  const codexPath = env.CODEX_PATH?.trim();
  if (!codexPath) return { ok: false, why: "没有设 CODEX_PATH，不知道用哪个 codex" };
  const mode = env.INITIAL_AGENT_MODE || "agent";
  if (!Object.hasOwn(MODES, mode)) return { ok: false, why: `INITIAL_AGENT_MODE=${mode} 认不出（只认 ${Object.keys(MODES).join(" / ")}），不降级` };
  let overlay: unknown = {};
  try {
    overlay = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {};
  } catch (e) {
    return { ok: false, why: `CODEX_CONFIG 不是合法 JSON（${e instanceof Error ? e.message : e}）` };
  }
  if (!isRec(overlay)) return { ok: false, why: "CODEX_CONFIG 必须是 JSON 对象" };
  return { ok: true, cfg: { codexPath, policy: MODES[mode as keyof typeof MODES], overlay } };
}

/** thread/start|resume|fork 的 config。mark = [变量名, 值]：写进每个 MCP server 自己的 env（定向注入，不进公共环境） */
export function threadConfig(overlay: Rec, cwd: string, mark?: [string, string]): Rec {
  const features = isRec(overlay.features) ? overlay.features : {};
  const out: Rec = { ...overlay, features: { ...features, cwd_relative_turn_diffs: false }, projects: { [cwd]: { trust_level: "trusted" } } };
  if (mark && isRec(overlay.mcp_servers)) {
    const servers = Object.entries(overlay.mcp_servers).map(([name, s]) => {
      const srv = isRec(s) ? s : {};
      return [name, { ...srv, env: { ...(isRec(srv.env) ? srv.env : {}), [mark[0]]: mark[1] } }];
    });
    out.mcp_servers = Object.fromEntries(servers);
  }
  return out;
}

/** 当前模型 / 推理强度和模型目录（读完所有分页） */
export interface ModelState {
  models: Model[];
  model: string;
  effort: string | null;
}

/** 2.1.0 createModelId：目录里有就用（强度缺省取模型默认值）；目录里没有（自定义 provider）照样用它，强度缺省 medium */
export function modelStateOf(models: Model[], model: string, effort: string | null | undefined): ModelState {
  const hit = models.find((m) => m.id === model);
  return { models, model, effort: effort ?? (hit ? hit.defaultReasoningEffort : "medium") };
}

const efforts = (st: ModelState) => st.models.find((m) => m.id === st.model)?.supportedReasoningEfforts ?? [];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** model 永远有（当前模型不在目录里也列进来，B42）；当前模型声明了强度才有 reasoning_effort */
export function configOptions(st: ModelState): Rec[] {
  const choices = st.models.map((m) => ({ value: m.id, name: m.displayName }));
  if (!st.models.some((m) => m.id === st.model)) choices.unshift({ value: st.model, name: st.model });
  const out: Rec[] = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: st.model, options: choices }];
  const list = efforts(st);
  if (list.length && st.effort) {
    const options = list.map((e) => ({ value: e.reasoningEffort, name: cap(e.reasoningEffort) }));
    out.push({ id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: st.effort, options });
  }
  return out;
}

/** set_config_option：值不在选项里返回原因（回 -32602）。换模型时强度不受新模型支持就换成它的默认强度 */
export function applyConfig(st: ModelState, configId: unknown, value: unknown): ModelState | string {
  const opt = configOptions(st).find((o) => o.id === configId);
  if (!opt) return `没有配置项「${String(configId)}」（只有 model / reasoning_effort）`;
  if (typeof value !== "string" || !(opt.options as { value: string }[]).some((c) => c.value === value)) return `「${String(configId)}」没有 ${String(value)} 这个选项`;
  if (configId === "reasoning_effort") return { ...st, effort: value };
  const next = { ...st, model: value };
  const supported = efforts(next).map((e) => e.reasoningEffort);
  const keep = st.effort && supported.includes(st.effort) ? st.effort : (st.models.find((m) => m.id === value)?.defaultReasoningEffort ?? st.effort);
  return { ...next, effort: keep };
}
