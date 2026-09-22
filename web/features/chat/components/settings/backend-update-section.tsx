"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useBackgroundJob, JobLog } from "../background-job";
import { Section } from "./section";

/**
 * v2.24+ 后端升级（owner 2026-09-22：「UI 里最好也加一个手动升级按钮，这样我点一下
 * 就好了。我指的是升级后端哈，UI 的版本更新现在已经有了。」）。
 *
 * 跟那个「新版本已就绪」胶囊是两回事：胶囊只换浏览器里的 bundle，这里是 git pull +
 * 重装 launchd daemon（bridge / launcher / cron / web）。
 *
 * ⚠ 三个细节决定了这段代码的形状：
 *  1. 升级会**重启 bridge 自己**，所以 POST 是点火即走（202），不等结果——等就是
 *     等自己被杀，前端只会拿到一个无从区分的网络错误；
 *  2. 因此「升完了没」不能靠请求返回，靠**轮询 /api/version 看 commit 变没变**；
 *  3. 升级期间日志接口自己也会短暂失败，那是正常现象，不当错误显示。
 */
export function BackendUpdateSection() {
  const t = useT();
  const [commit, setCommit] = useState<string>("");
  const [version, setVersion] = useState<string>("");
  const startCommit = useRef<string>("");

  const readVersion = async () => {
    try {
      const j = (await (await fetch("/api/version", { cache: "no-store" })).json()) as {
        version?: string; commit?: string;
      };
      if (j.commit) setCommit(j.commit);
      if (j.version) setVersion(j.version);
      return j.commit || "";
    } catch {
      return "";
    }
  };
  useEffect(() => { void readVersion(); }, []);

  // 完成判据：本轮日志的结果行（含「已是最新」）；bridge 重启把结果行吞掉时，commit 变了也算
  const job = useBackgroundJob({
    endpoint: "/api/update",
    deadlineMs: 10 * 60_000,
    deadlineMsg: t("等了 10 分钟还没升完，去看 update.log"),
    extraDone: async () => {
      const now = await readVersion();
      return !!(now && startCommit.current && now !== startCommit.current);
    },
    onDone: () => void readVersion(),
  });
  const start = () => {
    startCommit.current = commit;
    void job.start();
  };
  const busy = job.busy;

  return (
    <Section
      title={t("后端版本")}
      desc={t("git pull + 重装后台服务（bridge / launcher / cron / web）。升级时服务会依次重启，页面可能短暂断连，属正常。")}
      aside={
        <button className="btn btn-sm" disabled={busy} onClick={start}>
          {busy && <span className="loading loading-spinner loading-xs" />}
          {busy ? t("升级中…") : t("升级后端")}
        </button>
      }
    >
      <div className="text-xs opacity-60">
        {version ? `v${version}` : "—"} · {commit || "—"}
      </div>
      {job.err ? <div className="mt-1 text-xs text-error">{job.err}</div> : null}
      {job.note ? <div className="mt-1 text-xs opacity-70">{job.note}</div> : null}
      <JobLog lines={job.lines} />
    </Section>
  );
}
