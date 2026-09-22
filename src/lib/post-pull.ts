/**
 * `manager update` 拉到新代码之后的 `bun install` 该怎么收场（D6-8，按复核修正）。
 *
 * 以前两条 update 路径都只 `await exited`，不看退出码：断网或锁文件冲突时照样 reload
 * 三个 daemon，新代码缺依赖直接起不来。但「失败就不 reload」也不够——git 已经切到
 * 新代码，旧 daemon 继续跑、磁盘上却是新代码，launchd KeepAlive 下次拉起时照样用缺
 * 依赖的新代码，留下半生效状态。所以：
 *   - 依赖清单（package.json / bun.lock）在这次前进里**变了** → 回退代码到前进前，
 *     不发 /exit、不 reload，把失败原样报出；
 *   - 依赖清单没变 → 装不上也不影响新代码（依赖还是旧的那套），只警告、继续。
 *
 * 纯编排，副作用全部注入，便于单测——验证绝不能去跑真实的 manager update（它会改写
 * 生产 launchd plist、给生产 master 发 /exit）。
 */

export const DEP_MANIFESTS = ["package.json", "bun.lock", "bun.lockb"];

export interface PostPullDeps {
  /** 跑 bun install；成功 null，失败返回原因 */
  runInstall(): Promise<string | null>;
  /** 依赖清单在这次前进里是否变了；判断不了按「变了」算（保守） */
  depsChanged(): Promise<boolean>;
  /** 回退代码到前进前；成功 null，失败返回原因 */
  rollback(): Promise<string | null>;
}

export type InstallOutcome =
  | { ok: true; warning?: string }
  | { ok: false; step: "bun install"; err: string; rolledBack: boolean; rollbackError?: string };

export async function installAfterPull(d: PostPullDeps): Promise<InstallOutcome> {
  const fail = await d.runInstall();
  if (!fail) return { ok: true };
  let changed = true;
  try { changed = await d.depsChanged(); } catch { changed = true; }
  if (!changed) return { ok: true, warning: `bun install 失败但依赖清单未变，继续：${fail}` };
  const rb = await d.rollback();
  return rb
    ? { ok: false, step: "bun install", err: fail, rolledBack: false, rollbackError: rb }
    : { ok: false, step: "bun install", err: fail, rolledBack: true };
}
