/**
 * ASKSCOPE3 PM 定 3「整段删掉的 describe( / test( / it( 块」：按调用结构数，不按行。
 * 每个块 = 一次 describe / test / it 调用（含 .skip / .each(...) 等修饰链），一行几个、嵌套、前面有别的语句都各算一个；
 * base 的块在 head 里能对上（原样、或同修饰链同标题、或同修饰链同函数体）就算保留——只改标题 / 只改体内断言都不算删块。
 * 只读 Git blob 文本，不执行任何代码。tests/order-ask-test-scope-size.test.ts。
 */
import { stripComments } from "./skip-effects-auto-scope-scan.js";

const BLOCK_NAMES = new Set(["describe", "test", "it"]);
const REGEX_AFTER = /^(?:[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|of|in|instanceof|new|delete|void|yield|await|throw|else|do)$/;

/** Code tokens; a string / template / regex literal is one token (template `${}` contents are not code for this purpose). */
function tokens(src: string): string[] {
  const text = stripComments(src), out: string[] = [];
  let i = 0;
  const skipTemplate = (): void => { // i at the opening backtick → after the closing one
    i++;
    while (i < text.length && text[i] !== "`") {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "$" && text[i + 1] === "{") {
        i += 2;
        for (let depth = 1; i < text.length && depth > 0;) {
          const c = text[i]!;
          if (c === "`") { skipTemplate(); continue; }
          if (c === '"' || c === "'") { skipQuoted(c); continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          i++;
        }
        continue;
      }
      i++;
    }
    i++;
  };
  const skipQuoted = (q: string): void => {
    i++;
    while (i < text.length && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  while (i < text.length) {
    const c = text[i]!, start = i;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") skipQuoted(c);
    else if (c === "`") skipTemplate();
    else if (c === "/" && (!out.length || REGEX_AFTER.test(out[out.length - 1]!))) {
      let cls = false;
      for (i++; i < text.length && text[i] !== "\n" && (cls || text[i] !== "/"); i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") cls = true;
        else if (text[i] === "]") cls = false;
      }
      for (i++; /[\w$]/.test(text[i] ?? ""); i++);
    } else if (/[\w$]/.test(c)) { while (/[\w$]/.test(text[i] ?? "")) i++; }
    else i++;
    out.push(text.slice(start, i));
  }
  return out;
}

interface TestBlock { callee: string; title: string; body: string }

/** Every describe / test / it call, nested ones included; the block's own call is the last call of its modifier chain. */
function testBlocks(src: string): TestBlock[] {
  const t = tokens(src), out: TestBlock[] = [];
  const close = (open: number): number => { // index of the bracket matching t[open]
    for (let j = open, depth = 0; j < t.length; j++) {
      if (t[j] === "(" || t[j] === "[" || t[j] === "{") depth++;
      else if (t[j] === ")" || t[j] === "]" || t[j] === "}") { if (--depth === 0) return j; }
    }
    return -1;
  };
  for (let i = 0; i < t.length; i++) {
    if (!BLOCK_NAMES.has(t[i]!) || (i > 0 && (t[i - 1] === "." || t[i - 1] === "function"))) continue;
    let j = i + 1, call: [number, number] | null = null;
    for (;;) {
      if (t[j] === "." && /^[A-Za-z_$]/.test(t[j + 1] ?? "")) { j += 2; call = null; continue; }
      if (t[j] !== "(") break;
      const end = close(j);
      if (end < 0) break;
      call = [j, end]; j = end + 1;
    }
    if (!call) continue;
    const [open, end] = call, args = t.slice(open + 1, end);
    let comma = args.length;
    for (let k = 0, depth = 0; k < args.length; k++) {
      if (/^[([{]$/.test(args[k]!)) depth++;
      else if (/^[)\]}]$/.test(args[k]!)) depth--;
      else if (args[k] === "," && depth === 0) { comma = k; break; }
    }
    out.push({ callee: t.slice(i, open).join(" "), title: args.slice(0, comma).join(" "), body: args.slice(comma).join(" ") });
  }
  return out;
}

/** Base blocks with no counterpart at head: matched exactly first, then by same chain + title, then same chain + body. */
export function removedTestBlocks(base: string, head: string): number {
  let left = testBlocks(base), pool = testBlocks(head);
  for (const key of [(b: TestBlock) => `${b.callee}\0${b.title}\0${b.body}`, (b: TestBlock) => `${b.callee}\0${b.title}`, (b: TestBlock) => `${b.callee}\0${b.body}`]) {
    const avail = new Map<string, number>();
    for (const b of pool) avail.set(key(b), (avail.get(key(b)) ?? 0) + 1);
    const matched = new Map<string, number>();
    left = left.filter((b) => {
      const k = key(b), n = avail.get(k) ?? 0;
      if (!n) return true;
      avail.set(k, n - 1); matched.set(k, (matched.get(k) ?? 0) + 1);
      return false;
    });
    pool = pool.filter((b) => { const n = matched.get(key(b)) ?? 0; if (!n) return true; matched.set(key(b), n - 1); return false; });
  }
  return left.length;
}
