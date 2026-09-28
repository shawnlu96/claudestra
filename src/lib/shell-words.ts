/**
 * 最小的 shell 分词（tests/shell-words.test.ts）：把一条命令切成「段」（按 && || ; | & 换行），每段是去掉引号后的词和重定向。
 * 只为「这条命令会不会写东西」服务（lib/autopilot-tools.ts），不是完整的 shell 解析：
 * 认得单双引号、反斜杠、$(...) / `...` / <(...) / >(...)（记成 substitution，调用方一律按写算）、$((...)) 算术、heredoc（正文跳过）、# 注释。
 * 认不出的写法宁可切错成「写」：误判成写只是多推一轮，误判成只读会让真在干活的 agent 进待命。
 */

interface Redirect {
  /** > >> >| &> &>> >& <（<< heredoc 只读 stdin，不记；<<< herestring 记成 <） */
  op: string;
  target: string;
}
export interface Segment {
  words: string[];
  redirects: Redirect[];
}
export interface ShellParse {
  segments: Segment[];
  /** 出现了命令替换 / 进程替换（$(...)、`...`、<(...)、>(...)）：里面跑什么看不出来 */
  substitution: boolean;
  /** 引号 / 括号没闭合之类，解析不完整 */
  broken: boolean;
}

const SEP2 = ["&&", "||", ";;", "|&"];
const SEP1 = new Set([";", "|", "&"]);
const REDIRECT = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<)/;

/** 从 i（指向开括号后一位）找到配对的右括号，返回右括号下标；引号里的括号不算 */
function matchParen(s: string, i: number): number {
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
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** 跳过 heredoc 正文：从 i 开始逐行，直到每个分隔词各自出现在单独一行（<<- 允许前导 tab） */
function skipHeredocs(cmd: string, i: number, delims: string[]): number {
  for (const d of delims) {
    for (;;) {
      if (i >= cmd.length) return i;
      const nl = cmd.indexOf("\n", i);
      const line = cmd.slice(i, nl < 0 ? cmd.length : nl);
      i = nl < 0 ? cmd.length : nl + 1;
      if (line.replace(/^\t+/, "") === d) break;
    }
  }
  return i;
}

class Lexer {
  readonly out: ShellParse = { segments: [], substitution: false, broken: false };
  private seg: Segment = { words: [], redirects: [] };
  private word = "";
  private inWord = false;
  private pendingRedirect: string | null = null;
  private heredocs: string[] = [];
  i = 0;
  constructor(readonly cmd: string) {}

  add(text: string): void {
    this.word += text;
    this.inWord = true;
  }
  endWord(): void {
    if (!this.inWord) return;
    const r = this.pendingRedirect;
    if (r === null) this.seg.words.push(this.word);
    else if (r.startsWith("<<")) this.heredocs.push(this.word);
    else this.seg.redirects.push({ op: r, target: this.word });
    this.pendingRedirect = null;
    this.word = "";
    this.inWord = false;
  }
  endSeg(): void {
    this.endWord();
    if (this.seg.words.length || this.seg.redirects.length) this.out.segments.push(this.seg);
    this.seg = { words: [], redirects: [] };
  }
  finish(): ShellParse {
    if (this.pendingRedirect !== null && !this.inWord) this.out.broken = true;
    this.endSeg();
    return this.out;
  }

  /** 单引号：原样到下一个单引号 */
  singleQuote(): boolean {
    const j = this.cmd.indexOf("'", this.i + 1);
    if (j < 0) return false;
    this.add(this.cmd.slice(this.i + 1, j));
    this.i = j + 1;
    return true;
  }
  /** 双引号：认反斜杠转义；里面的 $(...) / `...` 照样是命令替换 */
  doubleQuote(): boolean {
    const { cmd } = this;
    let j = this.i + 1;
    let text = "";
    for (; j < cmd.length && cmd[j] !== '"'; j++) {
      if (cmd[j] === "\\") text += cmd[++j] ?? "";
      else {
        if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(" && cmd[j + 2] !== "(")) this.out.substitution = true;
        text += cmd[j];
      }
    }
    if (j >= cmd.length) return false;
    this.add(text);
    this.i = j + 1;
    return true;
  }
  /** $((…)) / ((…)) 算术，或 $(…) / <(…) / >(…) / `…` 替换：整段当作词的一部分 */
  parenthesized(): boolean {
    const { cmd, i } = this;
    const arith = cmd.startsWith("$((", i) || cmd.startsWith("((", i);
    if (!arith) this.out.substitution = true;
    const firstParen = cmd[i] === "(" ? i : i + 1; // (( 从 i 起，$(( $( <( >( 从 i+1 起
    const j = cmd[i] === "`" ? cmd.indexOf("`", i + 1) : matchParen(cmd, firstParen + 1);
    if (j < 0) return false;
    this.add(cmd.slice(i, j + 1));
    this.i = j + 1;
    return true;
  }
  /** 重定向；>&2 / >&- 是 fd 复制，记成目标 "&2"；>&file 是写文件 */
  redirect(m: RegExpExecArray): void {
    if (this.inWord && /^\d+$/.test(this.word)) this.word = "", this.inWord = false; // 2> 里的 2 是 fd，不是词
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
  newline(): void {
    this.endSeg(); // 先收掉当前词：heredoc 的分隔词可能正是它
    this.i = this.heredocs.length ? skipHeredocs(this.cmd, this.i + 1, this.heredocs.splice(0)) : this.i + 1;
  }
  /** 处理 i 处的一个记号；返回 false = 解析不下去（引号 / 括号没闭合） */
  step(): boolean {
    const { cmd, i } = this;
    const c = cmd[i];
    const two = cmd.slice(i, i + 2);
    if (c === "'") return this.singleQuote();
    if (c === '"') return this.doubleQuote();
    if (c === "\\") {
      if (cmd[i + 1] !== "\n") this.add(cmd[i + 1] ?? ""); // 反斜杠换行 = 续行
      this.i += 2;
    } else if (c === "#" && !this.inWord) {
      while (this.i < cmd.length && cmd[this.i] !== "\n") this.i++;
    } else if (cmd.startsWith("$((", i) || cmd.startsWith("((", i) || two === "$(" || two === "<(" || two === ">(" || c === "`") {
      return this.parenthesized();
    } else if (c === " " || c === "\t") {
      this.endWord();
      this.i++;
    } else if (c === "\n") {
      this.newline();
    } else if (REDIRECT.test(cmd.slice(i))) {
      this.redirect(REDIRECT.exec(cmd.slice(i))!); // 先于分隔符判，免得 &> 被切成 & 和 >
    } else if (SEP2.includes(two) || SEP1.has(c)) {
      this.endSeg();
      this.i += SEP2.includes(two) ? 2 : 1;
    } else {
      this.add(c);
      this.i++;
    }
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
