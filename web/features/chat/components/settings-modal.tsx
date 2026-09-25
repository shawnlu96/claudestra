"use client";
import { useState } from "react";
import { CenteredModal } from "./centered-modal";
import { useT } from "@/lib/i18n";
import { useClaudeModels } from "../claude-models";
import { CronModal } from "./cron-modal";
import { useProfileDraft } from "./settings/profile-section";
import { useGroqKey } from "./settings/groq-key-section";
import { useClaudeDefaults } from "./settings/claude-defaults-section";
import { usePushToggle } from "./settings/push-section";
import { useBruteForce } from "./settings/brute-force-section";
import { useMemoryHygiene } from "./settings/memory-hygiene-section";
import { useAutoCompact } from "./settings/auto-compact-section";
import { useKbFixToggle } from "./settings/interface-sections";
import { SettingsNav, type SettingsPageId } from "./settings/nav";
import { SettingsPage } from "./settings/pages";

/**
 * 全局设置弹窗（侧栏 ⚙️ 进入）。portal 到 body（规则 5.5）。
 * 布局(owner 2026-09-25)：加宽的弹窗，左栏是 icon+文字的七项菜单(./settings/nav.tsx)，右侧
 * 只渲染当前页(./settings/pages.tsx)；页内再用 GroupLabel 分组。手机上左栏变成标题下的横向菜单条。
 *
 * ⚠ 带状态的分区（资料 / 语音 Key / 全局默认 / 推送 / 失败封禁 / 记忆卫生 / 自动 Compact）
 * 的状态由这里调用各自的 useXxx(open) 持有，而不是分区组件自己持有：SettingsModal 关着时
 * 也挂载（下面 `if (!open) return null`），状态跨开关保留、打开时重置 + 拉取——改成分区自管
 * (随打开/切页挂载)会让重开或切页时先闪默认值。hook 的调用顺序 = 拆分前那个打开 effect 里的
 * 请求顺序，别随手调换。
 *
 * initialPage：外部入口直达某一页(侧栏 Peer 按钮 → "peers")；用户在弹窗里切页后以切的为准，关闭即忘。
 */
export function SettingsModal({
  open,
  onClose,
  initialPage = "general",
}: {
  open: boolean;
  onClose: () => void;
  initialPage?: SettingsPageId;
}) {
  const modelOptions = useClaudeModels();
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
  // 定时任务管理(owner 2026-08-26):独立弹窗
  const [showCron, setShowCron] = useState(false);
  // null = 还没在弹窗里切过页 → 显示入口指定的 initialPage；关闭清掉，下次打开重新听入口的
  const [picked, setPicked] = useState<SettingsPageId | null>(null);
  const page = picked ?? initialPage;
  const close = () => {
    onClose();
    setPicked(null);
  };

  if (!open) return null;

  const state = {
    busy, profile, groq, defaults, modelOptions, push, sec, hygiene, autoCompact, kbFix,
    openCron: () => setShowCron(true),
  };

  // portal 到 body（规则 5b）+ 手机上不歪的列宽修正，都在 CenteredModal 里
  return (
    <>
      <CenteredModal onClose={close} layer="base" wide>
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("设置")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={close}>
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <SettingsNav page={page} onSelect={setPicked} />
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-3">
            <SettingsPage page={page} s={state} />
          </div>
        </div>
      </CenteredModal>
      <CronModal open={showCron} onClose={() => setShowCron(false)} />
    </>
  );
}
