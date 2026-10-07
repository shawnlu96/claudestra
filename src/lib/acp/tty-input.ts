/**
 * ACP 窗口的输入行（acp-host.ts 只在 stdin / stdout 都是 TTY 时接）：stdin 进 raw 模式，按键在这里解释。
 * 所有动作都交给 bridge（acp_terminal 帧，bridge/acp-terminal.ts）：消息和网页消息同一条入站语义（插话 / 开一轮 / 排队），
 * Esc 和网页打断按钮同一条 abort 路径，审批和网页卡片同一个先到先得的作答闸。宿主自己不调 session/prompt。
 * Ctrl-C：raw 模式下不再变成 SIGINT——回合中 = 打断，空闲时 2 秒内连按两次才退出（manager 收宿主改发 SIGTERM，runtimes/acp-control.ts）。
 * tests/acp-tty-input.test.ts。
 */
import type { PermissionCard } from "./permissions.js";

export type TerminalOp =
  | { op: "message"; text: string }
  | { op: "interrupt" }
  | { op: "config"; configId: "model" | "effort"; value: string }
  | { op: "clear" }
  | { op: "compact" }
  | { op: "permission"; permId: string; optionId: string };

export type TerminalResult = { ok: boolean; error?: string; note?: string };

export interface TtyInputDeps {
  busy(): boolean;
  /** 最早那个还在等的审批（和 bridge 卡上显示的是同一个：都按到达顺序排） */
  permission(): { permId: string; card: PermissionCard } | null;
  request(op: TerminalOp): Promise<TerminalResult>;
  print(line: string): void;
  /** 输入行变了：重画底栏 */
  redraw(): void;
  exit(): void;
  now?(): number;
  /** 单独一个 ESC 等多久没有后文才算 Esc 键（方向键的 ESC [ A 可能被拆到两次 data 里）；缺省 ESC_WAIT_MS */
  escMs?: number;
}

export interface TtyInput {
  feed(data: string): void;
  /** 底栏输入行的内容（已按宽度截好） */
  line(cols: number): string;
}

const EXIT_WINDOW_MS = 2_000;
const ESC_WAIT_MS = 50;
/** 终端的 bracketed paste（attach 时打开）：粘贴内容夹在这两个 CSI 之间，里面的回车是正文不是发送 */
const PASTE_ON = "200~", PASTE_OFF = "201~";

const TERMINAL_HELP = [
  "终端命令：",
  "  /model <名>     换模型（不重启；和网页设置页同一条路）",
  "  /effort <级>    换推理强度（不重启；/thinking 同义）",
  "  /clear          清上下文（换新线程）",
  "  /compact        压缩上下文",
  "  /help           本帮助",
  "  其它 /xxx 照普通消息发，和网页一样",
  "按键：回车发送（粘贴进来的换行留在正文里）· Esc 回合中打断、空闲时清空输入 · Ctrl-C 回合中打断、空闲时 2 秒内连按两次退出 · Ctrl-U 清空输入",
  "审批：输入行为空时单独按一下 y 允许 / n 拒绝 / 数字选第几个（粘贴进来的字不算；网页卡片也能答，谁先答算谁的）",
].join("\n");

type Parsed = TerminalOp | { help: true } | { error: string };

/** 一行输入 → 动作；不是终端命令的 /xxx 照消息发（网页对不认识的斜杠也是这样） */
export function parseTerminalLine(text: string): Parsed {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return { op: "message", text };
  const arg = (m[2] ?? "").trim();
  switch (m[1]) {
    case "help": return { help: true };
    case "clear": return { op: "clear" };
    case "compact": return { op: "compact" };
    case "model": return arg ? { op: "config", configId: "model", value: arg } : { error: "用法：/model <模型名>" };
    case "effort": case "thinking": return arg ? { op: "config", configId: "effort", value: arg } : { error: `用法：/${m[1]} <档位>` };
    default: return { op: "message", text };
  }
}

/** y = 第一个「允许」类选项，n = 第一个「拒绝」类，数字 = 第几个；对不上 null */
export function pickPermissionOption(card: PermissionCard, key: string): string | null {
  if (key === "y" || key === "Y") return card.options.find((o) => o.style === "success")?.id ?? null;
  if (key === "n" || key === "N") return card.options.find((o) => o.style === "danger")?.id ?? null;
  const i = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  return card.options[i]?.id ?? null;
}

/** 审批卡进窗口的样子（宿主收到请求时显示一次） */
export function permissionLines(card: PermissionCard): string {
  const opts = card.options.map((o, i) => `[${i + 1}] ${o.label}`).join("  ");
  return [`⏸ ${card.title}`, ...(card.detail ? [`  ${card.detail}`] : []), `  ${opts}（y 允许 / n 拒绝 / 数字；网页卡片也能答）`].join("\n");
}

/** 放不下就留尾巴（光标在行尾，正在打的字要看得见），前面用 … 代替；中文两格，留一格免得折行 */
export function fitTail(text: string, cols: number): string {
  const max = Math.max(2, cols - 1);
  const chars = [...text];
  let w = 0, i = chars.length;
  while (i > 0 && w + Bun.stringWidth(chars[i - 1]!) <= max) w += Bun.stringWidth(chars[--i]!);
  return i === 0 ? text : `…${chars.slice(i + (w + 1 > max ? 1 : 0)).join("")}`;
}

export function createTtyInput(deps: TtyInputDeps): TtyInput {
  const now = deps.now ?? Date.now;
  let buf = "", exitArmedAt = -Infinity, answering: string | null = null;
  /** draft：发失败时、输入行还空着就把原文放回去，断线 / 拒投后不用重打 */
  const run = (op: TerminalOp, ok?: (r: TerminalResult) => string | null, draft?: string) => {
    const fail = (line: string) => {
      deps.print(line);
      if (draft && !buf) buf = draft, deps.redraw();
    };
    void deps.request(op).then(
      (r) => {
        if (!r.ok) return fail(`❌ ${r.error ?? "没成功"}${draft ? "（原文已放回输入行）" : ""}`);
        const line = ok?.(r);
        if (line) deps.print(line);
      },
      (e) => fail(`❌ 没送到 bridge：${e instanceof Error ? e.message : String(e)}${draft ? "（原文已放回输入行）" : ""}`),
    );
  };
  const interrupt = () => run({ op: "interrupt" }, (r) => `⏹ ${r.note ?? "已请求打断"}`);
  const submit = () => {
    const text = buf;
    buf = "";
    if (!text.trim()) return;
    const p = parseTerminalLine(text);
    if ("help" in p) return deps.print(TERMINAL_HELP);
    if ("error" in p) return deps.print(`❌ ${p.error}`);
    if (p.op === "message") return run(p, (r) => (r.note ? `· ${r.note}` : null), text); // 正文回来时宿主会显示这条入站，这里不重复
    deps.print(`❯ ${text.trim()}`);
    run(p, (r) => `✅ ${r.note ?? "已完成"}`, text);
  };
  const answer = (key: string): boolean => {
    const pending = deps.permission();
    if (!pending || buf) return false;
    if (answering === pending.permId) return true; // 上一下还没回：吞掉，免得同一张卡答两次
    const optionId = pickPermissionOption(pending.card, key);
    if (!optionId) return key.length === 1 && /[yYnN1-9]/.test(key); // y/n/数字对不上选项：不当正文打进去
    answering = pending.permId;
    void deps.request({ op: "permission", permId: pending.permId, optionId }).then(
      (r) => deps.print(r.ok ? `✅ 已作答：${pending.card.options.find((o) => o.id === optionId)?.label ?? optionId}` : `❌ ${r.error ?? "没答上"}`),
      (e) => deps.print(`❌ 没送到 bridge：${e instanceof Error ? e.message : String(e)}`),
    ).finally(() => answering === pending.permId && (answering = null));
    return true;
  };
  const ctrlC = () => {
    if (deps.busy()) return (exitArmedAt = -Infinity), interrupt();
    if (buf) return void (buf = ""); // 有字先清字（和 CC 一样），不算一下
    if (now() - exitArmedAt < EXIT_WINDOW_MS) return deps.exit();
    exitArmedAt = now();
    deps.print("再按一次 Ctrl-C 退出这个 agent 的宿主（2 秒内）；只想打断回合请按 Esc");
  };
  const escKey = () => {
    if (deps.busy()) interrupt();
    else buf = "";
  };
  /** single：这一下 data 只有这一个字符。审批快捷键只认单独一次按键——整块进来的（没有粘贴标记的粘贴、连打）一律是正文 */
  const key = (ch: string, single: boolean) => {
    if (ch === "\x03") return ctrlC();
    if (ch === "\r" || ch === "\n") return submit(); // 每个回车都发：data 块边界不是按键边界，不能拿它猜粘贴
    if (ch === "\x7f" || ch === "\x08") return void (buf = [...buf].slice(0, -1).join(""));
    if (ch === "\x15") return void (buf = "");
    if (ch < " ") return; // 其它控制键不认
    if (!(single && answer(ch))) buf += ch;
  };
  const decode = createKeyDecoder({
    key,
    paste: (ch) => void (buf += ch),
    pasteEnd: () => void (buf = buf.replace(/\r\n?/g, "\n")),
    esc: () => (escKey(), deps.redraw()),
  }, deps.escMs ?? ESC_WAIT_MS);
  return {
    feed(data) {
      decode(data);
      deps.redraw();
    },
    line(cols) {
      const pending = deps.permission();
      if (pending && !buf) return fitTail(`审批 ${pending.card.options.map((o, i) => `[${i + 1}]${o.label}`).join(" ")}（y/n/数字）❯ `, cols);
      return fitTail(`❯ ${buf.replace(/\r\n?|\n/g, "⏎")}`, cols);
    },
  };
}

interface DecoderSink {
  key(ch: string, single: boolean): void;
  /** bracketed paste 里的正文字符（回车也是正文） */
  paste(ch: string): void;
  pasteEnd(): void;
  /** 单独的 Esc 键（等过 escMs 没有后文；计时器里调，调用方自己重画） */
  esc(): void;
}

/**
 * stdin 字节流 → 按键 / 粘贴正文 / Esc。转义序列状态跨 data 块保留（esc = 刚收到 ESC，csi = ESC [ 之后攒参数，ss3 = ESC O 之后等一个字）：
 * 方向键、Alt+键整段吞掉；粘贴开关（ESC[200~ / ESC[201~）在这里认。data 块边界不是按键边界，什么都不靠它猜。
 */
function createKeyDecoder(sink: DecoderSink, escMs: number): (data: string) => void {
  let esc: "" | "esc" | "csi" | "ss3" = "", csi = "", pasting = false, timer: ReturnType<typeof setTimeout> | null = null;
  const onCsi = (seq: string) => {
    if (seq === PASTE_ON) pasting = true;
    else if (seq === PASTE_OFF) (pasting = false), sink.pasteEnd();
  };
  const step = (ch: string, single: boolean) => {
    if (esc === "esc") {
      if (ch === "[") return void ((esc = "csi"), (csi = ""));
      if (ch === "O") return void (esc = "ss3");
      if (ch === "\x1b") return sink.esc(); // 连按两下 Esc：前一下就是 Esc，这一下接着等后文
      return void (esc = ""); // Alt+键
    }
    if (esc === "csi") return /[@-~]/.test(ch) ? ((esc = ""), onCsi(csi + ch)) : void (csi += ch);
    if (esc === "ss3") return void (esc = "");
    if (ch === "\x1b") return void (esc = "esc");
    if (!pasting) return sink.key(ch, single);
    if (ch >= " " || "\r\n\t".includes(ch)) sink.paste(ch);
  };
  return (data) => {
    if (timer) clearTimeout(timer), (timer = null);
    const chars = [...data];
    for (const ch of chars) step(ch, chars.length === 1);
    if (esc !== "esc") return;
    timer = setTimeout(() => {
      timer = null;
      if (esc !== "esc") return;
      esc = "";
      sink.esc();
    }, escMs);
  };
}
