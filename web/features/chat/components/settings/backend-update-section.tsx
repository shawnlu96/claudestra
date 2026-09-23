"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useBackgroundJob, JobLog } from "../background-job";
import { Section } from "./section";
import { UpdatePrefsPanel, UpdateTarget, useUpdateCheck, useUpdatePrefs } from "./update-prefs";

/**
 * 版本与更新：一键升级 Claudestra（前后端一起）+ 能升到哪个版本 + 通道 / 自动更新开关。
 *
 * 按钮跑的是 `manager update`：按通道切到最新正式版 tag 或 main → bun install → web 依赖
 * 变了就 npm install、构建过期就重建（失败换回旧构建）→ 重启 web 与 bridge / launcher / cron。
 * 跟那个「新版本已就绪」胶囊是两回事：胶囊只换浏览器里的 bundle。
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

  // 升级完成后 +1，让「能升到哪个版本」重查
  const [checkRound, setCheckRound] = useState(0);
  // 完成判据：本轮日志的结果行（含「已是最新」）；bridge 重启把结果行吞掉时，commit 变了也算
  const job = useBackgroundJob({
    endpoint: "/api/update",
    deadlineMs: 10 * 60_000,
    deadlineMsg: t("等了 10 分钟还没升完，去看 update.log"),
    extraDone: async () => {
      const now = await readVersion();
      return !!(now && startCommit.current && now !== startCommit.current);
    },
    onDone: () => {
      void readVersion();
      setCheckRound((n) => n + 1);
    },
  });
  const prefs = useUpdatePrefs();
  const target = useUpdateCheck(prefs.prefs ? `${prefs.prefs.channel}:${checkRound}` : "");
  const start = () => {
    startCommit.current = commit;
    void job.start();
  };
  const busy = job.busy;

  return (
    <Section
      title={t("版本与更新")}
      desc={t("前后端一起升：拉取新版本 → 装依赖 → 网页有变化就重新构建 → 依次重启网页、bridge、launcher、cron。不用自己构建；升级时页面会短暂断开，属正常。")}
      aside={
        <button className="btn btn-sm" disabled={busy} onClick={start}>
          {busy && <span className="loading loading-spinner loading-xs" />}
          {busy ? t("升级中…") : t("升级 Claudestra")}
        </button>
      }
    >
      <div className="flex flex-wrap gap-x-1.5 text-xs">
        <span className="opacity-60">{t("当前")} {version ? `v${version}` : "—"} · {commit || "—"} ·</span>
        <UpdateTarget check={target.check} err={target.err} />
      </div>
      {job.err ? <div className="mt-1 text-xs text-error">{job.err}</div> : null}
      {job.note ? <div className="mt-1 text-xs opacity-70">{job.note}</div> : null}
      <JobLog lines={job.lines} />
      <UpdatePrefsPanel state={prefs} />
    </Section>
  );
}
