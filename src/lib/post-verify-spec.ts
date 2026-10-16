/**
 * 规格卡 `## 上线后 PM` 一节的读取与解析：小节正文、首行「观察期：N 小时」。
 * 叶子模块（只依赖 fs / paths）：台账读侧（ledger-attention-facts.ts）也要用，而调度侧的 scheduler-post-verify-ledger.ts /
 * scheduler-post-verify-defer.ts 经 scheduler-autostart 运行时可达 ledger-read.ts，直接从那边 import 会成环；两边都从这里取。
 * tests/scheduler-post-verify-defer.test.ts、tests/spec-lint-observation.test.ts。
 */
import { readFileSync, statSync } from "node:fs";
import { statePath } from "./paths.js";
import type { SpecFile } from "./scheduler-autostart.js";

export const POST_VERIFY_DEFER_MAX_HOURS = 168;
const OBSERVATION_RE = /^观察期\s*[:：]\s*(\d+)\s*小时$/;
const POST_VERIFY_HEADING = "## 上线后 PM";

export interface Observation { hours: number; capped: boolean }

/** 规格卡正式路径（与自动开卡 specGate 同一路径：scheduler-autostart-deps.ts autostartSpecPath） */
export function readPostVerifySpec(taskId: string): SpecFile | null {
  const path = statePath("ledger", "docs", "tasks", `${taskId}.md`);
  try {
    return { mtimeMs: statSync(path).mtimeMs, text: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}

/** CommonMark 围栏：≤3 空格缩进、≥3 个同字符；反引号围栏的 info 不许含反引号 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `## 上线后 PM` 一级小节正文（到下一个 `#` / `##` 标题为止）；从头按代码围栏状态扫，代码块里的同名标题 / `#` 行都不算标题；没有该节或正文为空 → null。
 * 围栏记开围栏的字符与长度：只有同字符、不短于开围栏、后面只有空白的行才关块（四反引号块里的 ``` 、反引号块里的 ~~~ 都是正文）；没关的围栏到文末。
 */
export function postVerifySection(text: string | null | undefined): string | null {
  if (!text) return null;
  let fence: { ch: string; len: number } | null = null, body: string[] | null = null;
  for (const l of text.split(/\r?\n/)) {
    if (fence) {
      const m = /^ {0,3}(`+|~+)\s*$/.exec(l);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
    } else {
      const m = FENCE_OPEN.exec(l);
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { ch: m[1][0], len: m[1].length };
      else if (body === null && l.trimEnd() === POST_VERIFY_HEADING) {
        body = [];
        continue;
      } else if (body && /^#{1,2}\s/.test(l)) break;
    }
    body?.push(l);
  }
  const out = body?.join("\n").trim();
  return out || null;
}

/** written：规格里写的原数（封顶前），只用于说明文字 */
export function observe(section: string | null | undefined): (Observation & { written: string }) | "bad" | null {
  if (!section) return null;
  const line = section.split(/\r?\n/)[0].trim();
  if (!line.includes("观察期")) return null;
  const m = OBSERVATION_RE.exec(line);
  const n = m ? Number(m[1]) : 0;
  if (!(n >= 1)) return "bad";
  return { hours: Math.min(n, POST_VERIFY_DEFER_MAX_HOURS), capped: n > POST_VERIFY_DEFER_MAX_HOURS, written: m![1] };
}

/** 该节第一行的观察期：认出 → { hours（已封顶）, capped }；含「观察期」但格式不对 → "bad"；第一行没写 → null */
export function parseObservation(section: string | null | undefined): Observation | "bad" | null {
  const o = observe(section);
  return o === null || o === "bad" ? o : { hours: o.hours, capped: o.capped };
}
