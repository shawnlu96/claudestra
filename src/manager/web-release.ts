/**
 * 网页静态包：update 附带的构建（maybeBuildWeb）与按版本发布的手动入口（`manager web-release`，lib/web-releases.ts）。
 *   web-release deploy     手动部署（受支持的方式）：在构建锁下判过期 → 构建 → 发布切换，立刻生效、不用重启 bridge
 *   web-release publish    把现有的 web/out 发布成新版本（构建锁下）；别配合手动 `npm run build` 用，那个不拿锁
 *   web-release rollback   current 退回上一个版本，并取消待发布
 *   web-release migrate    .env 还直接指着 web/out 的 → 发布第一个版本并改指 current（install-cli 也会做）
 *   web-release list       版本目录、current、保留的版本
 * 只在主工作树跑：链接出去的 worktree 里的构建（next build --webpack）不该发布到线上。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo-root.js";
import { publishWebOut, rollbackWebOut } from "../lib/web-build.js";
import { currentLink, currentRelease, listReleases, migrateStaticDirToReleases, RELEASES_DIR } from "../lib/web-releases.js";
import { relayWebReminder } from "../lib/doctor-relay-web.js";
import { readBuildInfo } from "../lib/static-site.js";
import { output } from "./core.js";

/** v2.16.3 update 附带的 web 构建。返回值进 update 输出的 webBuild 字段——skipped/ok/error 三态,绝不静默。
 *  判据与 install-cli / doctor 共用(lib/web-build.ts,按 hash 比对):此前按「本次 diff 是否触及
 *  web/」触发,某一轮构建失败后下一轮 diff 不再含 web/,就永远不重试。 */
export async function maybeBuildWeb(): Promise<{ built: boolean; published?: boolean; restored?: boolean; skipped?: string; error?: string; warning?: string }> {
  const { rebuildWebIfStale } = await import("../lib/web-build.js");
  // 没装 web 的实例跳过,不拖垮整体 update
  if (!existsSync(`${REPO_ROOT}/web/node_modules`)) return { built: false, skipped: "web 未安装(无 node_modules)" };
  // 按版本托管时构建成功才发布切换；老配置直接读 web/out。两种都不用重启任何服务
  const r = await rebuildWebIfStale(REPO_ROOT);
  if (!r.attempted) return { built: false, ...(r.published ? { published: true } : {}), ...(r.error ? { error: r.error } : { skipped: r.skipped }) };
  if (!r.ok) {
    const tail = (r.log ?? []).join("\n");
    console.error(`[update] web 构建失败:\n${tail}`);
    return { built: false, restored: r.restored, error: `${r.error ?? "web 构建失败"}: ${tail.slice(0, 500)}` };
  }
  return { built: true, ...(r.published ? { published: true } : {}), ...(r.error ? { warning: r.error } : {}) }; // warning：已上线但清理旧版本失败等
}

/** 中继托管的是另一份前端：本机发完它还旧就在输出里说一句（手机经中继打开，拿不到本机这份） */
async function relayNote(): Promise<{ relayWeb?: string }> {
  const note = await relayWebReminder(REPO_ROOT, currentLink(), (d) => readBuildInfo(d)?.webCommit ?? null);
  return note ? { relayWeb: note } : {};
}

export async function cmdWebRelease(args: string[]): Promise<void> {
  const sub = args[0];
  // 链接出去的 worktree 里 .git 是文件不是目录
  const inWorktree = !statSync(join(REPO_ROOT, ".git"), { throwIfNoEntry: false })?.isDirectory();
  if (sub !== "list" && inWorktree && !args.includes("--from-worktree")) {
    output({ ok: false, error: `${REPO_ROOT} 是 worktree，不从这里发布 / 回滚线上网页（确实要就加 --from-worktree）` });
    process.exitCode = 2;
    return;
  }
  if (sub === "deploy") {
    // deployed 才表示这次真的构建并上线了；skipped（已是最新 / 构建锁忙 / 缺依赖）不算，自动化按它判断
    const r = await maybeBuildWeb();
    output({ ok: !r.error, deployed: r.built || !!r.published, ...r, ...(await relayNote()) });
    if (r.error) process.exitCode = 1;
  } else if (sub === "migrate") {
    output({ ok: true, notes: await migrateStaticDirToReleases(REPO_ROOT, () => publishWebOut(REPO_ROOT)) });
  } else if (sub === "publish") {
    const r = await publishWebOut(REPO_ROOT);
    output({ ...r, ...(r.ok ? await relayNote() : {}) });
    if (!r.ok) process.exitCode = 1;
  } else if (sub === "rollback") {
    const r = await rollbackWebOut();
    output({ ...r });
    if (!r.ok) process.exitCode = 1;
  } else if (sub === "list") {
    output({ ok: true, dir: RELEASES_DIR, current: currentRelease(), releases: listReleases() });
  } else {
    output({ ok: false, error: "web-release deploy|publish|rollback|migrate|list" });
    process.exitCode = 2;
  }
}
