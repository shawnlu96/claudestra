/** 试点证据专用：只剥开明确的 ssh 调用；不明选项仍按可能修改计，避免放过本地命令或转发。 */
import { isReadOnlyBash } from "./shell-readonly.js";
import { parseShell } from "./shell-words.js";

const FLAGS = new Set("46nqTtv");
const WITH_VALUE = new Set("plio");
// 只接受连接参数；其余 -o 可能设置转发、执行本地命令或替换远程命令。
const CONNECTION_OPTION = /^(?:BatchMode|ConnectTimeout|ConnectionAttempts|ServerAliveInterval|ServerAliveCountMax|StrictHostKeyChecking)\s*(?:=|\s)\s*[\w-]+$/i;

/** 已分词的 ssh 选项；返回 host 下标，未知 / 不完整选项返回 null。 */
function hostIndex(words: string[]): number | null {
  let i = 1;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    const option = words[i];
    if (option === "--") return i + 1;
    if (option === "-" || option.startsWith("--")) return null;
    for (let j = 1; j < option.length; j++) {
      const flag = option[j];
      if (FLAGS.has(flag)) continue;
      if (!WITH_VALUE.has(flag)) return null;
      const value = option.slice(j + 1) || words[++i];
      if (!value || value.startsWith("-") || (flag === "o" && !CONNECTION_OPTION.test(value))) return null;
      break;
    }
  }
  return i;
}

export function isReadOnlySentinelSsh(command: string): boolean {
  const local = parseShell(command);
  if (local.broken || local.substitution || local.structural || local.segments.length !== 1) return false;
  const segment = local.segments[0];
  if (segment.dynamic || segment.redirects.length || segment.words[0] !== "ssh") return false;
  const i = hostIndex(segment.words);
  if (i === null || !segment.words[i] || segment.words[i].startsWith("-")) return false;
  // ssh 会把远程 argv 用空格连接后交给远端 shell；不能逐个参数判只读。
  const remote = segment.words.slice(i + 1).join(" ");
  const parsed = parseShell(remote);
  if (parsed.segments.some((s) => s.dynamic || s.redirects.some((r) => r.op !== "<"))) return false;
  return isReadOnlyBash(remote);
}
