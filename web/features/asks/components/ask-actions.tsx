"use client";
import { useState } from "react";
import { answerAskCard } from "@/lib/api/asks";
import { answerAuq, answerPermission } from "@/lib/api/chat";
import { ApiError } from "@/lib/api/client";
import type { WebComponentRow } from "@/lib/chat/events";
import { useT } from "@/lib/i18n";
import { answeredGroups, rowGroup, wireLabels, type WebAsk } from "../asks-model";
import { asksStore } from "../asks-store";
import { AuqChoices, PermissionChoices, ReplyChoices } from "./ask-choices";
import { TerminalIcon } from "./ask-icons";

/**
 * 一张开着的「待你处理」卡的作答区（ask-card.tsx）：reply / 人发起的是按钮行 + 文本框（答不了的凭据只给一句说明），
 * AUQ / 权限走原有的按键端点，Codex 弹框只能去终端。作答一律乐观（asks-store.answer）。
 */
export function AskActions({ ask, agent }: { ask: WebAsk; agent: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const canAnswer = ask.canAnswer !== false;
  // 运行时弹框（AUQ / 权限）一定是某个 agent 卡住的：按键端点按 agent 名走
  const dialogAgent = ask.fromAgent ?? "";
  const runtime = ask.source === "auq" || ask.source === "permission" || ask.source === "codex";

  // 409 分两种：多行里这一项刚在聊天 / Discord 里答过（其余行还能答，重拉后卡片会收掉它），其余都当整条已结案——
  // 弹框端点的 409（弹框已经没了）不带 code，也归这一类，别把英文原文露给 owner
  // 没到 bridge（断网、中继断了）：别把浏览器的英文原文露给 owner
  const fail = (e: unknown) => {
    if (!(e instanceof ApiError)) return t("没发出去（连不上），再点一次");
    if (e.status !== 409) return e.message;
    return e.code === "ask_part_answered" ? t("这一项刚在别处答过了，已刷新，剩下的还能答") : t("这件已经处理过了（或已过期）");
  };
  const ok = runtime ? t("已提交给弹框") : t("已发给 {agent}，它忙完手上这一步就会看到", { agent });
  // 乐观作答（T11b 第 8 条）：点下去卡片就移到「最近处理过」、计数减 1；失败回到「等你处理」并显示原因（asks-store.answer）
  const run = async (fn: () => Promise<unknown>, labels: string[], text = "") => {
    setBusy(true);
    await asksStore.answer(ask.id, { choices: [], labels, text, via: "web_card", at: Date.now() }, fn, { ok, fail });
    setBusy(false);
  };
  // 多行 reply 在聊天 / Discord 里已答过的组不再给选（bridge 会回「这一项已经答过了」），已答内容在下面「已答：…」那行
  const all = ask.options as WebComponentRow[];
  const done = answeredGroups(all, ask.answer?.choices ?? []);
  const rows = all.filter((r, ri) => !done.has(rowGroup(r, ri)));
  // 权限弹框：按原有端点发键，是谁、选了什么由那个端点当场记进这条 ask
  const pickPermission = (action: string) => run(() => answerPermission(dialogAgent, action), wireLabels(rows, [`[button:${action}]`]));
  const auqLabels = (sel: number[][]) => (ask.options as { options?: { label: string }[] }[]).flatMap((q, qi) => sel[qi]?.map((oi) => q.options?.[oi]?.label ?? "") ?? []).filter(Boolean);

  return (
    <div className="mt-3">
      {!runtime && !canAnswer && <p className="text-[13px] opacity-75">{t("这个登录凭据只能看，作答要在 owner 本人的设备上")}</p>}
      {!runtime && canAnswer && (
        <ReplyChoices
          rows={rows}
          allowText={ask.allowText}
          busy={busy}
          onAnswer={(choices, text) => run(() => answerAskCard(ask.project, ask.id, { choices, text }), wireLabels(rows, choices), text)}
        />
      )}
      {ask.source === "auq" && (
        <AuqChoices
          questions={ask.options as never[]}
          busy={busy}
          onSubmit={(sel) => run(() => answerAuq(dialogAgent, "submit", sel), auqLabels(sel))}
          onCancel={() => run(() => answerAuq(dialogAgent, "cancel"), [t("取消")])}
        />
      )}
      {ask.source === "permission" && (
        <PermissionChoices rows={rows} busy={busy} onPick={pickPermission} />
      )}
      {ask.source === "codex" && (
        <p className="flex items-center gap-1.5 text-[13px] opacity-75">
          <TerminalIcon />
          {t("这个弹框要到终端里处理")}
        </p>
      )}
    </div>
  );
}
