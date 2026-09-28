"use client";
/**
 * 输入框 @ 补全的状态（composer 只接一行）：候选、选中项、已选目标、发送前复核。
 * 候选 = 本机其它在跑的 agent + 对方开放给我的 agent（contacts-data.ts；非全权设备只有本机）。
 * 目标只在选中那一刻记下（结构化：peer 带指纹），输入框里的「@标记」被删掉就自动作废，
 * 所以手打一个同名的 @ 不会触发委托，草稿恢复后也不会凭空变成委托。
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useT } from "@/lib/i18n";
import { mentionLabel, type MentionTarget } from "@/lib/chat/mention-directive";
import { useContacts } from "./contacts-data";
import { applyMention, isSlashText, localCandidates, matchMentions, mentionPresent, mentionQuery, peerCandidates, recheckMention, type MentionCandidate, type MentionQuery } from "./mention";
import { clampSel, handlePickerKey } from "./picker-keys";
import type { AgentSession } from "./type";

export interface MentionState {
  items: MentionCandidate[];
  open: boolean;
  sel: number;
  target: MentionTarget | null;
  error: string;
  pick: (c: MentionCandidate) => void;
  clear: () => void;
  /** 面板打开时接管导航键；true = 键已处理 */
  onKeyDown: (e: React.KeyboardEvent) => boolean;
  /** 发送前调用：null = 没有 @；false = 目标已失效（错误已显示，别发）；否则是复核过的目标 */
  prepare: (text: string) => MentionTarget | null | false;
}

interface Opts {
  text: string;
  setText: (v: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  active: string;
  agents: AgentSession[];
}

export function useMention({ text, setText, taRef, active, agents }: Opts): MentionState {
  const t = useT();
  const { contacts, allowed } = useContacts();
  const [q, setQ] = useState<MentionQuery | null>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // 记下是在哪个会话选的：切会话后自动失效（不用 effect 清，免得多渲染一轮）
  const [picked, setPicked] = useState<{ agent: string; target: MentionTarget } | null>(null);
  // 斜杠命令里 @ 不生效（isSlashText）：提示条随之消失，发出去就是普通命令
  const slash = isSlashText(text);
  const target = !slash && picked?.agent === active ? picked.target : null;
  const [error, setError] = useState("");
  useEffect(() => {
    const ta = taRef.current;
    // 光标不在输入框里（程序写入 / 刚发送）就按末尾算
    const caret = ta && document.activeElement === ta ? ta.selectionEnd : text.length;
    setQ(mentionQuery(text, caret));
    setSel(0);
    setDismissed(false);
    setError("");
    setPicked((cur) => (cur && !mentionPresent(text, mentionLabel(cur.target)) ? null : cur));
  }, [text, taRef]);
  const cands = useMemo(
    () => [...localCandidates(agents, active), ...(allowed ? peerCandidates(contacts) : [])],
    [agents, active, contacts, allowed],
  );
  // 第一期只允许一个目标：已有生效的 @ 就不再弹
  const items = target || slash || !q ? [] : matchMentions(cands, q.q);
  const open = !dismissed && items.length > 0;

  const pick = (c: MentionCandidate) => {
    if (!q) return;
    const next = applyMention(text, q, c);
    setText(next.text);
    setPicked({ agent: active, target: c.target });
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      try {
        ta.setSelectionRange(next.caret, next.caret);
      } catch {
        /* 选区设不上只影响光标位置，文字已经写进去了 */
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) =>
    open &&
    handlePickerKey(e, {
      move: (d) => setSel((v) => clampSel(v, d, items.length)),
      pick: () => pick(items[Math.min(sel, items.length - 1)]),
      close: () => setDismissed(true),
    });

  const prepare = (cur: string): MentionTarget | null | false => {
    if (!target || isSlashText(cur) || !mentionPresent(cur, mentionLabel(target))) return null;
    const r = recheckMention(target, contacts, agents);
    if (r.ok) return r.target;
    const name = mentionLabel(target);
    setError(r.reason === "stopped" ? t("{name} 已经停止，没法转达", { name }) : t("{name} 已不在可联系的列表里（可能已撤销或改名），重新 @ 一次", { name }));
    return false;
  };

  return { items, open, sel, target, error, pick, clear: () => setPicked(null), onKeyDown, prepare };
}
