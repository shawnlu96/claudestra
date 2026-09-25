/**
 * 非 Claude Code 运行时的模型 / 档位切换（从 api-routes 拆出来：那个文件只许变小）。
 * - Pi：GET /pi-models 读 ~/.pi/agent/models.json；POST /agents/:name/pi-settings 注入扩展命令
 * - Codex：GET /codex-models 读 `codex debug models`；POST /agents/:name/codex-settings 写 registry 后重启
 * Claude Code 的 /claude-settings 仍在 api-routes（与 permission-watcher 的代按逻辑缠在一起）。
 * runManager 由调用方注入：它在 management.ts（hub），bridge 模块不能反向 import。
 */
import { agentInScope, type Principal } from "../lib/principals.js";
import { readRegistryAgents } from "../lib/registry.js";
import { isPiThinkingLevel } from "../lib/pi-launch.js";
import { codexEffort } from "../lib/codex-launch.js";
import { codexDisplayDefaults, loadCodexCatalog, readCodexConfigDefaults, validateCodexChoice } from "../lib/codex-catalog.js";
import { apiJson, forbidden, isFullScope, readJsonBody, INVALID_JSON, invalidJsonBody, notInScope } from "./api-respond.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";
import { rememberSwitchOverride } from "./switch-override.js";
import { handlePiUpdate, PI_UPDATE_PATH } from "./pi-update.js";

type RunManager = (...args: string[]) => Promise<any>;

export async function handleRuntimeSettingsRoutes(
  req: Request,
  path: string,
  principal: Principal,
  runManager: RunManager,
): Promise<Response | null> {
  if (path === "/pi-models" && req.method === "GET") return piModels(principal);
  if (path === "/codex-models" && req.method === "GET") return codexModels(principal);
  if (PI_UPDATE_PATH.test(path) && req.method === "POST") return handlePiUpdate(path, principal, runManager); // 横幅「更新并重启」
  const set = path.match(/^\/agents\/([^/]+)\/(pi|codex)-settings$/);
  if (!set || req.method !== "POST") return null;
  const which = set[2] === "pi" ? "pi-settings" : "codex-settings";
  if (!isFullScope(principal)) return forbidden(`${which} requires a full-scope token`);
  const agentName = decodeURIComponent(set[1]);
  const canonical = agentName.startsWith("agent-") ? agentName : `agent-${agentName}`;
  if (!agentInScope(principal, canonical)) return notInScope(canonical);
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const model = String(body?.model || "").trim();
  const effort = String(body?.effort || "").trim();
  if (!model && !effort) return apiJson(400, { ok: false, error: 'body must be {"model"?,"effort"?}' });
  const reg = (await readRegistryAgents()).find((a) => a.name === canonical);
  if (!reg) return apiJson(404, { ok: false, error: `agent "${canonical}" not found` });
  if (reg.runtime !== set[2]) {
    return apiJson(400, { ok: false, error: `agent "${canonical}" 不是 ${set[2] === "pi" ? "Pi" : "Codex"} agent` });
  }
  return set[2] === "pi" ? piSettings(canonical, model, effort) : codexSettings(canonical, reg, model, effort, runManager);
}

// ── Pi ──────────────────────────────────────────────────────────────────────

/** Pi 的 models.json：providers[].models[] 摊平成 provider/id */
async function readPiModelIds(): Promise<Array<Record<string, unknown>>> {
  const raw = JSON.parse(await Bun.file(`${process.env.HOME}/.pi/agent/models.json`).text());
  const models: Array<Record<string, unknown>> = [];
  for (const [provider, cfg] of Object.entries<any>(raw?.providers ?? {})) {
    for (const m of cfg?.models ?? []) {
      models.push({
        id: `${provider}/${m.id}`,
        provider,
        name: m.name ?? m.id,
        input: Array.isArray(m.input) ? m.input : ["text"],
        images: Array.isArray(m.input) && m.input.includes("image"),
        thinking: m.reasoning === true,
        contextWindow: m.contextWindow ?? null,
      });
    }
  }
  return models;
}

/** GET /pi-models：与 /config/claude-defaults 分工——那个是 Claude Code 的全局默认，这个给 Pi 的选择器 */
async function piModels(principal: Principal): Promise<Response> {
  if (!isFullScope(principal)) return forbidden("pi-models requires a full-scope token");
  try {
    const models = await readPiModelIds();
    return apiJson(200, { ok: true, count: models.length, models });
  } catch (e) {
    return apiJson(500, { ok: false, error: `读取 models.json 失败: ${(e as Error).message}` });
  }
}

/**
 * Pi 的 `/model` 是**打开选择器**的交互语义，所以走扩展注册的确定性命令
 * `/claudestra-model <provider/id>`、`/claudestra-thinking <level>`（扩展内部直接调 setModel /
 * setThinkingLevel），注入方式与 Claude Code 相同：tmux send-keys。
 */
async function piSettings(canonical: string, model: string, effort: string): Promise<Response> {
  // effort 原样进 tmux send-keys -l：不校验 = 换行即可向 agent TUI 注入第二行任意输入
  if (effort && !isPiThinkingLevel(effort)) return apiJson(400, { ok: false, error: `未知的 thinking 档位：${effort}` });
  if (model && !/^[A-Za-z0-9._\/@:-]+$/.test(model)) return apiJson(400, { ok: false, error: "model 含非法字符" });
  // 模型 id 先对着 models.json 校验：扩展内部解析不到会拒绝，而这边的乐观显示没法知道注入的结果
  // ⇒ 假 id 会在顶栏显示一个根本不存在的模型（实测踩过）
  if (model) {
    try {
      const ids = new Set((await readPiModelIds()).map((m) => String(m.id)));
      if (ids.size && !ids.has(model)) return apiJson(400, { ok: false, error: `未知的 Pi 模型：${model}` });
    } catch { /* 读不到清单就不拦（扩展侧仍会拒绝） */ }
  }
  const { tmuxSendLine, windowTarget } = await import("../lib/tmux-helper.js");
  const target = windowTarget(canonical);
  try {
    if (model) await tmuxSendLine(target, `/claudestra-model ${model}`);
    if (effort) await tmuxSendLine(target, `/claudestra-thinking ${effort}`);
  } catch (e) {
    return apiJson(500, { ok: false, error: `注入失败: ${(e as Error).message}` });
  }
  rememberSwitchOverride(canonical, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  return apiJson(200, { ok: true, agent: canonical, model: model || null, effort: effort || null });
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** GET /codex-models：模型目录 + 本机默认（config.toml），给 Codex 的选择器渲染 */
async function codexModels(principal: Principal): Promise<Response> {
  if (!isFullScope(principal)) return forbidden("codex-models requires a full-scope token");
  const models = await loadCodexCatalog();
  if (!models) return apiJson(503, { ok: false, error: "读不到 Codex 模型目录（codex 没装或 `codex debug models` 失败）" });
  return apiJson(200, { ok: true, count: models.length, models, defaults: codexDisplayDefaults(models, readCodexConfigDefaults(), null) });
}

/**
 * Codex 没有能带参数的切换命令（TUI 的 /model 是选择器），所以切换 = 写 registry + 重启：
 * restart 用 `codex resume <id> -m <model> -c model_reasoning_effort=…` 接着原会话，上下文不丢
 * （重启只要几秒）。回合进行中不切——重启会打断正在跑的回合。
 */
async function codexSettings(
  canonical: string,
  reg: { model?: string; effort?: string },
  model: string,
  effortIn: string,
  runManager: RunManager,
): Promise<Response> {
  const catalog = await loadCodexCatalog();
  const targetModel = model || reg.model || codexDisplayDefaults(catalog, readCodexConfigDefaults(), null).model;
  let effort = effortIn;
  // 只换模型时，原来钉的档位新模型不一定支持（比如 ultra 换到 GPT-5.5）：换成新模型的默认档，免得重启失败
  const target = catalog?.find((m) => m.id === targetModel);
  let pinned: string | null = null;
  try {
    pinned = reg.effort ? codexEffort(reg.effort) : null;
  } catch {
    pinned = null; // registry 里是 Codex 不认的旧值：当没钉，交给下面的校验和新模型默认档
  }
  if (model && !effort && pinned && target && !target.efforts.includes(pinned)) effort = target.defaultEffort ?? "";
  const bad = validateCodexChoice(catalog, { model, effort, targetModel });
  if (bad) return apiJson(400, { ok: false, error: bad });
  if (isBusyStatus(getAgentStatus(canonical) ?? getAgentStatus(canonical.replace(/^agent-/, "")))) {
    return apiJson(409, { ok: false, error: "agent 正在回合中，等回合结束再切换" });
  }
  const setArgs = ["set-claude", canonical, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  const saved = await runManager(...setArgs);
  if (!saved?.ok) return apiJson(500, { ok: false, error: saved?.error || "写 registry 失败" });
  const restarted = await runManager("restart", canonical);
  if (!restarted?.ok) {
    return apiJson(500, { ok: false, error: `已记下新设置，但重启失败：${restarted?.error || "未知原因"}（可在管理面板手动重启）` });
  }
  rememberSwitchOverride(canonical, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  return apiJson(200, { ok: true, agent: canonical, model: model || null, effort: effort || null });
}
