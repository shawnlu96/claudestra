"use client";
import { useEffect, useState } from "react";
import { enablePush, disablePush, getPushSubscription } from "@/lib/push/client";
import { useT } from "@/lib/i18n";
import { Section } from "./section";
import { useSettingsFlag } from "./settings-flag";

/** Web Push(owner 2026-07-16):本设备订阅状态 + 这台电脑的「不带正文」开关 */
export function usePushToggle(open: boolean) {
  const noContent = useSettingsFlag("pushNoContent", open); // 整台电脑的「推送不带正文」（src/lib/push-redact.ts）
  const allAsks = useSettingsFlag("pushAllAsks", open); // 整台电脑的「全部待你处理都推」（src/lib/ask-push.ts）
  const [pushOn, setPushOn] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 本设备是否已订阅推送(看本地 pushManager,与服务端表无关——多设备各自管各自)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setPushMsg("");
    void getPushSubscription().then((sub) => setPushOn(!!sub));
  }, [open]);

  const togglePush = async () => {
    setPushBusy(true);
    setPushMsg("");
    const r = pushOn ? await disablePush() : await enablePush();
    if (r.ok) setPushOn(!pushOn);
    setPushMsg(r.msg);
    setPushBusy(false);
  };

  return { pushOn, pushMsg, pushBusy, togglePush, noContent, allAsks };
}

type PushState = ReturnType<typeof usePushToggle>;

/** 设置 · 通知 ·「这台设备」：本设备收不收推送。订阅存在本设备的 pushManager，换一台设备要各自打开 */
export function DevicePushSection({ push }: { push: PushState }) {
  const t = useT();
  const { pushOn, pushMsg, pushBusy, togglePush } = push;
  return (
    <Section
      title={t("推送通知")}
      aside={
        <input
          type="checkbox"
          className="toggle toggle-sm shrink-0"
          checked={pushOn}
          disabled={pushBusy}
          onChange={() => void togglePush()}
        />
      }
      desc={t("Web 端发起的对话有回复时,推送到本设备(页面开着时不打扰)。Discord 发起的照旧走 Discord @。")}
    >
      {pushMsg ? <div className="text-xs text-base-content/60">{t(pushMsg)}</div> : null}
    </Section>
  );
}

/**
 * 设置 · 通知 ·「这台电脑发出的所有推送」：存在这台电脑 config.json 里的两个开关，哪台设备上改都一样。
 * 「不带正文」连第三方渠道一起管；「全部待你处理都推」只管 Web Push / APNs，第三方渠道各有自己的同名开关（src/bridge/push/init.ts）。
 */
export function MachinePushSections({ push }: { push: PushState }) {
  const t = useT();
  const { noContent, allAsks } = push;
  return (
    <>
      <Section
        title={t("推送不带正文")}
        aside={
          <input
            type="checkbox"
            className="toggle toggle-sm shrink-0"
            checked={noContent.on === true}
            disabled={noContent.busy || noContent.on === null}
            onChange={() => void noContent.toggle()}
          />
        }
        desc={t("推送里看不到内容，点开才看得到：打开后，这台电脑发出的推送只写「有新消息」，不带 agent 名和消息内容，点开进会话列表。推送要经过中继和 Apple / Google 的推送服务，打开后它们看不到内容。对这台电脑配对的所有设备都生效。")}
      >
        {noContent.err ? <div className="text-xs text-error">{noContent.err}</div> : null}
      </Section>
      <Section
        title={t("全部待你处理都推")}
        aside={
          <input
            type="checkbox"
            className="toggle toggle-sm shrink-0"
            checked={allAsks.on === true}
            disabled={allAsks.busy || allAsks.on === null}
            onChange={() => void allAsks.toggle()}
          />
        }
        desc={t("你不在时，要你选择、授权、亲自去做的卡片都另推一条「待你处理」，不看有没有标「卡住工作」。回复本身已经推过一次，所以打开后带按钮的回复会响两次。对这台电脑配对的所有设备都生效；第三方渠道在各自的设置里另有同名开关。")}
      >
        {allAsks.err ? <div className="text-xs text-error">{allAsks.err}</div> : null}
      </Section>
    </>
  );
}
