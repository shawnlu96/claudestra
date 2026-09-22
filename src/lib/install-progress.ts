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
  return {
    webInstall: p.webNextBin,
    // 依赖重装过就得重新构建：.next 里烤着上一份依赖的产物
    webBuild: p.webBuildId && p.webNextBin,
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
