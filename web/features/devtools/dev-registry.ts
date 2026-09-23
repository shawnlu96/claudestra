/**
 * 开发者面板的分区注册表。纯逻辑,无 DOM、不依赖 lil-gui 类型。
 *
 * 面板本体(dev-overlay.tsx)只负责壳:徽章、展开/折叠、stats.js、事件列表。
 * 具体调什么参数、看什么读数,由各处代码 **自己注册进来**(范式见 docs/web-dev-mode.md):
 *
 *   registerDevSection("slide", ({ gui, onTick }) => {
 *     const f = (gui as GUI).addFolder("横滑");
 *     f.add(params, "durationMs", 100, 1000);
 *     return () => f.destroy();
 *   });
 *
 * 注册可以早于面板挂载(面板挂上后回放已有注册),也可以晚于(面板订阅了变化)。
 * ctx.gui 用 unknown 承载 lil-gui 的 GUI 实例:注册方 `import type GUI from "lil-gui"`
 * 自己断言;这里不引 lil-gui,是为了让本文件能在 bun test 里零依赖跑。
 */

export type DevSectionCtx = {
  /** lil-gui 的 GUI 根实例(类型见 lil-gui;这里不引依赖)。 */
  gui: unknown;
  /** 面板每秒 tick 一次时回调;用来刷新只读读数。 */
  onTick: (fn: (now: number) => void) => void;
};

export type DevSection = {
  id: string;
  /** 挂到面板上;返回卸载函数(销毁 folder / 断开 observer)。 */
  mount: (ctx: DevSectionCtx) => (() => void) | void;
};

const sections = new Map<string, DevSection>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  for (const l of listeners) l();
}

/** 注册(同 id 覆盖,方便 HMR)。返回注销函数。 */
export function registerDevSection(id: string, mount: DevSection["mount"]): () => void {
  sections.set(id, { id, mount });
  notify();
  return () => {
    if (sections.get(id)?.mount === mount) {
      sections.delete(id);
      notify();
    }
  };
}

export function listDevSections(): DevSection[] {
  return [...sections.values()];
}

export function devSectionsVersion(): number {
  return version;
}

export function subscribeDevSections(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 测试 / HMR 用。 */
export function clearDevSections(): void {
  sections.clear();
  notify();
}
