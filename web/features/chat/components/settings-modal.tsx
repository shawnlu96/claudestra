"use client";
import { useState } from "react";
import { CenteredModal } from "./centered-modal";
import { useT } from "@/lib/i18n";
import { useClaudeModels } from "../claude-models";
import { isNativeShell } from "@/lib/native";
import { CronModal } from "./cron-modal";
import { RemoteAccessSection } from "./remote-access-section";
import { Section, GroupLabel } from "./settings/section";
import { TotpSection } from "./settings/totp-section";
import { PasskeySection } from "./settings/passkey-section";
import { ShellServerSection } from "./settings/shell-server-section";
import { ArchiveRetentionSection } from "./settings/archive-retention-section";
import { BackendUpdateSection } from "./settings/backend-update-section";
import { RestartAllSection } from "./settings/restart-all-section";
import { useProfileDraft, ProfileSection } from "./settings/profile-section";
import { useGroqKey, GroqKeySection } from "./settings/groq-key-section";
import { useClaudeDefaults, ClaudeDefaultsSection } from "./settings/claude-defaults-section";
import { usePushToggle, PushSection } from "./settings/push-section";
import { useBruteForce, BruteForceSection } from "./settings/brute-force-section";
import { useMemoryHygiene, MemoryHygieneSection } from "./settings/memory-hygiene-section";
import { useAutoCompact, AutoCompactSection } from "./settings/auto-compact-section";
import { AppearanceSection, LanguageSection, useKbFixToggle, KbFixSection, DevModeSection } from "./settings/interface-sections";

/**
 * 全局设置弹窗（侧栏 ⚙️ 进入）：个人资料（我的 + Claude 的头像/昵称,
 * owner 2026-07-14）+ Claude 全局默认(模型/effort,owner 2026-07-16)
 * + 语音识别的 Groq API Key。portal 到 body（规则 5.5）。
 * 完整 key 永不回显——已配置时展示尾四位提示。
 *
 * 本文件只管布局与组合；各分区在 ./settings/ 下，一个分区一个文件。
 * ⚠ 带状态的分区（资料 / 语音 Key / 全局默认 / 推送 / 失败封禁 / 记忆卫生 / 自动 Compact）
 * 的状态由这里调用各自的 useXxx(open) 持有，而不是分区组件自己持有：SettingsModal 关着时
 * 也挂载（下面 `if (!open) return null`），状态跨开关保留、打开时重置 + 拉取——这是拆分前
 * 的行为，改成分区自管（随打开挂载）会让重开时先闪默认值。hook 的调用顺序 = 拆分前那个
 * 打开 effect 里的请求顺序，别随手调换。
 * 自管状态的分区（两步验证 / Passkey / 归档保留 / 后端版本 / 全体重启 / 服务器地址）
 * 本来就是随打开挂载的独立组件，原样搬出。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const GLOBAL_MODEL_OPTIONS = useClaudeModels();
  const t = useT();
  // 「保存资料」与「语音 Key」共用的保存中标志（见 SharedBusy）
  const [busy, setBusy] = useState(false);
  const shared = { busy, setBusy };
  // iOS 键盘修正实验开关(use-keyboard-viewport):挂载时读 localStorage
  const kbFix = useKbFixToggle();
  // 以下每个 hook 在 open 变真时重置 + 拉取（顺序同拆分前）
  const profile = useProfileDraft(open, shared);
  const groq = useGroqKey(open, shared);
  const defaults = useClaudeDefaults(open);
  const push = usePushToggle(open);
  const sec = useBruteForce(open);
  const hygiene = useMemoryHygiene(open);
  const autoCompact = useAutoCompact(open);
  // HTTP peer 管理(owner 2026-07-24):独立弹窗
  // 定时任务管理(owner 2026-08-26):独立弹窗
  const [showCron, setShowCron] = useState(false);

  if (!open) return null;

  // portal 到 body（规则 5b）+ 手机上不歪的列宽修正，都在 CenteredModal 里
  return (
    <>
    <CenteredModal onClose={onClose} layer="base">
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("设置")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">{/* 分区卡片流 */}

        <GroupLabel>{t("界面与个人")}</GroupLabel>
        {/* ── 归档保留（v2.23+）：超期归档由每日兜底清理，0 = 永不清理 ── */}
        <ArchiveRetentionSection />
        {/* ── 原生壳:服务器地址(只在 iOS App 里出现;地址存本机,可换)─────────────── */}
        <BackendUpdateSection />
        <RestartAllSection />
        {isNativeShell() && open && <ShellServerSection />}
        {open && <RemoteAccessSection />}
        {/* ── 界面(外观 + 语言)─────────────── */}
        <AppearanceSection />
        <LanguageSection />

        {/* ── 个人资料（我的 + Claude 的）─────────────── */}
        <ProfileSection draft={profile} busy={busy} />

        <GroupLabel>{t("Claude")}</GroupLabel>
        {/* ── Claude 全局默认（模型 + Effort）─────────────── */}
        <ClaudeDefaultsSection defaults={defaults} modelOptions={GLOBAL_MODEL_OPTIONS} />

        <GroupLabel>{t("通知")}</GroupLabel>
        {/* ── Web Push 推送(本设备)─────────────── */}
        <PushSection push={push} />

        <GroupLabel>{t("自动化")}</GroupLabel>
        <Section
          title={t("定时任务")}
          aside={
            <button className="btn btn-sm" onClick={() => setShowCron(true)}>
              {t("管理")}
            </button>
          }
          desc={t("到点起临时 agent 执行指令。查看/新建/原地编辑频率与指令/停用。")}
        />

        {/* ── 记忆卫生(owner 2026-08-26:「mem0 会变粪坑」) ─────────────── */}
        <MemoryHygieneSection hygiene={hygiene} />

        {/* ── 自动存记忆+Compact(owner 2026-08-27:「设置里看不到」) ─────────────── */}
        <AutoCompactSection autoCompact={autoCompact} />

        <GroupLabel>{t("安全")}</GroupLabel>
        {/* ── 登录安全(owner 2026-08-09) ─────────────── */}
        <BruteForceSection sec={sec} />

        {/* ── 登录安全 · 两步验证(第二期) ─────────────── */}
        <TotpSection />

        {/* ── 登录安全 · Passkey(第三期) ─────────────── */}
        <PasskeySection />

        <GroupLabel>{t("连接与集成")}</GroupLabel>
        {/* Peer 协作已挪到侧栏顶部的独立按钮（peers-button.tsx） */}

        {/* ── 语音识别 Key ─────────────── */}
        <GroqKeySection groq={groq} busy={busy} />
        <GroupLabel>{t("实验")}</GroupLabel>
        <KbFixSection kbFix={kbFix} />
        <DevModeSection />

        </div>
    </CenteredModal>
    <CronModal open={showCron} onClose={() => setShowCron(false)} />
    </>
  );
}
