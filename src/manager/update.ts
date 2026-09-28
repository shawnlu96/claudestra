/**
 * `manager update`：release 通道（切到最新 tag）与 beta 通道（ff 到 origin/main），外加「上次砍在半路」的补完。
 *
 * 两个通道共用切版本之后的尾段（bun install → 渲染 master → web 构建 → migrate → /exit master →
 * 释锁 → reload 三个 daemon）。切版本前写 update-inflight 标记（lib/update-inflight.ts），尾段逐步推进，
 * reload 完才删。再跑时 resumeUpdate 先看标记：HEAD 已是目标 → 从尾段补（「已是最新」不再挡住没 reload 的
 * 情况）；只差 reload → 只补 reload；持有者还在 → 拒绝。
 */
import { statSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { UPDATE_LOCK } from "../lib/paths.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { resolveBunPath } from "../lib/bun-path.js";
import { installAfterPull, DEP_MANIFESTS } from "../lib/post-pull.js";
import { MASTER_SESSION, tmuxRaw } from "../lib/tmux-helper.js";
import { pidAlive } from "../lib/pending-ops.js";
import {
  clearUpdateMarker, launchdStartedAt, readUpdateMarker, updateVerdict, writeUpdateMarker, UPDATE_INFLIGHT,
  type UpdateMarker, type UpdateStep,
} from "../lib/update-inflight.js";
import { maybeBuildWeb } from "./web-release.js";
import { output } from "./core.js";

type Proc = { exited: Promise<number>; stdout: ReadableStream; stderr: ReadableStream };
export interface UpdateDeps {
  git(...args: string[]): Promise<{ ok: boolean; out: string; err: string }>;
  spawnFailure(proc: Proc, tailLines?: number): Promise<string | null>;
  renderMasterClaude(): Promise<{ rendered: boolean; reason?: string }>;
}

/** update.lock 互斥。锁文件里是持有者 pid——持有 pid 已死的锁（launcher 被 bootout 时连坐回收留下的）直接接管；
 *  活着的仍按 30 分钟陈旧闸。 */
async function takeUpdateLock(): Promise<{ ok: boolean; error?: string }> {
  try {
    const st = statSync(UPDATE_LOCK);
    let holderAlive = false;
    try {
      const pid = parseInt((await Bun.file(UPDATE_LOCK).text()).trim(), 10);
      holderAlive = pid > 0 && pidAlive(pid);
    } catch { /* 读不到 pid → 当孤儿 */ }
    if (holderAlive && Date.now() - st.mtimeMs < 30 * 60_000) {
      return { ok: false, error: "另一次 update 正在进行(持有进程在世,update.lock 未满 30 分钟)——稍后再试" };
    }
    if (!holderAlive) console.error("[update] 清除孤儿 update.lock(持有 pid 已死)");
  } catch { /* 无锁 */ }
  await writeFile(UPDATE_LOCK, String(process.pid)).catch((e) => console.error(`[update] 写 update.lock 失败（继续，只是少了互斥）: ${(e as Error).message}`));
  return { ok: true };
}

const unlock = () => rm(UPDATE_LOCK, { force: true }).catch((e) => console.error(`[update] 删 update.lock 失败: ${(e as Error).message}`));

async function setStep(m: UpdateMarker, step: UpdateStep): Promise<void> {
  m.step = step;
  if (step === "reloading") m.reloadAt = new Date().toISOString();
  await writeUpdateMarker(m);
}

function newMarker(channel: UpdateMarker["channel"], target: string, targetLabel: string, fromHead: string): UpdateMarker {
  return { pid: process.pid, channel, target, targetLabel, fromHead, step: "checkout", startedAt: new Date().toISOString() };
}

/** 失败时回到升级前：release 是 checkout 回旧 HEAD，beta 在分支上用 reset --keep */
function rollbackFor(d: UpdateDeps, m: UpdateMarker): () => Promise<string | null> {
  return async () => {
    const r = m.channel === "beta" ? await d.git("reset", "--keep", m.fromHead) : await d.git("checkout", m.fromHead, "--quiet");
    return r.ok ? null : r.err || "git 回退失败";
  };
}

/** reload 三个 daemon + 装 skills。launcher 在最后，本进程可能在 bootout launcher 时被回收（预期） */
async function reloadDaemons(m: UpdateMarker) {
  await setStep(m, "reloading");
  await unlock(); // ⚠ 先释锁再 reload：殉锁会把之后 30 分钟的更新全封死
  console.error(`[update] 临界区完成,即将 reload 3 daemons(本进程可能随 launcher bootout 被回收,属预期)`);
  const { installClaudestraCli } = await import("../lib/cli-install.js");
  const cliInstall = await installClaudestraCli(REPO_ROOT, { skipWebBuild: true }); // 尾段的 maybeBuildWeb 已判过/建过
  const { installRepoSkills } = await import("../lib/skills-install.js");
  const skillsInstalled = installRepoSkills(REPO_ROOT);
  for (const sk of skillsInstalled) if (sk.action !== "ok") console.error(`[skills] ${sk.name}: ${sk.action} — ${sk.detail}`);
  // 有 daemon 没 bootstrap 上就留着标记：doctor 报出来，再跑 update 只补 reload
  if (cliInstall.daemons.every((x) => x.loaded)) clearUpdateMarker();
  return { cliInstall, skillsInstalled };
}

type TailOk = { ok: true; rendered: { rendered: boolean; reason?: string }; webBuild: Awaited<ReturnType<typeof maybeBuildWeb>>; migrateError: string | null;
  installWarning?: string; cliInstall: Awaited<ReturnType<typeof reloadDaemons>>["cliInstall"]; skillsInstalled: Awaited<ReturnType<typeof reloadDaemons>>["skillsInstalled"] };

/** 切版本之后的尾段；m.step 逐步推进。依赖装不上 → 回退 + 不 reload */
async function runTail(d: UpdateDeps, m: UpdateMarker): Promise<TailOk | { ok: false; payload: Record<string, unknown> }> {
  const install = await installAfterPull({
    runInstall: () => d.spawnFailure(Bun.spawn([resolveBunPath(), "install"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }), 20),
    depsChanged: async () => !(await d.git("diff", "--quiet", m.fromHead, m.target, "--", ...DEP_MANIFESTS)).ok,
    rollback: rollbackFor(d, m),
  });
  if (!install.ok) {
    await unlock();
    if (install.rolledBack) clearUpdateMarker(); // 回退没成功就留着：HEAD 仍是目标，下次从尾段重试
    return { ok: false, payload: {
      ok: false, channel: m.channel, step: install.step, rolledBack: install.rolledBack,
      error: `bun install 失败（${install.err}）——${install.rolledBack ? `已回退到 ${m.fromHead.slice(0, 7)}` : `回退也失败了：${install.rollbackError}`}；未 reload daemon`,
    } };
  }
  if (install.warning) console.error(`[update] ⚠️ ${install.warning}`);
  await setStep(m, "installed");
  // 新版本可能更新了 master prompt / web 包：不刷新就是「bridge 新、master 和网页旧」的半生效
  const rendered = await d.renderMasterClaude();
  const webBuild = await maybeBuildWeb();
  await setStep(m, "built");
  // 用 subprocess 跑新版的 migrate（当前进程跑的还是旧代码）
  const migrateError = await d.spawnFailure(Bun.spawn([resolveBunPath(), "run", `${REPO_ROOT}/src/manager.ts`, "migrate"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" }));
  if (migrateError) console.error(`[update] ⚠️ migrate 失败（继续）: ${migrateError}`);
  await setStep(m, "migrated");
  // daemon reload 不动 tmux 里的 master：让它退出，launcher 用新 CLAUDE.md 重启
  await Bun.sleep(500);
  await tmuxRaw(["send-keys", "-t", `${MASTER_SESSION}:0`, "/exit", "Enter"]).catch((e) => console.error(`[update] 通知 master 退出失败: ${(e as Error).message}`));
  const reload = await reloadDaemons(m);
  return { ok: true, rendered, webBuild, migrateError, installWarning: install.warning, ...reload };
}

/** checkout <tag> 必然 detached：无分叉才 ff 挂回 main/master；分叉（开发机本地有超前 commit）保持 detached 并说明 */
async function reattachBranch(d: UpdateDeps, tag: string): Promise<{ ok: boolean; detail: string }> {
  for (const br of ["main", "master"]) {
    const has = await d.git("rev-parse", "--verify", "--quiet", `refs/heads/${br}`);
    if (!has.ok) continue;
    const anc = await d.git("merge-base", "--is-ancestor", br, tag);
    if (!anc.ok) return { ok: false, detail: `本地 ${br} 与 ${tag} 分叉,保持 detached(开发机属预期);手工挂回: git checkout ${br} && git merge --ff-only ${tag}` };
    const co = await d.git("checkout", br, "--quiet");
    if (!co.ok) return { ok: false, detail: `checkout ${br} 失败: ${co.err}` };
    const ff = await d.git("merge", "--ff-only", tag, "--quiet");
    if (!ff.ok) return { ok: false, detail: `ff 合并失败: ${ff.err}` };
    return { ok: true, detail: `已挂回 ${br} @ ${tag}` };
  }
  return { ok: false, detail: "未找到 main/master 本地分支,保持 detached" };
}

function releaseOutput(from: string, tag: string, t: TailOk, reattach: { ok: boolean; detail: string }, extra: Record<string, unknown> = {}) {
  const ci = t.cliInstall;
  return {
    ok: true, from, to: tag, message: `已更新到 ${tag} 并 reload 三个 launchd daemon`, ...extra,
    masterReRendered: t.rendered,
    webBuild: t.webBuild, // web 构建结果显式冒泡(skipped 带原因 / ok / error 带尾部日志)——绝不静默
    branch: reattach, // 分支挂回结果——同样绝不静默
    migrateError: t.migrateError || undefined,
    installWarning: t.installWarning,
    cliInstalled: ci.errors.length === 0,
    cliWrapper: ci.cliWrapper || undefined,
    daemons: ci.daemons.map((x) => ({ label: x.label, loaded: x.loaded, warning: x.warning })),
    pm2Stopped: ci.pm2Stopped.length > 0 ? ci.pm2Stopped : undefined,
    oldAutostartPlist: ci.oldAutostartPlist,
    oldPm2StartupPlist: ci.oldPm2StartupPlist,
    migratedHookCommand: ci.migratedHookCommand || undefined,
    bumpedTmuxDashboardLimit: ci.bumpedTmuxDashboardLimit,
    allowedMcpTools: ci.allowedMcpTools,
    cliErrors: ci.errors.length > 0 ? ci.errors : undefined,
    cliWarnings: ci.warnings.length > 0 ? ci.warnings : undefined,
  };
}

function betaOutput(from: string, to: string, t: TailOk, extra: Record<string, unknown> = {}) {
  return {
    ok: true, channel: "beta", skills: t.skillsInstalled, from, to,
    message: `beta 已前进 ${from} → ${to} 并 reload daemon`, ...extra,
    masterReRendered: t.rendered, webBuild: t.webBuild, cliInstalled: t.cliInstall.errors.length === 0,
    ...(t.migrateError ? { migrateError: t.migrateError } : {}),
    ...(t.installWarning ? { installWarning: t.installWarning } : {}),
  };
}

/** 补完路径的每个出口都要 output 并告诉调用方「已处理」 */
function done(payload: Record<string, unknown>): true {
  output(payload);
  return true;
}

/** 上次 update 砍在半路时补完。返回 true = 已处理（已 output），调用方直接返回 */
async function resumeUpdate(d: UpdateDeps): Promise<boolean> {
  const m = readUpdateMarker();
  if (!m) return false;
  const head = (await d.git("rev-parse", "HEAD")).out.trim();
  const { DAEMONS } = await import("../lib/cli-install.js");
  const starts = Object.fromEntries(DAEMONS.map((x) => [x.label, launchdStartedAt(x.label)]));
  const v = updateVerdict(m, head, Date.now(), pidAlive, starts);
  if (v.action === "clear") {
    console.error(`[update] 清除上次的进行中标记：${v.why}`);
    clearUpdateMarker();
    return false;
  }
  if (v.action === "live") return done({ ok: false, error: `另一次 update 正在进行（pid ${m.pid}，步骤 ${m.step}）——稍后再试` });
  if (v.action === "report") return done({ ok: false, error: `上次 update（→ ${m.targetLabel}）没做完，且${v.why}。核对后删掉 ${UPDATE_INFLIGHT} 再跑 update` });
  const lock = await takeUpdateLock();
  if (!lock.ok) return done({ ok: false, error: lock.error });
  const resumed = { resumed: `上次 update 停在「${m.step}」，已从这里补完` };
  m.pid = process.pid;
  if (v.action === "finish-reload") {
    const r = await reloadDaemons(m);
    const daemons = r.cliInstall.daemons.map((x) => ({ label: x.label, loaded: x.loaded, warning: x.warning }));
    return done({ ok: r.cliInstall.errors.length === 0, ...resumed, to: m.targetLabel, notReloaded: v.stale, daemons });
  }
  const reattach = m.channel === "release" ? await reattachBranch(d, m.targetLabel) : null;
  const t = await runTail(d, m);
  if (!t.ok) return done(t.payload);
  const from = m.fromHead.slice(0, 7);
  return done(m.channel === "beta" ? betaOutput(from, m.targetLabel, t, resumed) : releaseOutput(from, m.targetLabel, t, reattach!, resumed));
}

/** beta 通道：紧跟 origin/main 的每个 commit（ff-only，天然在分支上不 detach） */
async function cmdUpdateBeta(d: UpdateDeps): Promise<void> {
  const lock = await takeUpdateLock();
  if (!lock.ok) return output({ ok: false, error: lock.error });
  const status = await d.git("status", "--porcelain");
  if (!status.ok || status.out) {
    await unlock();
    return output({ ok: false, error: status.ok ? "仓库有未提交的改动,先 commit/stash 再更新" : "不是 git 仓库" });
  }
  await d.git("fetch", "--quiet", "origin", "main");
  const preHead = (await d.git("rev-parse", "HEAD")).out.trim();
  const remote = (await d.git("rev-parse", "origin/main")).out.trim();
  if (!remote) { await unlock(); return output({ ok: false, error: "取不到 origin/main" }); }
  if (preHead === remote) {
    // 已同步;若还挂在 detached 顺手挂回(beta 通道也可能从 release 时代的 detach 迁移来)
    await d.git("checkout", "main", "--quiet");
    await d.git("merge", "--ff-only", "origin/main", "--quiet");
    await unlock();
    return output({ ok: true, channel: "beta", head: preHead.slice(0, 7), message: `beta 已是最新 @ ${preHead.slice(0, 7)}` });
  }
  const anc = await d.git("merge-base", "--is-ancestor", "HEAD", "origin/main");
  if (!anc.ok) {
    await unlock();
    return output({ ok: false, error: `本地 HEAD 与 origin/main 分叉,beta 通道不强推——手动处理后再试(git log HEAD...origin/main)` });
  }
  const m = newMarker("beta", remote, remote.slice(0, 7), preHead);
  await writeUpdateMarker(m);
  const co = await d.git("checkout", "main", "--quiet");
  const ff = co.ok ? await d.git("merge", "--ff-only", "origin/main", "--quiet") : co;
  if (!ff.ok) { clearUpdateMarker(); await unlock(); return output({ ok: false, error: `ff 前进失败: ${ff.err}` }); }
  const t = await runTail(d, m);
  output(t.ok ? betaOutput(preHead.slice(0, 7), remote.slice(0, 7), t) : t.payload);
}

/** release 通道：查最新 release → 切到 tag → 挂回分支 → 尾段。beta 通道与半截补完在前面分流 */
export async function cmdUpdate(d: UpdateDeps): Promise<void> {
  if (await resumeUpdate(d)) return;
  const { readConfig } = await import("../lib/config-store.js");
  if (((await readConfig()).autoUpdate.channel ?? "release") === "beta") return cmdUpdateBeta(d);
  const { getLatestRelease, getLocalVersion, isNewer } = await import("../lib/github-release.js");
  const release = await getLatestRelease();
  if (!release) return output({ ok: false, error: "无法查询 GitHub release（网络问题或没有发布过 release）" });
  const local = await getLocalVersion();
  if (!isNewer(release.version, local)) return output({ ok: true, version: local, message: `已是最新版本 v${local}` });

  const status = await d.git("status", "--porcelain");
  if (!status.ok) return output({ ok: false, error: "不是 git 仓库，无法自动更新" });
  if (status.out) return output({ ok: false, error: "仓库有未提交的改动，请先 commit/stash 后再更新", dirty: status.out });
  // 并发闸：自动更新 30 分钟一轮，web 构建动辄分钟级，别被下一轮重入
  const relLock = await takeUpdateLock();
  if (!relLock.ok) return output({ ok: false, error: relLock.error });

  await d.git("fetch", "--tags", "--quiet", "origin");
  const preUpdateHead = (await d.git("rev-parse", "HEAD")).out.trim();
  const target = (await d.git("rev-parse", `${release.tag}^{commit}`)).out.trim();
  const m = newMarker("release", target, release.tag, preUpdateHead);
  await writeUpdateMarker(m);
  const checkout = await d.git("checkout", release.tag, "--quiet");
  if (!checkout.ok) {
    clearUpdateMarker();
    await unlock();
    return output({ ok: false, error: `git checkout ${release.tag} 失败: ${checkout.err}` });
  }
  const reattach = await reattachBranch(d, release.tag);
  if (!reattach.ok) console.error(`[update] ⚠️ ${reattach.detail}`);
  const t = await runTail(d, m);
  output(t.ok ? releaseOutput(`v${local}`, release.tag, t, reattach) : t.payload);
}
