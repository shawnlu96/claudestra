/**
 * 可建 agent 的运行时清单（bridge GET /api/v1/runtimes 的返回体）。
 *
 * 新建 agent 的运行时下拉读它：available=false 的前端不显示（没装 codex 的人无感）。
 * available() 由各适配器自己缓存（Codex 5 分钟），这里不再加一层。hint 里可能带本机
 * 路径——端点只给全权 token，BFF 只往浏览器转 id / label / available / models / modelRequired。
 */
import { managedFor, manageableRuntimeIds } from "./index.js";
import { probeAcpCli } from "../acp/readiness.js";
import { opencodeModels } from "../opencode-models.js";

export interface RuntimeCatalogEntry {
  id: string;
  label: string;
  manageable: true;
  available: boolean;
  hint?: string;
  /** 运行时自己报的可用模型（目前只有 OpenCode），网页弹窗做成下拉 */
  models?: string[];
  /** 建 agent 必须给模型（ManagedRuntimeAdapter.modelRequired） */
  modelRequired?: boolean;
}

/** 按运行时取模型清单：没有这种来源的返回 undefined（弹窗照旧手填 / 用 CC 目录） */
const MODEL_LISTS: Record<string, () => Promise<string[]>> = { opencode: () => opencodeModels() };

export async function runtimeCatalog(): Promise<RuntimeCatalogEntry[]> {
  return Promise.all(
    manageableRuntimeIds().map(async (id) => {
      const a = managedFor(id)!;
      const acp = id === "codex" ? await probeAcpCli() : null;
      const r = acp?.ok ? { ok: true as const } : await a.available().catch((e) => ({ ok: false as const, hint: (e as Error).message }));
      const models = r.ok ? await MODEL_LISTS[id]?.() : undefined;
      return {
        id, label: a.label, manageable: true as const, available: r.ok, ...(r.ok ? {} : { hint: r.hint }),
        ...(models ? { models } : {}), ...(a.modelRequired ? { modelRequired: true } : {}),
      };
    }),
  );
}
