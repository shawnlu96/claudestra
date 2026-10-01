/**
 * Discord 分类（category）满 50 个子频道后的溢出选择。项目分类「base」满了就用
 * 「base 2」「base 3」…，都满就建下一个编号——建 agent / 审查员不能被分类上限卡住。
 * 纯逻辑 + 结构类型（不 import discord.js），bridge/discord-api.ts 只做 guild 适配。
 * 测试：tests/discord-category.test.ts、tests/discord-category-wire.test.ts。
 */

/** Discord 单个分类的子频道上限 */
const CATEGORY_CHILD_MAX = 50;
/** Discord 频道 / 分类名长度上限 */
export const CATEGORY_NAME_MAX = 100;

export interface CategoryInfo {
  id: string;
  name: string;
  /** 该分类下现有频道数（所有类型都占名额） */
  children: number;
}

/** base 的第 n 个分类名：n=1 就是 base 本身；n≥2 超长时截 base、保留「 n」后缀 */
export function categoryName(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = ` ${n}`;
  return base.slice(0, CATEGORY_NAME_MAX - suffix.length) + suffix;
}

/**
 * name 是 base 家族的第几个：base 本身 = 1，「base N」（N≥2、无前导零）= N，别的 = null。
 * 「base 2 旧」「base2」「base 02」都不算，免得把用户自己建的同前缀分类当溢出位。
 */
export function overflowIndex(base: string, name: string): number | null {
  if (name === base) return 1;
  const m = / ([1-9]\d*)$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 && name === categoryName(base, n) ? n : null;
}

/**
 * 按 base、base 2、base 3… 的顺序取第一个没满的分类；都满（或一个都没有）就给出
 * 下一个没被占用的名字（编号有空洞时补最小空号）。同名重复的分类各自参与选择。
 */
export function pickCategory(
  cats: readonly CategoryInfo[],
  base: string,
  max = CATEGORY_CHILD_MAX,
): { use: string } | { create: string } {
  const family = cats
    .map((c) => ({ c, n: overflowIndex(base, c.name) }))
    .filter((x): x is { c: CategoryInfo; n: number } => x.n !== null)
    .sort((a, b) => a.n - b.n);
  const open = family.find((x) => x.c.children < max);
  if (open) return { use: open.c.id };
  const taken = new Set(family.map((x) => x.n));
  let n = 1;
  while (taken.has(n)) n++;
  return { create: categoryName(base, n) };
}

/** base 的全部溢出分类（不含 base 本身），按编号升序；项目改名时一起改 */
export function overflowNames(
  base: string,
  cats: readonly Pick<CategoryInfo, "id" | "name">[],
): Array<{ id: string; name: string; n: number }> {
  const out: Array<{ id: string; name: string; n: number }> = [];
  for (const c of cats) {
    const n = overflowIndex(base, c.name);
    if (n !== null && n >= 2) out.push({ id: c.id, name: c.name, n });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** guild 频道缓存里的一项（discord.js GuildChannel 的结构子集） */
export interface ChannelLike {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
}

/** 从频道缓存统计各分类子频道数；excludeId = 正在移动的频道，不占它要去的分类的名额 */
export function categoryInfos(channels: Iterable<ChannelLike>, excludeId?: string): CategoryInfo[] {
  const all = [...channels];
  const counts = new Map<string, number>();
  for (const ch of all) {
    if (ch.parentId && ch.id !== excludeId) counts.set(ch.parentId, (counts.get(ch.parentId) ?? 0) + 1);
  }
  return all.filter((c) => c.type === 4).map((c) => ({ id: c.id, name: c.name, children: counts.get(c.id) ?? 0 }));
}

/** Discord 拒绝「分类已满」：表单错误码 CHANNEL_PARENT_MAX_CHANNELS（缓存过时或并发抢位） */
export function isParentFullError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("CHANNEL_PARENT_MAX_CHANNELS");
}

/** discord-api 注入的 guild 操作 */
export interface CategoryOps {
  list(): CategoryInfo[];
  create(name: string): Promise<{ id: string }>;
  rename(id: string, name: string): Promise<unknown>;
}

/**
 * 选好分类后执行 place（建频道 / setParent）。place 撞「分类已满」→ 该分类按满算、
 * 重选一次；第二次还撞就抛 Discord 的原错误，不无限重试（重试只防缓存过时 / 并发）。
 */
export async function placeInCategory<T>(
  ops: CategoryOps,
  base: string,
  place: (parentId: string) => Promise<T>,
): Promise<T> {
  const full = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const cats = ops.list().map((c) => (full.has(c.id) ? { ...c, children: CATEGORY_CHILD_MAX } : c));
    const pick = pickCategory(cats, base);
    const id = "use" in pick ? pick.use : (await ops.create(pick.create)).id;
    try {
      return await place(id);
    } catch (e) {
      if (attempt > 0 || !isParentFullError(e)) throw e;
      full.add(id);
    }
  }
}

/**
 * 项目改名：新名的分类还没有、旧名的在 ⇒ 旧分类原地改名，旧名的溢出分类一起改成
 * 「新名 + 同一后缀」，不另建一套。新名已有分类时什么都不改（沿用新名那套）。
 */
export async function renameCategoryFamily(ops: CategoryOps, from: string, to: string): Promise<void> {
  const cats = ops.list();
  if (cats.some((c) => c.name === to)) return;
  const old = cats.find((c) => c.name === from);
  if (!old) return;
  await ops.rename(old.id, to);
  for (const o of overflowNames(from, cats)) await ops.rename(o.id, categoryName(to, o.n));
}
