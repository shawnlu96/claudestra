"use client";
import { useT } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";
import { RemoteAccessSection } from "../remote-access-section";
import { AccessPathsSection } from "../access-paths";
import { PeersPanel } from "../peers-modal";
import { BorrowPanel } from "@/features/borrow/borrow-panel";
import { Section, GroupLabel } from "./section";
import { DevicesSection, MachinesSection, SelfDeviceSection } from "./devices-section";
import { ShellServerSection } from "./shell-server-section";
import { ArchiveRetentionSection } from "./archive-retention-section";
import { QuotaLiveSection } from "./quota-live-section";
import { BackendUpdateSection } from "./backend-update-section";
import { RestartAllSection } from "./restart-all-section";
import { useProfileDraft, ProfileSection } from "./profile-section";
import { useGroqKey, GroqKeySection } from "./groq-key-section";
import { useClaudeDefaults, ClaudeDefaultsSection } from "./claude-defaults-section";
import { usePushToggle, PushSection } from "./push-section";
import { useMemoryHygiene, MemoryHygieneSection } from "./memory-hygiene-section";
import { useAutoCompact, AutoCompactSection } from "./auto-compact-section";
import { AppearanceSection, LanguageSection, useKbFixToggle, KbFixSection, DevModeSection } from "./interface-sections";
import { ThemeVarsSection } from "./theme-vars-section";
import { TalkToggleSection } from "./talk-toggle-section";
import { FontSection } from "./font-section";
import { ChatPrefsSection } from "./chat-prefs-section";
import { SkillsSection } from "./skills-section";
import type { SettingsPageId } from "./nav";

/**
 * 设置弹窗的八个页面(菜单在 ./nav.tsx)。带状态的分区其状态仍由 SettingsModal 的 useXxx(open)
 * 持有并经 `state` 传进来——页面切换只是分区组件的挂载/卸载，不碰数据；自管状态的分区
 * (设备 / 归档保留 / 后端版本 / 全体重启 / 服务器地址 / 手机访问 / Peer 协作)本来就随挂载拉取。
 * full=false（guest / 部分 scope）：要全权的分区不渲染——整页都要全权的页在 nav.settingsPagesFor 里就滤掉了。
 */
export interface SettingsState {
  busy: boolean;
  full: boolean;
  profile: ReturnType<typeof useProfileDraft>;
  groq: ReturnType<typeof useGroqKey>;
  defaults: ReturnType<typeof useClaudeDefaults>;
  modelOptions: Parameters<typeof ClaudeDefaultsSection>[0]["modelOptions"];
  push: ReturnType<typeof usePushToggle>;
  hygiene: ReturnType<typeof useMemoryHygiene>;
  autoCompact: ReturnType<typeof useAutoCompact>;
  kbFix: ReturnType<typeof useKbFixToggle>;
  openCron: () => void;
}

/** 通用：App 服务器地址（仅原生壳）/ 个人资料 / 语言 / 通知 / 版本与更新 */
function GeneralPage({ s }: { s: SettingsState }) {
  return (
    <>
      {isNativeShell() && <ShellServerSection />}
      {s.full && <ProfileSection draft={s.profile} busy={s.busy} />}
      <LanguageSection />
      {s.full && <PushSection push={s.push} />}
      {s.full && <BackendUpdateSection />}
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

/** 连接与集成：手机访问 ‖ 语音识别 Key / 订阅额度实时读取（App 服务器地址在「通用」页顶部） */
function ConnectPage({ s }: { s: SettingsState }) {
  const t = useT();
  return (
    <>
      <GroupLabel>{t("访问")}</GroupLabel>
      {s.full && <AccessPathsSection />}
      {s.full && <RemoteAccessSection />}
      {s.full && (
        <>
          <GroupLabel>{t("集成")}</GroupLabel>
          <GroqKeySection groq={s.groq} busy={s.busy} />
          <QuotaLiveSection />
        </>
      )}
    </>
  );
}

/** 设备：这台机器上已配对的设备（撤销 / 退出登录，要全权；别的设备只有本设备的退出登录）+ 本浏览器配对过的机器 */
function DevicesPage({ s }: { s: SettingsState }) {
  return (
    <>
      {s.full ? <DevicesSection /> : <SelfDeviceSection />}
      <MachinesSection />
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
          <ChatPrefsSection />
        </>
      );
    case "connect":
      return <ConnectPage s={s} />;
    case "peers":
      return (
        <>
          <PeersPanel />
          <BorrowPanel />
        </>
      );
    case "security":
      return <DevicesPage s={s} />;
    case "skills":
      return <SkillsSection />;
    case "labs":
      return (
        <>
          <TalkToggleSection />
          <KbFixSection kbFix={s.kbFix} />
          <DevModeSection />
        </>
      );
    case "claude":
      return <ClaudeDefaultsSection defaults={s.defaults} modelOptions={s.modelOptions} />;
  }
}
