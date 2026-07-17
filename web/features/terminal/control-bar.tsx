"use client";
import { useT } from "@/lib/i18n";

/**
 * 终端控制键条。
 *
 * 关键交互：按钮 onPointerDown preventDefault —— 不抢输入焦点（xterm 隐藏
 * textarea），否则手机上点一下按键软键盘就收起。
 *
 * 手机端曾有一个专用文本输入框（绕 xterm IME 吞字 #3396/#2403），owner
 * 2026-07-13 拍掉：「直接点终端就能唤键盘，文字框没什么意义」——且它紧挨
 * 重连按钮，是断连时误触弹键盘的元凶。移动端输入统一走 xterm 隐藏 textarea
 * （点画布 / ⌨️ 键聚焦）；若 iOS IME 快打真吞字，再评估要不要请回来。
 */

// 手机端精简：只留真正控制 Claude Code TUI 用得上的键。移除了 Tab / ← / →
//（CC TUI 几乎不用 Tab；横向移光标在手机上基本不编辑内联文本，软键盘够用），
// 竖向滚动历史已由「触摸滑动 → 滚轮」接管（见 terminal-view.tsx），不再靠 ↑/↓。
// ↑/↓ 保留是为 CC 菜单/选项/权限弹窗的上下选择（滑动是滚动，替代不了选择）。
const KEYS: { label: string; seq: string; title?: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "⇧Tab", seq: "\x1b[Z", title: "Shift+Tab（切换权限模式）" },
  { label: "↑", seq: "\x1b[A", title: "上选（菜单/选项）" },
  { label: "↓", seq: "\x1b[B", title: "下选（菜单/选项）" },
  // 快速翻页（owner 2026-07-14）：^O 转录视图 / copy-mode 里整页整页翻,
  // 比滑动快得多;主界面下由 TUI 自行决定响应
  { label: "PgUp", seq: "\x1b[5~", title: "PageUp（快速上翻一页）" },
  { label: "PgDn", seq: "\x1b[6~", title: "PageDown（快速下翻一页）" },
  // 跳到底部(owner 2026-07-14「Command+End 跳到最下面」):发 End——^O 转录视图
  // 的标准 pager 跳底;terminal-view 对这个 seq 还会顺带 xterm.scrollToBottom()。
  // copy-mode 里 End 只到行尾——那里往下滑到底会自动退出,不归这颗键管。
  { label: "↓btm", seq: "\x1b[F", title: "End（跳到最新输出/底部）" },
  { label: "⏎", seq: "\r", title: "Enter" },
  { label: "^C", seq: "\x03", title: "Ctrl+C（中断）" },
  // 看更早的转录用 CC 原生 Ctrl+O（进入后配合滑动/↑↓ 可滚完整会话记录）
  { label: "^O", seq: "\x0f", title: "Ctrl+O（Claude Code 转录视图，可滚动）" },
];

export function ControlBar({
  onKeys,
  onFocusTerm,
  disabled,
}: {
  onKeys: (seq: string) => void;
  onFocusTerm: () => void;
  disabled?: boolean;
  /** 兼容旧调用位；输入统一走 xterm，本参数不再改变行为 */
  mobile?: boolean;
}) {
  const t = useT();
  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t border-white/10 bg-[#181825] px-2 py-2"
      style={{
        // --term-safe-bottom：软键盘弹起时 modal 置 0（home 条在键盘后面无需垫）
        paddingBottom:
          "max(var(--term-safe-bottom, env(safe-area-inset-bottom)), 6px)",
      }}
    >
      {/* touch-action: pan-x —— 键条只许横滑;不锁的话 iOS 会把纵向拖动
          当滚动/橡皮筋处理,键条跟着上下晃(owner 2026-07-15 实测) */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ touchAction: "pan-x" }}
      >
        {/* 唤起软键盘：聚焦 xterm 隐藏 textarea（iOS 必须在手势内 focus） */}
        <button
          className="btn btn-sm shrink-0 border-white/10 bg-white/5 font-normal text-[#cdd6f4] hover:bg-white/10"
          title={t("唤起键盘输入")}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onFocusTerm()}
          disabled={disabled}
        >
          ⌨️
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-white/10" />
        {KEYS.map((k) => (
          <button
            key={k.label}
            className="btn btn-sm shrink-0 border-white/10 bg-white/5 font-mono font-normal text-[#cdd6f4] hover:bg-white/10"
            title={k.title ? t(k.title) : k.label}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onKeys(k.seq)}
            disabled={disabled}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
