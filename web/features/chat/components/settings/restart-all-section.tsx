"use client";
import { useT } from "@/lib/i18n";
import { useBackgroundJob, JobLog } from "../background-job";
import { useArmedConfirm } from "../../use-armed-confirm";
import { Section } from "./section";

/**
 * v2.24+ 全体重启（owner 2026-09-22：「Claude 被意外登出后，我在某个 Agent 手动登录了，
 * 其他 Agent 还是需要重启，不然发消息还是未登录」）。
 *
 * 这不是我们的 bug 也修不掉：Claude Code 的凭证只在**进程启动时**读一次，之后在内存里
 * 自己续期。远端重新登录会让旧 refresh token 作废，跑着的进程既刷不动也不会回头重读
 * keychain —— 只能让每个进程重启。所以给一个按钮，而不是让人去敲 18 次命令。
 *
 * 两段式确认（点一下变「确定？」，8 秒无操作复原）：这是个影响全机的动作，但又不值得
 * 为它开一个模态框。
 */
export function RestartAllSection() {
  const t = useT();
  const { armed, arm, disarm } = useArmedConfirm(8000);
  const job = useBackgroundJob({
    endpoint: "/api/restart-all",
    deadlineMs: 20 * 60_000,
    deadlineMsg: t("等了 20 分钟还没重启完，去看 restart-all.log"),
  });
  const busy = job.busy;

  const start = () => {
    disarm();
    void job.start();
  };

  return (
    <Section
      title={t("全体重启")}
      desc={t("Claude Code 重新登录后用：凭证只在进程启动时读一次，已经在跑的会话不会自己认新登录。每个会话都 resume 原会话，上下文不丢；大总管由守护进程在 15 秒内接回。整轮几分钟，期间会话会陆续离线又回来。")}
      aside={
        <button
          className={`btn btn-sm ${armed ? "btn-warning" : ""}`}
          disabled={busy}
          onClick={() => (armed ? start() : arm())}
        >
          {busy && <span className="loading loading-spinner loading-xs" />}
          {busy ? t("重启中…") : armed ? t("确定，全部重启") : t("重启全部会话")}
        </button>
      }
    >
      {job.err ? <div className="text-xs text-error">{job.err}</div> : null}
      {job.note ? <div className="text-xs opacity-70">{job.note}</div> : null}
      <JobLog lines={job.lines} />
    </Section>
  );
}
