/**
 * 「上次装到哪一步了」的探测（v2.24+）。纯逻辑，单测覆盖。
 *
 * 装机会在任何一步断：网不好、npm 挂了、用户 Ctrl-C、构建失败、机器睡了。
 * 断了之后重跑向导本该是**接着装**，但原来的向导对此一无所知——最糟的是收尾那步
 * 见到 `.env` 已存在会问「要覆盖吗？」且默认 **否**，一路回车就 `process.exit(1)`
 * 把整个向导干掉：重跑反而比第一次更难走通。
 *
 * 这里只回答「什么已经好了」，判据一律是**落盘的事实**（文件在不在），不猜、不记
 * 状态文件——状态文件本身会和现实脱节，而这几个文件就是现实。
 */

export interface InstallProgressInput {
  envFile: boolean;
  webEnvLocal: boolean;
  webNextBin: boolean;
  webBuildId: boolean;
  bridgePlist: boolean;
  webPlist: boolean;
  /**
   * 文件在 ≠ 是这一版的：重跑 install.sh 切到新版本后 node_modules / .next 都还是旧的。
   * false = 确知过期；省略 = 判断不了（按旧行为当新鲜），见 webDepsFresh / webBuildFresh。
   */
  webDepsFresh?: boolean;
  webBuildFresh?: boolean;
}

/**
 * 依赖新鲜度：npm install 写 node_modules/.package-lock.json，它不早于 package-lock.json
 * 才算装的是这一版。lockMtime 为 null（没有 lock 文件）判断不了 → 当新鲜。
 */
export function webDepsFresh(lockMtime: number | null, installedMtime: number | null): boolean {
  if (lockMtime === null) return true;
  if (installedMtime === null) return false;
  return installedMtime >= lockMtime;
}

/** web/lib/build-info.ts（构建前生成、不进 git）里烤进 bundle 的 web commit */
export function parseClientWebCommit(buildInfoSource: string | null): string | null {
  const m = /CLIENT_WEB_COMMIT\s*=\s*"([^"]*)"/.exec(buildInfoSource ?? "");
  return m && m[1] ? m[1] : null;
}

/**
 * 构建新鲜度：产物烤的 web commit 等于当前 web/ 最后一次（非文档）提交。
 * 当前 commit 拿不到（不是 git 检出）判断不了 → 当新鲜；产物里没有记录
 * （v2.20.1 时代的构建没有 build-info.ts）→ 过期。
 */
export function webBuildFresh(builtCommit: string | null, currentCommit: string | null): boolean {
  if (!currentCommit) return true;
  return !!builtCommit && builtCommit === currentCommit;
}

export interface InstallProgress extends InstallProgressInput {
  /** 有任何一项做完了 = 这是一次续装，不是全新安装 */
  partial: boolean;
  /** 全做完了 = 重跑只是改配置 */
  complete: boolean;
}

export function assessInstall(x: InstallProgressInput): InstallProgress {
  const flags = [x.envFile, x.webEnvLocal, x.webNextBin, x.webBuildId, x.bridgePlist, x.webPlist];
  return { ...x, partial: flags.some(Boolean), complete: flags.every(Boolean) };
}

/** 续装时该跳过哪些**耗时且已完成**的动作（用户仍可显式要求重做） */
export function skippableSteps(p: InstallProgress): { webInstall: boolean; webBuild: boolean } {
  const webInstall = p.webNextBin && p.webDepsFresh !== false;
  return {
    webInstall,
    // 依赖重装过就得重新构建：.next 里烤着上一份依赖的产物
    webBuild: p.webBuildId && p.webBuildFresh !== false && webInstall,
  };
}

/** 给人看的一行行清单（i18n 由调用方套壳，这里只给 key + 状态） */
export function progressChecklist(p: InstallProgress): Array<{ key: keyof InstallProgressInput; done: boolean }> {
  return [
    { key: "envFile", done: p.envFile },
    { key: "webEnvLocal", done: p.webEnvLocal },
    { key: "webNextBin", done: p.webNextBin },
    { key: "webBuildId", done: p.webBuildId },
    { key: "bridgePlist", done: p.bridgePlist },
    { key: "webPlist", done: p.webPlist },
  ];
}
