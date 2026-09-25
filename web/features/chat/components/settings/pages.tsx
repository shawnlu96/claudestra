"use client";
import { useT } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";
import { RemoteAccessSection } from "../remote-access-section";
import { PeersPanel } from "../peers-modal";
import { Section, GroupLabel } from "./section";
import { TotpSection } from "./totp-section";
import { PasskeySection } from "./passkey-section";
import { ShellServerSection } from "./shell-server-section";
import { ArchiveRetentionSection } from "./archive-retention-section";
import { BackendUpdateSection } from "./backend-update-section";
import { RestartAllSection } from "./restart-all-section";
import { useProfileDraft, ProfileSection } from "./profile-section";
import { useGroqKey, GroqKeySection } from "./groq-key-section";
import { useClaudeDefaults, ClaudeDefaultsSection } from "./claude-defaults-section";
import { usePushToggle, PushSection } from "./push-section";
import { useBruteForce, BruteForceSection } from "./brute-force-section";
import { useMemoryHygiene, MemoryHygieneSection } from "./memory-hygiene-section";
import { useAutoCompact, AutoCompactSection } from "./auto-compact-section";
import { AppearanceSection, LanguageSection, useKbFixToggle, KbFixSection, DevModeSection } from "./interface-sections";
import { ThemeVarsSection } from "./theme-vars-section";
import { FontSection } from "./font-section";
import type { SettingsPageId } from "./nav";

/**
 * 设置弹窗的八个页面(菜单在 ./nav.tsx)。带状态的分区其状态仍由 SettingsModal 的 useXxx(open)
 * 持有并经 `state` 传进来——页面切换只是分区组件的挂载/卸载，不碰数据；自管状态的分区
 * (两步验证 / Passkey / 归档保留 / 后端版本 / 全体重启 / 服务器地址 / 手机访问 / Peer 协作)本来就随挂载拉取。
 */
export interface SettingsState {
  busy: boolean;
  profile: ReturnType<typeof useProfileDraft>;
  groq: ReturnType<typeof useGroqKey>;
  defaults: ReturnType<typeof useClaudeDefaults>;
  modelOptions: Parameters<typeof ClaudeDefaultsSection>[0]["modelOptions"];
  push: ReturnType<typeof usePushToggle>;
  sec: ReturnType<typeof useBruteForce>;
  hygiene: ReturnType<typeof useMemoryHygiene>;
  autoCompact: ReturnType<typeof useAutoCompact>;
  kbFix: ReturnType<typeof useKbFixToggle>;
  openCron: () => void;
}

/** 通用：个人资料 / 语言 / 通知 / 版本与更新 */
function GeneralPage({ s }: { s: SettingsState }) {
  return (
    <>
      <ProfileSection draft={s.profile} busy={s.busy} />
      <LanguageSection />
      <PushSection push={s.push} />
      <BackendUpdateSection />
    </>
  );
}

/** 会话与自动化：归档保留 / 全体重启 ‖ 定时任务 / 记忆卫生 / 自动 Compact */
function SessionsPage({ s }: { s: SettingsState }) {
  const t = useT();
  return (
    <>
      <GroupLabel>{t("会话")}</GroupLabel>
      <ArchiveRetentionSection />
      <RestartAllSection />
      <GroupLabel>{t("自动化")}</GroupLabel>
      <Section
        title={t("定时任务")}
        aside={
          <button className="btn btn-sm" onClick={s.openCron}>
            {t("管理")}
          </button>
        }
        desc={t("到点起临时 agent 执行指令。查看/新建/原地编辑频率与指令/停用。")}
      />
      <MemoryHygieneSection hygiene={s.hygiene} />
      <AutoCompactSection autoCompact={s.autoCompact} />
    </>
  );
}

/** 连接与集成：手机访问 / App 服务器地址(仅原生壳) ‖ 语音识别 Key */
function ConnectPage({ s }: { s: SettingsState }) {
  const t = useT();
  return (
    <>
      <GroupLabel>{t("访问")}</GroupLabel>
      <RemoteAccessSection />
      {isNativeShell() && <ShellServerSection />}
      <GroupLabel>{t("集成")}</GroupLabel>
      <GroqKeySection groq={s.groq} busy={s.busy} />
    </>
  );
}

/** 安全：失败封禁 / 两步验证 / Passkey */
function SecurityPage({ s }: { s: SettingsState }) {
  const t = useT();
  return (
    <>
      <GroupLabel>{t("登录安全")}</GroupLabel>
      <BruteForceSection sec={s.sec} />
      <TotpSection />
      <PasskeySection />
    </>
  );
}

export function SettingsPage({ page, s }: { page: SettingsPageId; s: SettingsState }) {
  switch (page) {
    case "general":
      return <GeneralPage s={s} />;
    case "sessions":
      return <SessionsPage s={s} />;
    case "appearance":
      return (
        <>
          <AppearanceSection />
          <ThemeVarsSection />
          <FontSection />
        </>
      );
    case "connect":
      return <ConnectPage s={s} />;
    case "peers":
      return <PeersPanel />;
    case "security":
      return <SecurityPage s={s} />;
    case "labs":
      return (
        <>
          <KbFixSection kbFix={s.kbFix} />
          <DevModeSection />
        </>
      );
    case "claude":
      return <ClaudeDefaultsSection defaults={s.defaults} modelOptions={s.modelOptions} />;
  }
}
