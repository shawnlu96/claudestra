"use client";
import { useEffect, useState } from "react";
import { useChatStoreApi } from "../../chat-store";
import { useT } from "@/lib/i18n";
import { AvatarNickRow } from "./avatar-nick-row";
import { Section } from "./section";

/**
 * 保存中标志：「保存资料」与「语音 Key 保存/清除」共用同一个 busy——任一个在存，
 * 两处按钮都禁用（拆文件前就是一个 useState，原样保留）。状态挂在 SettingsModal 上。
 */
export interface SharedBusy {
  busy: boolean;
  setBusy: (v: boolean) => void;
}

/**
 * 个人资料草稿（打开时从 store 取当前值,保存才写回）:我的 + Claude 的。
 * ⚠ 状态必须由 SettingsModal 调用本 hook 持有（弹窗关掉时 SettingsModal 仍挂载），
 * 打开时的重置与读取才跟拆分前一致。
 */
export function useProfileDraft(open: boolean, { setBusy }: SharedBusy) {
  const store = useChatStoreApi();
  const [nick, setNick] = useState("");
  const [avatar, setAvatar] = useState("");
  const [cNick, setCNick] = useState("");
  const [cAvatar, setCAvatar] = useState("");
  const [profileMsg, setProfileMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setProfileMsg("");
    const p = store.state.profile;
    setNick(p.nickname);
    setAvatar(p.avatar);
    setCNick(p.claudeNickname);
    setCAvatar(p.claudeAvatar);
  }, [open, store]);

  const saveProfile = async () => {
    setBusy(true);
    setProfileMsg("");
    const ok = await store.saveProfile({
      nickname: nick.trim(),
      avatar,
      claudeNickname: cNick.trim(),
      claudeAvatar: cAvatar,
    });
    setProfileMsg(ok ? "已保存" : "保存失败");
    setBusy(false);
  };

  return {
    nick, setNick, avatar, setAvatar, cNick, setCNick, cAvatar, setCAvatar,
    profileMsg, setProfileMsg, saveProfile,
  };
}

export function ProfileSection({
  draft,
  busy,
}: {
  draft: ReturnType<typeof useProfileDraft>;
  busy: boolean;
}) {
  const t = useT();
  const { nick, setNick, avatar, setAvatar, cNick, setCNick, cAvatar, setCAvatar, profileMsg, setProfileMsg, saveProfile } = draft;
  return (
        <Section
          title={t("个人资料")}
          desc={t("头像和昵称显示在对话里（只影响本界面展示,不进对话数据）。")}
        >
        <AvatarNickRow
          label={t("我")}
          fallback="👤"
          avatar={avatar}
          nick={nick}
          nickPlaceholder={t("你的昵称")}
          onAvatar={setAvatar}
          onNick={setNick}
          onError={() => setProfileMsg("图片读取失败")}
        />
        <AvatarNickRow
          label="Claude"
          fallback="✦"
          avatar={cAvatar}
          nick={cNick}
          nickPlaceholder={t("Claude 的名称")}
          onAvatar={setCAvatar}
          onNick={setCNick}
          onError={() => setProfileMsg("图片读取失败")}
        />
        <div className="mt-3 flex items-center justify-end gap-2.5">
          {profileMsg && <span className="text-xs text-base-content/60">{t(profileMsg)}</span>}
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveProfile()}>
            {t("保存资料")}
          </button>
        </div>
        </Section>
  );
}
