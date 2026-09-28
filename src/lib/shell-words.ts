/**
 * 最小的 shell 分词（tests/shell-words.test.ts）：把一条命令切成「段」（按 && || ; | & 换行），每段是去掉引号后的词和重定向。
 * 只为「这条命令会不会写东西」服务（lib/autopilot-tools.ts），不是完整的 shell 解析；认不出的写法宁可报成「看不清」：
 * - substitution：$(...) / `...` / <(...) / >(...)，包括藏在算术 $((…)) / $[…] 和不带引号的 heredoc 正文里的
 * - structural：没加引号的 ( ) 或单独的 { }（函数定义、子 shell、zsh 的 =(…) / *(e:…:)），调用方整条按写算
 * - 段的 dynamic：参数里有运行时才知道值的东西（$X、${…}、$'…'、$"…"、带逗号的花括号展开），看标志位的命令据此按写算
 * - broken：引号 / 括号 / heredoc 没闭合（Bash 详情被截断时常见）
 */

interface Redirect {
  /** > >> >| &> &>> >& <> <（<< heredoc 只读 stdin，不记；<<< herestring 记成 <） */
  op: string;
  target: string;
}
export interface Segment {
  words: string[];
  redirects: Redirect[];
  /** 某个词里有运行时才知道的值（变量、ANSI-C 引号、花括号展开） */
  dynamic: boolean;
}
export interface ShellParse {
  segments: Segment[];
  substitution: boolean;
  structural: boolean;
  broken: boolean;
}

const SEP2 = ["&&", "||", ";;", "|&"];
const SEP1 = new Set([";", "|", "&"]);
const REDIRECT = /^(\d*)(&>>|&>|>>|>\||>&|<>|>|<<<|<<-|<<|<)/;
const HAS_SUBST = /\$\(|`/;
/** $ 后面跟这些才是展开（$ 单独出现、$) 之类是字面量） */
const EXPANSION = /^\$[A-Za-z_{@*#?!0-9-]/;

/** 从 i（指向开括号后一位）找到配对的右括号（open/close 可换成 [ ]），返回右括号下标；引号里的不算 */
function matchClose(s: string, i: number, open = "(", close = ")"): number {
  let depth = 1;
  let q: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

interface Heredoc {
  delim: string;
  /** 分隔词带引号：正文不展开（里面的 $(…) 不会执行） */
  quoted: boolean;
}

/** 跳过 heredoc 正文，返回正文之后的下标；没找到结束行 → -1。不带引号的正文里有命令替换 → 记 substitution */
function skipHeredocs(cmd: string, i: number, docs: Heredoc[], out: ShellParse): number {
  for (const d of docs) {
    for (;;) {
      if (i >= cmd.length) return -1;
      const nl = cmd.indexOf("\n", i);
      const line = cmd.slice(i, nl < 0 ? cmd.length : nl);
      i = nl < 0 ? cmd.length : nl + 1;
      if (line.replace(/^\t+/, "") === d.delim) break;
      if (!d.quoted && HAS_SUBST.test(line)) out.substitution = true;
    }
  }
  return i;
}

class Lexer {
  readonly out: ShellParse = { segments: [], substitution: false, structural: false, broken: false };
  private seg: Segment = { words: [], redirects: [], dynamic: false };
  private word = "";
  /** 当前词里没加引号的部分：判花括号展开用 */
  private bare = "";
  private inWord = false;
  private quoted = false;
  private dyn = false;
  private pendingRedirect: string | null = null;
  private heredocs: Heredoc[] = [];
  i = 0;
  constructor(readonly cmd: string) {}

  add(text: string, bare = false): void {
    this.word += text;
    if (bare) this.bare += text;
    this.inWord = true;
  }
  endWord(): void {
    if (!this.inWord) return;
    const r = this.pendingRedirect;
    if (/\{[^{}]*,[^{}]*\}/.test(this.bare)) this.dyn = true;
    if (r === null) {
      if (!this.quoted && (this.word === "{" || this.word === "}")) this.out.structural = true;
      this.seg.words.push(this.word);
      if (this.dyn) this.seg.dynamic = true;
    } else if (r.startsWith("<<")) this.heredocs.push({ delim: this.word, quoted: this.quoted });
    else this.seg.redirects.push({ op: r, target: this.word });
    this.pendingRedirect = null;
    this.word = this.bare = "";
    this.inWord = this.quoted = this.dyn = false;
  }
  endSeg(): void {
    this.endWord();
    if (this.seg.words.length || this.seg.redirects.length) this.out.segments.push(this.seg);
    this.seg = { words: [], redirects: [], dynamic: false };
  }
  finish(): ShellParse {
    if (this.pendingRedirect !== null && !this.inWord) this.out.broken = true;
    this.endSeg();
    if (this.heredocs.length) this.out.broken = true; // << 之后命令就完了，正文没见到
    return this.out;
  }

  /** 单引号：原样到下一个单引号 */
  singleQuote(): boolean {
    const j = this.cmd.indexOf("'", this.i + 1);
    if (j < 0) return false;
    this.add(this.cmd.slice(this.i + 1, j));
    this.quoted = true;
    this.i = j + 1;
    return true;
  }
  /** $'…'：ANSI-C 引号，转义后的值看不出来（$'-delete' 就是 -delete），记 dynamic */
  ansiQuote(): boolean {
    let j = this.i + 2;
    for (; j < this.cmd.length && this.cmd[j] !== "'"; j++) if (this.cmd[j] === "\\") j++;
    if (j >= this.cmd.length) return false;
    this.add(this.cmd.slice(this.i + 2, j));
    this.quoted = this.dyn = true;
    this.i = j + 1;
    return true;
  }
  /** $"…"：本地化字符串，bash 当双引号处理（$"-delete" 就是 -delete），zsh 当字面量；两边结果不同，记 dynamic */
  localeQuote(): boolean {
    this.i++;
    const ok = this.doubleQuote();
    this.dyn = true;
    return ok;
  }
  /** 双引号：认反斜杠转义；里面的 $(...) / `...` 照样是命令替换，$X 照样是展开 */
  doubleQuote(): boolean {
    const { cmd } = this;
    let j = this.i + 1;
    let text = "";
    for (; j < cmd.length && cmd[j] !== '"'; j++) {
      if (cmd[j] === "\\") text += cmd[++j] ?? "";
      else {
        if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) this.out.substitution = true;
        if (EXPANSION.test(cmd.slice(j, j + 2))) this.dyn = true;
        text += cmd[j];
      }
    }
    if (j >= cmd.length) return false;
    this.add(text);
    this.quoted = true;
    this.i = j + 1;
    return true;
  }
  /** 算术 $((…)) / ((…)) / $[…]：值是数字，但里面的 $(…) / `…` 照样执行；替换 $(…) / <(…) / >(…) / `…` 直接记下 */
  parenthesized(): boolean {
    const { cmd, i } = this;
    const bracket = cmd.startsWith("$[", i);
    const arith = bracket || cmd.startsWith("$((", i) || cmd.startsWith("((", i);
    let j: number;
    if (cmd[i] === "`") j = cmd.indexOf("`", i + 1);
    else if (bracket) j = matchClose(cmd, i + 2, "[", "]");
    else j = matchClose(cmd, (cmd[i] === "(" ? i : i + 1) + 1); // (( 从 i 起，$(( $( <( >( 从 i+1 起
    if (j < 0) return false;
    if (!arith || HAS_SUBST.test(cmd.slice(i + 1, j))) this.out.substitution = true;
    this.add(cmd.slice(i, j + 1));
    this.i = j + 1;
    return true;
  }
  /** 重定向；>&2 / >&- 是 fd 复制，记成目标 "&2"；>&file 是写文件 */
  redirect(m: RegExpExecArray): void {
    if (this.inWord && /^\d+$/.test(this.word)) this.word = this.bare = "", this.inWord = false; // 2> 里的 2 是 fd，不是词
    else this.endWord(); // echo x>f：x 是词，> 另起
    const op = m[2];
    this.i += m[0].length;
    this.pendingRedirect = op === "<<<" ? "<" : op;
    const fd = op === ">&" ? /^\s*([0-9-]+)(?=\s|$|[;&|])/.exec(this.cmd.slice(this.i)) : null;
    if (fd) {
      this.seg.redirects.push({ op: ">&", target: `&${fd[1]}` });
      this.pendingRedirect = null;
      this.i += fd[0].length;
    }
  }
  newline(): boolean {
    this.endSeg(); // 先收掉当前词：heredoc 的分隔词可能正是它
    if (!this.heredocs.length) return (this.i++, true);
    this.i = skipHeredocs(this.cmd, this.i + 1, this.heredocs.splice(0), this.out);
    return this.i >= 0;
  }
  /** 没有引号、不是分隔符 / 重定向的普通字符 */
  plain(c: string): void {
    if (c === "(" || c === ")") this.out.structural = true;
    if (c === "$" && EXPANSION.test(this.cmd.slice(this.i, this.i + 2))) this.dyn = true;
    this.add(c, true);
    this.i++;
  }
  /** 处理 i 处的一个记号；返回 false = 解析不下去（引号 / 括号 / heredoc 没闭合） */
  step(): boolean {
    const { cmd, i } = this;
    const c = cmd[i];
    const two = cmd.slice(i, i + 2);
    if (c === "'") return this.singleQuote();
    if (two === "$'") return this.ansiQuote();
    if (two === '$"') return this.localeQuote();
    if (c === '"') return this.doubleQuote();
    if (c === "\\") {
      if (cmd[i + 1] !== "\n") this.add(cmd[i + 1] ?? ""), this.quoted = true; // 反斜杠换行 = 续行
      this.i += 2;
    } else if (c === "#" && !this.inWord) {
      while (this.i < cmd.length && cmd[this.i] !== "\n") this.i++;
    } else if (cmd.startsWith("$((", i) || cmd.startsWith("((", i) || ["$(", "$[", "<(", ">("].includes(two) || c === "`") {
      return this.parenthesized();
    } else if (c === " " || c === "\t") {
      this.endWord();
      this.i++;
    } else if (c === "\n") {
      return this.newline();
    } else if (REDIRECT.test(cmd.slice(i))) {
      this.redirect(REDIRECT.exec(cmd.slice(i))!); // 先于分隔符判，免得 &> 被切成 & 和 >
    } else if (SEP2.includes(two) || SEP1.has(c)) {
      this.endSeg();
      this.i += SEP2.includes(two) ? 2 : 1;
    } else this.plain(c);
    return true;
  }
}

export function parseShell(cmd: string): ShellParse {
  const lx = new Lexer(cmd);
  while (lx.i < cmd.length) {
    if (!lx.step()) return { ...lx.out, broken: true };
  }
  return lx.finish();
}
