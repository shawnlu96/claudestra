/**
 * TTY 窗口里 agent 正文的流式续写（tty-screen.ts 用；非 TTY 不走这里，照旧整条一段）。
 * 只吐攒齐的整行：半行可能是半个密钥，规则认不出。有的规则会跨行（BEARER_RE 的 \s+ 把「token\n长串」并成一行，
 * 认证头 / KV 的 \s* 会越过行尾），所以每次再假设下一行是个长串（PROBE）打一遍码，前面会跟着变的行先压着。
 * 每次把攒到的整行连同前文整段打码、按 transcript.ts clipText 的上限逐行放出；超上限就停（不再攒原文），剩下的等终稿。
 * 终稿（宿主按消息攒好的那条 ● 段）到了：和已放出的行逐行对上就只补没显示的部分，对不上（规则在长文里结果不同）
 * 退回整段重新显示——宁可重复一段，也不让窗口里留着和终稿不一样的字。tests/acp-transcript-stream.test.ts。
 */
import { redactSecrets } from "../redact-secrets.js";
import { BULLET, INDENT, TEXT_LIMITS } from "./transcript.js";

type Rec = Record<string, any>;

/** 满足所有值规则字符集的长串：接在后面能让任何可跨行的规则越过行尾 */
const PROBE = "A".repeat(64);
const NOTE = /^…（共 \d+ 行）$/;
const redacted = (s: string): string => redactSecrets(s).trimStart();

/** 正文段第 i 行在窗口里的样子：与 transcript.ts 的 ● 段同一规则（续行缩进、空行不补空格） */
const lineOf = (i: number, l: string): string => (i ? (l ? `${INDENT}${l}` : "") : `${BULLET}${l}`);

export interface TextStream {
  /** 一条 session/update：正文增量就返回新攒齐的行（首行带 ●，续行缩进），别的返回 [] */
  chunk(update: unknown): string[];
  /** 一段要进窗口的内容 → 实际该显示的段：流着的正文终稿只补没显示的部分（可能是 []），其余原样 */
  settle(item: string): string[];
}

export function createTextStream(): TextStream {
  let open = false, id: unknown, raw = "", shown: string[] = [], chars = 0, full = false;
  const reset = (next: unknown) => ((open = true), (id = next), (raw = ""), (shown = []), (chars = 0), (full = false));

  return {
    chunk(update) {
      const u = update as Rec | null;
      if (u?.sessionUpdate !== "agent_message_chunk" || u.content?.type !== "text" || typeof u.content.text !== "string") return [];
      if (!open || u.messageId !== id) reset(u.messageId);
      if (full) return [];
      raw += u.content.text;
      // 超过扫描窗口就不攒了：剩下的全交给终稿（clip 也只扫这么多），后面再长的输出每块都是 O(1)
      if (raw.length > TEXT_LIMITS.scan) return ((full = true), (raw = ""), []);
      const cut = raw.lastIndexOf("\n");
      const body = cut < 0 ? "" : redacted(raw.slice(0, cut));
      if (!body) return [];
      const lines = body.split("\n");
      const probe = redacted(`${raw.slice(0, cut)}\n${PROBE}`).split("\n");
      const moved = lines.findIndex((l, i) => probe[i] !== l); // 下一行来了会被跨行规则改掉的第一行
      // 终稿只剪整条消息首尾的空白：一行后面还有字，它的行尾空格（Markdown 硬换行）才算定了；末尾的空白行同理压着
      const settled = /\S/.test(raw.slice(cut + 1)) ? lines.length : Math.max(0, lines.findLastIndex((l) => /\S/.test(l)));
      const ready = moved < 0 ? settled : Math.min(moved, settled);
      const out: string[] = [];
      for (const line of lines.slice(shown.length, ready)) {
        const add = (shown.length ? 1 : 0) + line.length;
        if (shown.length >= TEXT_LIMITS.lines || chars + add > TEXT_LIMITS.chars) return ((full = true), (raw = ""), out);
        out.push(lineOf(shown.length, line));
        shown.push(line);
        chars += add;
      }
      return out;
    },
    settle(item) {
      if (!open || !item.startsWith(BULLET)) return [item];
      open = false; // 宿主按消息攒好的正文总在别的 ● 段之前吐出（updates.ts flushText），所以流着时来的第一个 ● 段就是终稿
      if (!shown.length) return [item];
      const lines = item.split("\n");
      const want = shown.map((l, i) => lineOf(i, l));
      const last = want.length - 1;
      if (lines.length < want.length || want.some((w, i) => (i < last ? lines[i] !== w : !lines[i]!.startsWith(w)))) return [item];
      const tail = lines[last]!.slice(want[last]!.length); // 截断注记接在最后一行后面（clip 的「…（共 N 行）」）；别的字 = 和终稿不一样
      if (tail && !NOTE.test(tail)) return [item];
      const rest = [...(tail ? [`${INDENT}${tail}`] : []), ...lines.slice(want.length)];
      return rest.length ? [rest.join("\n")] : [];
    },
  };
}
