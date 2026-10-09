// Frozen pre-N8A7 field parser, used only as an independent differential oracle.
/**
 * 按敏感字段名脱敏整段值（T48 P1-2，dispatch-redact.ts 先跑这一遍）：字段名以 token / password / secret / api_key / authorization /
 * credential / private_key 结尾（大小写、驼峰、前缀都算：outToken、BRIDGE_CONTROL_TOKEN、x-api-key），或者就叫 key。
 * 写法覆盖 JSON（"token": "…"）、YAML / 纯文本（token: …、块标量 |、>）、key=value、命令行 --token …；
 * 值跨行（引号没在本行关上、块标量、缩进续行）也整段遮掉。值是 32 位十六进制也照遮——git sha 不带敏感字段名，不受影响。
 * ctxTokens、maxTokens、tokenCount 这类不以敏感词结尾的字段不动。纯函数，tests/dispatch-order.test.ts。
 */

const SENSITIVE = String.raw`(?:[\w.-]*?(?:token|password|passwd|secret|api[_-]?key|apikey|authorization|credential|private[_-]?key)|key)`;
/** 字段在行首或分隔符之后，可带引号，后面跟 : 或 = */
const KEY_RE = new RegExp(String.raw`(^|[\s{,;(\[?&])(["']?)(${SENSITIVE})\2\s*([:=])[ \t]*`, "gi");
const FLAG_RE = /(--[\w-]*?(?:token|password|secret|api-key|apikey))(\s+|=)(?!\[已脱敏)(\S+)/gi;

const indentOf = (s: string): number => s.match(/^[ \t]*/)![0].length;

/** 引号里的值：从 from 起找没被转义的同一种引号；找不到返回 -1 */
function closingQuote(s: string, from: number, q: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

export function legacyRedactFields(text: string, placeholder: string): { text: string; count: number } {
  const lines = text.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    const indent = indentOf(line);
    KEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEY_RE.exec(line))) {
      const start = m.index + m[0].length;
      const rest = line.slice(start);
      if (rest.startsWith(placeholder)) continue;
      const q = rest[0];
      if (q === '"' || q === "'") {
        const close = closingQuote(line, start + 1, q);
        if (close >= 0) {
          line = `${line.slice(0, start + 1)}${placeholder}${line.slice(close)}`;
        } else {
          // 引号没在本行关上：本行余下全遮，往下找到关上的那一行为止
          line = `${line.slice(0, start + 1)}${placeholder}`;
          for (let j = i + 1; j < lines.length; j++) {
            const c = closingQuote(lines[j]!, 0, q);
            lines[j] = c >= 0 ? `${lines[j]!.slice(0, indentOf(lines[j]!))}${lines[j]!.slice(c)}` : lines[j]!.slice(0, indentOf(lines[j]!));
            if (c >= 0) break;
          }
        }
        count++;
        KEY_RE.lastIndex = start + 1 + placeholder.length + 1;
        continue;
      }
      const block = rest.trim() === "" || /^[|>][+-]?\s*$/.test(rest);
      if (!block) {
        const end = m[4] === "=" ? start + rest.search(/[&\s#;]|$/) : start + rest.replace(/[,;}\]\s]+$/, "").length;
        line = `${line.slice(0, start)}${placeholder}${line.slice(end)}`;
        count++;
        KEY_RE.lastIndex = start + placeholder.length;
        if (m[4] === "=") continue; // a=1&token=x&secret=y：同一行可能还有别的字段
      } else {
        count++;
      }
      // 块标量或折行：往下更深缩进、又不是新字段的行都算这个值
      if (m[4] === ":" && (block || KEY_RE.lastIndex >= line.length)) {
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j]!;
          if (l.trim() === "") continue;
          if (indentOf(l) <= indent || (!block && /^\s*["']?[\w.-]+["']?\s*:/.test(l))) break;
          lines[j] = `${l.slice(0, indentOf(l))}${placeholder}`;
        }
      }
      break; // 一行里块值 / 行尾值之后不会再有字段；引号值的情况已在上面 continue
    }
    lines[i] = line;
  }
  let out = lines.join("\n");
  out = out.replace(FLAG_RE, (_m, flag: string, sep: string) => (count++, `${flag}${sep}${placeholder}`));
  return { text: out, count };
}
