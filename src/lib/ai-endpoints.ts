/**
 * 各运行时「接口指向哪家」的判定（T91 AI 能力清单；tests/ai-endpoints.test.ts）。
 * 输入是已解析好的配置对象，只从中挑 model / provider / base_url 这几类字段；凭据字段（*_API_KEY、AUTH_TOKEN、
 * http_headers、bearer、apiKey）不读不报，auth.json / Keychain / .env 根本不打开。
 * 多个来源冲突时只要有一个不是官方就判第三方并列出全部来源：Claude Code 在 settings 与终端 env 之间谁盖谁
 * 随启动方式而变，报成官方而实际走了第三方是这份清单唯一不能犯的错。
 */

type EndpointKind = "official" | "third_party" | "unknown";

interface EndpointSource {
  /** 这条线索的出处：「~/.claude/settings.json env」「当前进程 env」「config.toml model_providers.x」… */
  from: string;
  kind: EndpointKind;
  /** 脱敏后的地址（去掉账号口令、query、fragment，长得像 key 的路径段打码）；没设 / 解析不了 = null */
  baseUrl: string | null;
  host: string | null;
  note?: string;
}

export interface EndpointVerdict {
  kind: EndpointKind;
  /** 第三方的主机名（多个第三方来源时取第一个）；官方 / 未知为 null */
  host: string | null;
  provider: string | null;
  sources: EndpointSource[];
  /** 来源之间判定不一致 */
  conflict: boolean;
  /** 配置里写的模型（键 = 出处字段名） */
  models: Record<string, string>;
  note?: string;
}

// ── base_url 脱敏 ─────────────────────────────────────────────────────────

/** 路径段像密钥：sk- / key- 之类前缀，或 ≥ 24 位且字母数字混排的随机串 */
const looksSecret = (raw: string) => {
  let seg = raw;
  try { seg = decodeURIComponent(raw); } catch { /* 坏的 % 转义：按原样判断，照样可能打码 */ }
  return /^(sk|ak|key|pk|token)[-_]/i.test(seg) || (seg.length >= 24 && /[a-z]/i.test(seg) && /\d/.test(seg));
};

/**
 * 只留 协议 + 主机[:端口] + 路径：URL 重拼时账号口令自然丢掉，query / fragment 整段不要（key 常挂在 ?key=）。
 * 解析不了返回 null——不能像 doctor 那样截原文给人看，原文里可能就有 key。
 */
export function sanitizeBaseUrl(raw: unknown): { baseUrl: string; host: string; protocol: string; port: string } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; } // 不是合法 URL：调用方记「解析不了」，不输出原文
  if (!u.hostname) return null;
  const path = u.pathname.split("/").map((s) => (looksSecret(s) ? "***" : s)).join("/").replace(/\/+$/, "");
  return { baseUrl: `${u.protocol}//${u.host}${path}`, host: u.host.toLowerCase(), protocol: u.protocol, port: u.port };
}

/** 官方 = https、主机名严格等于官方域名、默认端口；其余一律第三方（含 http、自定义端口、子域名伪装） */
function urlSource(from: string, raw: unknown, officialHosts: readonly string[]): EndpointSource {
  const s = sanitizeBaseUrl(raw);
  if (!s) return { from, kind: "unknown", baseUrl: null, host: null, note: "地址解析不了（不输出原文）" };
  const official = s.protocol === "https:" && !s.port && officialHosts.includes(s.host);
  return { from, kind: official ? "official" : "third_party", baseUrl: s.baseUrl, host: s.host };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const truthy = (v: unknown) => typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim());

/** 来源合并：任一第三方 → 第三方；否则任一未知 → 未知；全官方（或没有任何线索时的缺省官方）→ 官方 */
function merge(provider: string | null, sources: EndpointSource[], models: Record<string, string>, fallback: EndpointKind, note?: string): EndpointVerdict {
  const third = sources.find((s) => s.kind === "third_party");
  const kind: EndpointKind = third ? "third_party" : sources.some((s) => s.kind === "unknown") ? "unknown" : sources.length ? "official" : fallback;
  const kinds = new Set(sources.map((s) => s.kind));
  return { kind, host: third?.host ?? null, provider, sources, conflict: kinds.size > 1, models, ...(note ? { note } : {}) };
}

// ── Claude Code ──────────────────────────────────────────────────────────

const ANTHROPIC_OFFICIAL_HOSTS = ["api.anthropic.com"] as const;

const CLAUDE_MODEL_VARS = [
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;
/** 走云厂商托管的开关：不是 Anthropic 官方接口，报第三方并写明哪家 */
const CLAUDE_CLOUD = [
  { flag: "CLAUDE_CODE_USE_BEDROCK", url: "ANTHROPIC_BEDROCK_BASE_URL", name: "Amazon Bedrock" },
  { flag: "CLAUDE_CODE_USE_VERTEX", url: "ANTHROPIC_VERTEX_BASE_URL", name: "Google Vertex AI" },
  { flag: "CLAUDE_CODE_USE_FOUNDRY", url: "ANTHROPIC_FOUNDRY_BASE_URL", name: "Microsoft Foundry" },
] as const;

/** 判定用到的全部键：读配置时只把这些键拷进 layer，token / key 类字段从一开始就不进来 */
const CLAUDE_ENDPOINT_KEYS: readonly string[] = ["ANTHROPIC_BASE_URL", ...CLAUDE_MODEL_VARS, ...CLAUDE_CLOUD.flatMap((c) => [c.flag, c.url])];

/** 只留判定用的键 */
export function pickClaudeKeys(env: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CLAUDE_ENDPOINT_KEYS) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

export interface ClaudeConfigLayer {
  /** 出处名 */
  from: string;
  /** 这一层的键值（settings.json 的 env 块，或进程 env）；null = 文件在但解析不了 */
  env: Record<string, unknown> | null;
  /** settings.json 顶层 model（进程 env 层没有） */
  model?: unknown;
}

function claudeLayerSources(l: ClaudeConfigLayer): EndpointSource[] {
  if (l.env === null) return [{ from: l.from, kind: "unknown", baseUrl: null, host: null, note: "文件解析不了，里面写的源无从得知" }];
  const out: EndpointSource[] = [];
  for (const c of CLAUDE_CLOUD) {
    if (!truthy(l.env[c.flag])) continue;
    const s = str(l.env[c.url]) ? urlSource(`${l.from} ${c.url}`, l.env[c.url], []) : null;
    out.push({ from: `${l.from} ${c.flag}`, kind: "third_party", baseUrl: s?.baseUrl ?? null, host: s?.host ?? c.name, note: c.name });
  }
  if (l.env.ANTHROPIC_BASE_URL !== undefined) out.push(urlSource(`${l.from} ANTHROPIC_BASE_URL`, l.env.ANTHROPIC_BASE_URL, ANTHROPIC_OFFICIAL_HOSTS));
  return out;
}

/** layers 按优先级从高到低；没有任何线索 = 官方缺省（claude.ai 账号登录直连 api.anthropic.com） */
export function classifyClaudeEndpoint(layers: ClaudeConfigLayer[]): EndpointVerdict {
  const sources = layers.flatMap(claudeLayerSources);
  const models: Record<string, string> = {};
  for (const l of layers) {
    const m = str(l.model);
    if (m && !models[`${l.from} model`]) models[`${l.from} model`] = m;
    for (const k of CLAUDE_MODEL_VARS) {
      const v = l.env ? str(l.env[k]) : null;
      if (v) models[`${l.from} ${k}`] = v;
    }
  }
  const cloud = CLAUDE_CLOUD.find((c) => layers.some((l) => l.env && truthy(l.env[c.flag])));
  return merge(cloud?.name ?? "anthropic", sources, models, "official");
}

// ── Codex ────────────────────────────────────────────────────────────────

const OPENAI_OFFICIAL_HOSTS = ["api.openai.com", "chatgpt.com"] as const;
/** Codex 内置的本地模型 provider（没在 model_providers 里定义也能用） */
const CODEX_LOCAL_BUILTINS: Record<string, string> = { oss: "localhost:11434", ollama: "localhost:11434", lmstudio: "localhost:1234" };

/**
 * toml = config.toml 解析结果；null = 文件在但解析不了；undefined = 没有这个文件（Codex 缺省走 OpenAI 官方）。
 * 只挑 profile / model / model_provider / openai_base_url 与 model_providers.<id>.base_url|name。
 */
export function classifyCodexEndpoint(toml: Record<string, unknown> | null | undefined, env: Record<string, string | undefined>): EndpointVerdict {
  if (toml === null) return merge(null, [{ from: "config.toml", kind: "unknown", baseUrl: null, host: null, note: "文件解析不了" }], {}, "unknown");
  const root = obj(toml);
  const profileName = str(root.profile);
  const profile = profileName ? obj(obj(root.profiles)[profileName]) : {};
  const models: Record<string, string> = {};
  const m = str(profile.model) ?? str(root.model);
  if (m) models[profileName && str(profile.model) ? `config.toml profiles.${profileName}.model` : "config.toml model"] = m;
  const provider = str(profile.model_provider) ?? str(root.model_provider) ?? "openai";
  const defined = obj(obj(root.model_providers)[provider]);
  const sources: EndpointSource[] = [];
  if (Object.keys(defined).length) {
    const from = `config.toml model_providers.${provider}.base_url`;
    sources.push(defined.base_url === undefined
      ? { from, kind: "unknown", baseUrl: null, host: null, note: "自定义 provider 没写 base_url" }
      : urlSource(from, defined.base_url, OPENAI_OFFICIAL_HOSTS));
  } else if (provider === "openai") {
    if (root.openai_base_url !== undefined) sources.push(urlSource("config.toml openai_base_url", root.openai_base_url, OPENAI_OFFICIAL_HOSTS));
    if (env.OPENAI_BASE_URL) sources.push(urlSource("当前进程 env OPENAI_BASE_URL", env.OPENAI_BASE_URL, OPENAI_OFFICIAL_HOSTS));
  } else if (CODEX_LOCAL_BUILTINS[provider]) {
    sources.push({ from: `内置 provider ${provider}`, kind: "third_party", baseUrl: null, host: CODEX_LOCAL_BUILTINS[provider]!, note: "本地模型" });
  } else {
    sources.push({ from: `config.toml model_provider = ${provider}`, kind: "unknown", baseUrl: null, host: null, note: "provider 在配置里找不到定义" });
  }
  const name = str(defined.name);
  return merge(name ? `${provider}（${name}）` : provider, sources, models, "official");
}

// ── Pi ───────────────────────────────────────────────────────────────────

/**
 * Pi 只报接入商名（规格允许）：settings.json 的 defaultProvider / defaultModel 与 models.json 的 provider 键。
 * 不判官方与否——models.json 能把内置 provider 的地址改掉，而那份文件里同时躺着 apiKey，这里不去读它的值。
 */
export function classifyPiEndpoint(settings: Record<string, unknown> | null, customProviders: string[]): EndpointVerdict {
  const s = obj(settings);
  const models: Record<string, string> = {};
  const dm = str(s.defaultModel);
  if (dm) models["settings.json defaultModel"] = dm;
  const provider = str(s.defaultProvider);
  const note = customProviders.length ? `models.json 自定义接入商：${customProviders.join(", ")}` : undefined;
  return { kind: "unknown", host: null, provider, sources: [], conflict: false, models, ...(note ? { note } : {}) };
}
