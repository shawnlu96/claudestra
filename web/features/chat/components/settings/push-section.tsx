"use client";
import { useEffect, useState } from "react";
import { enablePush, disablePush, getPushSubscription } from "@/lib/push/client";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/** Web Push(owner 2026-07-16):本设备订阅状态 */
export function usePushToggle(open: boolean) {
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

  return { pushOn, pushMsg, pushBusy, togglePush };
}

export function PushSection({ push }: { push: ReturnType<typeof usePushToggle> }) {
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
