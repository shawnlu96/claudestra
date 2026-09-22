/**
 * setup 收尾要不要执行收编（纯函数，tests/setup-adoption.test.ts 覆盖）。
 * 收编的确认默认 Y，会 SIGTERM 用户在外面跑着的会话，之后只能经前端对话：
 * 所以 laterFailures（web 登录前置 sshd 等）必须先并进 failures 再判；没选 Discord 时
 * web 服务还必须真装上——否则会话被关掉、当下却无处对话。
 */

interface SetupAdoptionInput {
  /** 用户选了自己跑剩下的命令（没装，不算失败） */
  deferred: boolean;
  /** stepFinalize 报的失败 */
  failures: string[];
  /** 收尾之前各步攒下的失败（如 web 登录要的「远程登录」没开） */
  laterFailures: string[];
  discord: boolean;
  /** install-cli 真把 web 服务装上了（fin.web?.installed === true） */
  webInstalled: boolean;
}

/** 返回合并后的 failures；跳过收编时带 [中, 英] 提示（deferred 不提示：用户本来就选了自己跑） */
export function gateSetupAdoption(x: SetupAdoptionInput): {
  failures: string[];
  verdict: "adopt" | "deferred" | "failures" | "no-frontend";
  skipHint?: [string, string];
} {
  const failures = [...x.failures, ...x.laterFailures];
  if (x.deferred) return { failures, verdict: "deferred" };
  if (failures.length) {
    return { failures, verdict: "failures", skipHint: [
      "有组件没装好，先跳过收编（修好后用 bun src/manager.ts takeover 或网页侧栏收编）。",
      "Some components did not install — skipping adoption (adopt later with `bun src/manager.ts takeover` or the web sidebar).",
    ] };
  }
  if (!x.discord && !x.webInstalled) {
    return { failures, verdict: "no-frontend", skipHint: [
      "没配 Discord、web 服务也没装上：先跳过收编，免得关掉你的会话后无处对话（web 可用后用 bun src/manager.ts takeover 或网页侧栏收编）。",
      "No Discord and the web service is not installed — skipping adoption so your sessions are not closed with nowhere to continue them"
        + " (once the web UI works, adopt with `bun src/manager.ts takeover` or the web sidebar).",
    ] };
  }
  return { failures, verdict: "adopt" };
}
