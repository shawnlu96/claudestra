/**
 * 模型目录的拉取与缓存（不依赖 React，tests/web-claude-models.test.ts 直接测）。
 *
 * 服务端拿不到目录时会退回内置别名表，所以正常情况下永远非空；空只可能是这次请求
 * 失败了（bridge 正在重启 / 不可达）。失败要带原因、**不缓存**，下次调用重拉——
 * TopBar 的切换器整页只挂载一次，失败被缓存或不重拉，就会永远卡在「加载中…」。
 */
export type ClaudeModelOption = { value: string; label: string; section: string };
export type Catalog = { models: ClaudeModelOption[]; error: string | null };

// 整页共用一次请求（TopBar / 设置页 / 新建弹窗同时挂载时不重复拉）；只缓存成功结果
let pending: Promise<Catalog> | null = null;
let loaded: ClaudeModelOption[] | null = null;

/** 已成功拉到过的目录（没有则 null），给 hook 做初始值，避免已缓存时闪一下「加载中」。 */
export function cachedClaudeModels(): ClaudeModelOption[] | null {
  return loaded;
}

async function fetchCatalog(): Promise<Catalog> {
  try {
    const r = await fetch("/api/claude-models");
    const j = (await r.json().catch(() => ({}))) as { // 非 JSON（网关错误页）按空体处理，下面仍按状态码报错
      data?: { models?: Array<{ id: string; name: string; section: string }> };
      error?: string;
    };
    if (!r.ok) return { models: [], error: j.error || `HTTP ${r.status}` };
    const models = (j.data?.models ?? []).map((m) => ({ value: m.id, label: m.name, section: m.section }));
    return models.length ? { models, error: null } : { models, error: "empty catalog" };
  } catch (e) {
    return { models: [], error: (e as Error).message || "network error" };
  }
}

/** 拉目录：整页去重，只缓存成功结果。 */
export function loadClaudeModels(): Promise<Catalog> {
  if (loaded) return Promise.resolve({ models: loaded, error: null });
  pending ??= fetchCatalog().then((c) => {
    if (c.error) pending = null; // 失败不缓存，下次调用重拉
    else loaded = c.models;
    return c;
  });
  return pending;
}
