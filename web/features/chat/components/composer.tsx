"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";
import { SkillsSheet } from "./skills-sheet";


const MAX_FILES = 5;

/* 复刻 Claude OS features/chat/composer 的卡片式输入：圆角卡 + 内嵌「正在回复」条
   + 附件缩略图 + 无边框 textarea + 图标控件。功能保留 claudestra 侧：流式中可插话、
   粘贴上传、停止与发送并列。 */

function PaperclipIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** 待发送文件的缩略图 / 文件卡片，点 ✕ 移除。 */
function PendingFiles({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (i: number) => void;
}) {
  const t = useT();
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3">
      {files.map((f, i) => {
        const isImg = f.type.startsWith("image/");
        return isImg ? (
          <div
            key={i}
            className="group relative size-16 overflow-hidden rounded-lg border border-base-content/10 bg-base-300"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={URL.createObjectURL(f)}
              alt={f.name}
              className="size-full object-cover"
            />
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        ) : (
          <div
            key={i}
            title={f.name}
            className="group relative flex h-16 w-44 items-center gap-2.5 overflow-hidden rounded-lg border border-base-content/10 bg-base-300 px-3"
          >
            <span className="text-lg">📎</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-base-content/85">
                {f.name}
              </div>
              <div className="text-[10.5px] text-base-content/40">{t("文件")}</div>
            </div>
            <RemoveBtn onClick={() => onRemove(i)} />
          </div>
        );
      })}
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("移除")}
      aria-label={t("移除")}
      className="absolute right-0.5 top-0.5 flex size-[18px] items-center justify-center rounded-full bg-black/60 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100"
    >
      ✕
    </button>
  );
}

/** Slash 命令（bridge /skills 端点形状）。web 无 Discord 的 100 命令上限/描述截断。 */
interface SlashCmd {
  name: string;
  invokeName: string;
  description: string;
  scope: string;
  argHint?: string;
}
const SCOPE_LABEL: Record<string, string> = {
  builtin: "内建",
  native: "CC",
  plugin: "插件",
  user: "技能",
  project: "项目",
};

export function Composer() {
  const t = useT();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  // v2.15+ 思考遥测:耗时 + ↓token 跳动(token 在涨 = 模型活着,消除「卡住」错觉)
  const telemetry = useChatStore((s) => s.state.telemetry);
  const quoteDraft = useChatStore((s) => s.state.quoteDraft);
  const agents = useChatStore((s) => s.state.agents);
  const store = useChatStoreApi();
  // 上下文超标警示(2026-07-14 owner:到限制要在聊天界面提醒)。每会话可关闭。
  const [ctxDismissedFor, setCtxDismissedFor] = useState("");
  // 「请求压缩」一次性:点完整条警示立即消失,不给点第二次的机会(owner 2026-07-14
  // 连点两下发了两条)。压缩成功 → compact_done 把 ctxTokens 打回低位,条自然不再出;
  // agent 没执行的兜底:10 分钟后 ctx 仍超标才重新亮出来。按 agent 记。
  const [compactReqAt, setCompactReqAt] = useState<Record<string, number>>({});
  const agentInfo = agents.find((a) => a.name === active);
  const ctxTokens = typeof agentInfo?.contextTokens === "number" ? agentInfo.contextTokens : 0;
  const reqAt = compactReqAt[active] || 0;
  // 阈值对齐 ctx-level 深红档(1M 窗的 75%)——此前按 200k 窗的 170k,1M 模型
  // 才用 17% 就催压缩,太吵(owner 2026-07-14 更正窗口口径)
  const showCtxWarn =
    ctxTokens >= 750_000 &&
    ctxDismissedFor !== active &&
    // 读当前时间决定要不要提示压缩。改成定时 tick 驱动才算"纯"，但那是为一个提示
    // 横幅常驻一个定时器；这里读到的值最坏就是横幅晚一轮渲染才出现/消失。
    // eslint-disable-next-line react-hooks/purity
    (!reqAt || Date.now() - reqAt > 10 * 60_000);

  // ── Slash 命令面板（owner 2026-07-14:skills 适配 web,比 Discord 强——
  // 全量列表+即时模糊搜索+描述全文+按 agent 精准过滤）。输入以 "/" 开头
  // (无换行)即弹;点选/Enter 填入,发送时 bridge 识别并 tmux 原生注入。──
  const [skills, setSkills] = useState<SlashCmd[]>([]);
  const skillsCacheRef = useRef<Record<string, SlashCmd[]>>({});
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  useEffect(() => {
    if (!active) {
      setSkills([]);
      return;
    }
    const hit = skillsCacheRef.current[active];
    if (hit) {
      setSkills(hit);
      return;
    }
    setSkills([]);
    let dead = false;
    fetch(`/api/chat/skills?agent=${encodeURIComponent(active)}`)
      .then((r) => r.json())
      .then((j: { commands?: SlashCmd[] }) => {
        if (dead) return;
        const cmds = Array.isArray(j.commands) ? j.commands : [];
        skillsCacheRef.current[active] = cmds;
        setSkills(cmds);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [active]);
  useEffect(() => {
    setSlashSel(0);
    setSlashDismissed(false);
  }, [text]);
  // 只在输入命令 token 期间弹(无空格/换行):pickSlash 填入「/cmd 」带尾随空格
  // 即自动收起——否则填入后菜单基于新文本重新匹配(description 子串能撞上无关
  // 命令),二次回车被菜单拦截选中错误命令而不是发送(2026-07-24 owner:输 /save
  // 补全后再回车,期望发送却变成 Discord Configure)
  const slashQ = /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
  // 匹配优先级:name 前缀 > name 子串 > 仅 description 命中。不排序的话
  // skills 原序里 description 撞词的无关命令会排在 name 精确命中前——输 /save
  // 第一项竟是 discord-configure(描述含 "save the bot"),回车直接填错命令
  // (2026-07-24 owner 报障,Playwright 复现实锤)。sort 稳定,同级保持原序。
  const slashRank = (c: SlashCmd) => {
    const n = c.name.toLowerCase();
    if (slashQ && n.startsWith(slashQ)) return 0;
    if (slashQ && n.includes(slashQ)) return 1;
    return 2;
  };
  const slashItems =
    slashQ !== null && skills.length
      ? skills
          .filter((c) => c.name.toLowerCase().includes(slashQ) || c.description.toLowerCase().includes(slashQ))
          .sort((a, b) => slashRank(a) - slashRank(b))
          .slice(0, 40)
      : [];
  const slashOpen = !slashDismissed && slashItems.length > 0;
  const pickSlash = (c: SlashCmd) => {
    setText(`/${c.name} `);
    taRef.current?.focus();
  };
  // Skills 面板(owner 2026-07-15:「斜杠太隐蔽,对话框下加按钮呼出」)
  const [skillsOpen, setSkillsOpen] = useState(false);

  const disabled = !active;
  const hasContent = !!text.trim() || files.length > 0;
  // 流式中也可发（插入会话）——不再要求 !streaming。
  const canSend = !disabled && hasContent;

  // ── 草稿持久化（2026-07-13 owner）：未发送文字按 agent 存 localStorage，
  //    切走会话 / 退出 App 再回来原样恢复；发送成功即清。 ──
  const draftKey = (a: string) => `cstra_draft_${a}`;
  const textRef = useRef(text);
  // 在 effect 里赋值而不是 render 期直接写：render 可能被 React 丢弃/重放，
  // 那样 ref 会留下一个从未提交过的值。这些 ref 只给异步回调（定时器、事件、
  // 卸载清理）读最新值，effect 在 commit 后同步执行，对它们没有可观察差异。
  useEffect(() => {
    textRef.current = text;
  });
  const saveDraft = (agent: string, value: string) => {
    try {
      if (value.trim()) localStorage.setItem(draftKey(agent), value);
      else localStorage.removeItem(draftKey(agent));
    } catch { /* 隐私模式等 */ }
  };
  // 切会话：cleanup 把旧 agent 的当前输入存盘，effect 载入新 agent 草稿；
  // App 退后台（iOS 可能直接回收进程）立即存盘。
  useEffect(() => {
    if (!active) return;
    try { setText(localStorage.getItem(draftKey(active)) || ""); } catch { /* 同上 */ }
    const onHide = () => {
      if (document.visibilityState === "hidden") saveDraft(active, textRef.current);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      saveDraft(active, textRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // 随打随存（防进程被杀丢最后几秒输入）：300ms debounce
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => saveDraft(active, text), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active]);

  // ── 语音输入（2026-07-14 owner：应用内录音 → Groq 转写,根治输入法跳 App）──
  // 交互 = 按住说话(微信同款,owner 拍板):按下 🎤 开录(录音状态条+计时),
  // 松开结束 → 转圈识别 → 文字进输入框;按太短(<400ms)视为误触丢弃。
  const [recState, setRecState] = useState<"idle" | "recording" | "busy">("idle");
  const [recErr, setRecErr] = useState("");
  const [recSecs, setRecSecs] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const holdRef = useRef(false); // 手指是否仍按着(getUserMedia 授权期间可能已松手)
  const recStartRef = useRef(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashRecErr = (msg: string) => {
    setRecErr(msg);
    setTimeout(() => setRecErr(""), 4000);
  };
  const stopRecTimer = () => {
    if (recTimerRef.current !== null) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  };

  const holdStart = async () => {
    if (recState !== "idle") return;
    holdRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 授权弹窗期间手指可能已松开 → 立即归还麦克风
      if (!holdRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // iOS Safari 只支持 mp4/AAC;桌面 Chrome 用 webm/opus
      const mime =
        ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(
          (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)
        ) || "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRecTimer();
        const durMs = Date.now() - recStartRef.current;
        const type = mr.mimeType || "audio/mp4";
        const blob = new Blob(chunksRef.current, { type });
        if (durMs < 400 || blob.size < 1000) {
          setRecState("idle");
          flashRecErr("按住说话，松开结束");
          return;
        }
        setRecState("busy");
        try {
          const fd = new FormData();
          fd.append("audio", blob, `rec.${type.includes("mp4") ? "m4a" : "webm"}`);
          const res = await fetch("/api/chat/transcribe", { method: "POST", body: fd });
          const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (res.ok && typeof j.text === "string") {
            if (j.text) setText((prev) => (prev ? `${prev}${j.text}` : j.text!));
            else flashRecErr("没听清，再试一次");
          } else {
            flashRecErr(j.error || "识别失败");
          }
        } catch {
          flashRecErr("识别请求失败");
        } finally {
          setRecState("idle");
        }
      };
      mr.start();
      recRef.current = mr;
      recStartRef.current = Date.now();
      setRecSecs(0);
      recTimerRef.current = setInterval(
        () => setRecSecs(Math.floor((Date.now() - recStartRef.current) / 1000)),
        500
      );
      setRecState("recording");
      // start 完成时手指已松开(极快松手)→ 立即收尾
      if (!holdRef.current) mr.stop();
    } catch {
      // 主屏 PWA 的录音权限在部分 iOS 版本受限——提示换浏览器标签页用
      flashRecErr("无法访问麦克风（权限被拒,或当前模式不支持录音）");
    }
  };

  const holdEnd = () => {
    holdRef.current = false;
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  // ── 输入框整体 = 按住说话热区（2026-07-14 owner：「手按在聊天框上就是要说话」）──
  // 透明手势层盖在 textarea 上(仅未聚焦时):短按 = 正常聚焦打字;按住 ≥300ms =
  // 开录,松手 = 识别。聚焦编辑期间手势层退场,光标/选词不受影响。
  const [taFocused, setTaFocused] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressRef = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const HOLD_MS = 300;

  const overlayDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || recState !== "idle") return;
    e.preventDefault(); // 压掉 iOS 长按放大镜/呼出菜单
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* 老浏览器 */ }
    pressRef.current = { x: e.clientX, y: e.clientY, fired: false };
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      if (pressRef.current) {
        pressRef.current.fired = true;
        void holdStart();
      }
    }, HOLD_MS);
  };
  const overlayMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current;
    if (!p || p.fired) return;
    // 位移过大 = 想滑动/拖拽,取消长按判定
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12 && holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      pressRef.current = null;
    }
  };
  const overlayUp = () => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    const p = pressRef.current;
    pressRef.current = null;
    if (p?.fired) {
      holdEnd(); // 松手结束录音
    } else if (p) {
      // 短按 = 正常进入打字(手势层挡住了原生聚焦,手动补)
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        try { ta.setSelectionRange(len, len); } catch { /* 类型不支持 */ }
        // ⚠ iOS caret 错位根治(2026-07-27 用户截图:光标画到卡片左下角):
        // preventDefault + pointer capture 之后的程序化 focus,WebKit 会用陈旧
        // 几何画 caret(fixed 壳 + 横滑 transform 容器加剧)。下一帧把 value
        // 原样重灌一遍强制它重排 caret——内容/选区不变,不触发 input 事件,
        // React 受控值也不受影响。仅 coarse 指针端做(桌面无此 bug 不折腾)。
        if (window.matchMedia("(pointer: coarse)").matches) {
          requestAnimationFrame(() => {
            if (document.activeElement !== ta) return;
            const v = ta.value;
            ta.value = "";
            ta.value = v;
            try { ta.setSelectionRange(v.length, v.length); } catch { /* 同上 */ }
          });
        }
      }
    }
  };

  // 卸载/切会话时若还在录,收掉麦克风
  useEffect(() => {
    return () => {
      holdRef.current = false;
      stopRecTimer();
      try {
        recRef.current?.stream.getTracks().forEach((t) => t.stop());
      } catch { /* 已停止 */ }
    };
  }, [active]);

  // textarea 自适应高度。触到 180px 上限后内部滚动;非手动打字的写入
  // (语音识别回填)自动滚到底——否则长语音转出的文本尾部藏在框外,
  // 用户「看不到我最后说的话」(owner 2026-07-14)。手动打字不干预,
  // 浏览器自己保证光标可见。
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // 上限分端:桌面(sm+)输入区更高(owner 2026-07-24「桌面模式下太小」),
    // 与 className 的 max-h 断点保持一致
    const cap = window.matchMedia("(min-width: 640px)").matches ? 320 : 180;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
    if (document.activeElement !== ta) ta.scrollTop = ta.scrollHeight;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    // Skill 使用计数埋点(面板排序的频次数据源)——手打 / 和面板选择都覆盖
    const m = /^\/([\w:-]+)/.exec(text.trim());
    if (m) {
      void fetch("/api/skills/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: m[1] }),
      }).catch(() => {});
    }
    store.send(text, files.length ? files : undefined);
    setText("");
    setFiles([]);
    if (active) {
      try { localStorage.removeItem(draftKey(active)); } catch { /* 忽略 */ }
    }
  };

  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = ""; // 允许再次选择同一文件
  };

  // 粘贴带文件（截图 / 复制的文件）→ 附件。窗口级监听:桌面端焦点常常不在
  // 输入框(刚点完消息/侧栏),Ctrl+V 也要能收(owner 2026-07-24)。纯文本粘贴
  // files 为空不受影响;焦点在别的输入框(搜索/弹窗)时不劫持它的粘贴。
  useEffect(() => {
    if (disabled) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      const picked = Array.from(e.clipboardData?.files ?? []);
      if (!picked.length) return;
      const ae = document.activeElement;
      const isOtherInput =
        ae &&
        ae !== taRef.current &&
        (ae instanceof HTMLInputElement ||
          ae instanceof HTMLTextAreaElement ||
          (ae as HTMLElement).isContentEditable);
      if (isOtherInput) return;
      e.preventDefault();
      addFiles(picked);
      taRef.current?.focus();
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
    // addFiles 只调 setFiles 函数式更新,闭包旧引用无害
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // 触屏设备（pointer: coarse）：Enter/换行键 = 换行，发送只走按钮——手机键盘的
  // 「换行」键就该换行（2026-07-13 owner）。桌面保持 Enter 发送、Shift+Enter 换行。
  const coarse =
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 命令面板打开时接管导航键（桌面）：↑↓ 移动、Enter/Tab 填入、Esc 关闭
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSel((v) => Math.min(v + 1, slashItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSel((v) => Math.max(v - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashItems[Math.min(slashSel, slashItems.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !coarse) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="bg-base-100 px-6 pb-3 pt-2 sm:px-7"
      // max() 取大不叠加：home 条区(env≈34pt)本身就够输入卡与屏底的间距，
      // 再 +12px 双层叠出「过高的底部」（owner 真机反馈）。无安全区时回退 12px。
      // --cstra-kb-safe:键盘在场时(html.kb-open,flow 模式)安全区垫归零——
      // 键盘盖着 home 条区,34px 的垫会显示成键盘上方的一截空白
      style={{ paddingBottom: "max(var(--cstra-kb-safe, env(safe-area-inset-bottom)), 0.75rem)" }}
    >
      <div className="mx-auto max-w-3xl">
        {showCtxWarn && (
          <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs">
            <span className="min-w-0 truncate">
              ⚠️ {t("上下文已")} {Math.round(ctxTokens / 1000)}k{t("，建议压缩以保持质量")}
            </span>
            <button
              className="btn btn-warning btn-xs ml-auto shrink-0"
              onClick={() => {
                if (reqAt) return; // 双击竞态兜底(rerender 前的第二击)
                setCompactReqAt((m) => ({ ...m, [active]: Date.now() }));
                void store.send("上下文占用已经很高了，请执行 /save-compact：先抢救关键记忆，然后压缩上下文。");
              }}
            >
              {t("请求压缩")}
            </button>
            <button
              className="shrink-0 px-1 opacity-40 hover:opacity-80"
              aria-label={t("本会话不再提示")}
              onClick={() => setCtxDismissedFor(active)}
            >
              ✕
            </button>
          </div>
        )}

        {/* Slash 命令面板:输入 / 即弹,即时模糊过滤。onPointerDown preventDefault
            防抢走 textarea 焦点收键盘(control-bar 同款) */}
        {slashOpen && (
          <div className="mb-1.5 max-h-[42dvh] touch-pan-y overflow-y-auto overscroll-contain rounded-xl border border-base-content/10 bg-base-100 shadow-lg">
            {slashItems.map((c, i) => (
              <button
                key={c.name}
                type="button"
                className={`flex w-full items-baseline gap-2 px-3.5 py-2 text-left ${
                  i === slashSel ? "bg-base-200" : ""
                }`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pickSlash(c)}
              >
                <span className="shrink-0 font-mono text-[13.5px] font-semibold">/{c.name}</span>
                {c.argHint && (
                  <span className="shrink-0 font-mono text-[11px] text-base-content/35">{c.argHint}</span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-base-content/50">
                  {c.description}
                </span>
                <span className="shrink-0 rounded bg-base-200 px-1.5 py-0.5 text-[10px] text-base-content/45">
                  {t(SCOPE_LABEL[c.scope] || c.scope)}
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          className={`overflow-hidden rounded-2xl border bg-base-200 transition-colors ${
            streaming
              ? "border-info/40"
              : hasContent
                ? "border-accent/50"
                : "border-base-content/10"
          }`}
        >
          {/* 引用预览条(左滑消息块设置):显示将随下条消息前置的引用,✕ 取消 */}
          {quoteDraft && (
            <div className="flex items-center gap-2 border-b border-base-content/[0.06] bg-base-300/40 px-3.5 py-1.5 text-[11.5px]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-base-content/40">
                <path d="M9.5 8C7 8 5 10 5 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1C8.2 9.6 9 8.9 10 8.5L9.5 8zm7 0C14 8 12 10 12 12.7c0 2 1.5 3.6 3.4 3.6 1.7 0 3-1.3 3-3 0-1.6-1.2-2.8-2.8-2.8-.3 0-.6 0-.8.1.4-1 1.2-1.7 2.2-2.1L16.5 8z" />
              </svg>
              <span className="min-w-0 flex-1 truncate text-base-content/55">{quoteDraft}</span>
              <button
                className="shrink-0 p-0.5 text-base-content/40 hover:text-base-content/70"
                aria-label={t("取消引用")}
                onClick={() => store.clearQuote()}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          )}
          {/* 正在回复状态条：流式期间常驻，告知此刻发送会插入当前会话（回合边界后生效），
              暂停按钮就在下方。刷新 / 切回进行中的会话也会经 SSE 补拉进入此态。 */}
          {streaming && (
            <div className="flex items-center gap-2 border-b border-base-content/[0.06] bg-info/[0.06] px-3.5 py-1.5 text-[11.5px]">
              <span className="relative flex size-2 shrink-0 items-center justify-center">
                <span className="animate-cstra-breathe absolute inline-flex size-2 rounded-full bg-info" />
                <span className="relative inline-flex size-1.5 rounded-full bg-info" />
              </span>
              {/* 「正在回复」改「思考中」(owner 2026-07-24):回合大部分时间在思考/跑工具,
                  文字流出前说"正在回复"名不副实 */}
              <span className="font-medium text-base-content/70">{t("思考中…")}</span>
              {/* v2.15+ 遥测:TUI 状态行采样(3s)。token 在跳 = 活着;不显示时是
                  遥测暂缺(bridge 老版本/采样间隙),不占位 */}
              {telemetry && (telemetry.elapsed || telemetry.tokens != null) && (
                <span className="font-mono text-[10.5px] tabular-nums text-base-content/45">
                  {telemetry.elapsed || ""}
                  {telemetry.tokens != null && (
                    <> · ↓ {telemetry.tokens >= 1000 ? `${(telemetry.tokens / 1000).toFixed(1)}k` : telemetry.tokens} tokens</>
                  )}
                </span>
              )}
              <span className="ml-auto text-base-content/40 max-sm:hidden">
                {t("发送即追问——立刻插进当前对话，不用等它跑完")}
              </span>
            </div>
          )}

          <PendingFiles
            files={files}
            onRemove={(i) =>
              setFiles((prev) => prev.filter((_, idx) => idx !== i))
            }
          />

          {/* file input 移进 📎 按钮内部透明覆盖(见控件行)——iOS 的文件菜单
              锚定 <input type=file> 自身的盒子,hidden 没有盒子时菜单飘到屏幕
              半空(2026-07-27 用户截图,键盘关着也复现)。 */}

          {/* relative 包裹:录音状态条 + textarea + 按住说话手势层共用这块区域 */}
          <div className="relative">
          {/* 录音/识别状态条:按住期间替换输入区显示(红点脉冲+计时),松开转圈,
              完成后文字进输入框(textarea 隐藏不卸载,保内容与高度) */}
          {recState !== "idle" && (
            <div className="flex min-h-[46px] items-center gap-2.5 px-4 pb-1.5 pt-[14px]">
              {recState === "recording" ? (
                <>
                  <span className="relative flex size-3 shrink-0 items-center justify-center">
                    <span className="animate-cstra-breathe absolute inline-flex size-3 rounded-full bg-error" />
                    <span className="relative inline-flex size-2 rounded-full bg-error" />
                  </span>
                  <span className="text-[14px] font-medium text-error/90">
                    {t("正在录音")} {recSecs}s · {t("松开结束")}
                  </span>
                </>
              ) : (
                <>
                  <span className="loading loading-spinner loading-sm text-base-content/60" />
                  <span className="text-[14px] text-base-content/60">{t("识别中…")}</span>
                </>
              )}
            </div>
          )}
          <textarea
            ref={taRef}
            onFocus={() => setTaFocused(true)}
            onBlur={() => setTaFocused(false)}
            className={`${recState !== "idle" ? "hidden" : "block"} max-h-[180px] min-h-[46px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1.5 pt-[14px] text-[14.5px] leading-[1.55] text-base-content outline-none placeholder:text-base-content/35 sm:max-h-[320px] sm:min-h-[84px]`}
            rows={1}
            placeholder={
              disabled
                ? t("先选择一个会话…")
                : streaming
                  ? coarse
                    ? t("继续输入，随时插话…")
                    : `${t("继续输入，随时插话…")}${t("（Enter 发送）")}`
                  : coarse
                    ? `${t("发消息给")} ${active}`
                    : `${t("发消息给")} ${active}${t("（Enter 发送）")}`
            }
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* 按住说话手势层:未聚焦时盖在输入区上——短按补 focus 进打字,按住开录。
              录音中保持挂载(pointer capture 连续性,松手才能收到 up);识别中卸载。
              聚焦编辑期间退场,光标/选词不受影响。 */}
          {!taFocused && recState !== "busy" && !disabled && (
            <div
              className="absolute inset-0 select-none"
              style={{ touchAction: "none", WebkitTouchCallout: "none" } as React.CSSProperties}
              onPointerDown={overlayDown}
              onPointerMove={overlayMove}
              onPointerUp={overlayUp}
              onPointerCancel={overlayUp}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          </div>

          {/* 控件行 */}
          <div className="flex items-center gap-1.5 px-2.5 pb-[9px] pt-1.5">
            <button
              type="button"
              title={t("添加附件（也可直接粘贴）")}
              aria-label={t("添加附件")}
              disabled={disabled || files.length >= MAX_FILES}
              className="relative flex size-8 items-center justify-center overflow-hidden rounded-[9px] text-base-content/60 transition-colors hover:bg-base-content/[0.06] hover:text-base-content disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <PaperclipIcon />
              {/* 原生 input 透明铺满按钮:点击直达 input(无 .click() 转发),
                  iOS 把文件菜单锚在这个真实矩形上——位置就是按钮本身。
                  ⚠ overflow-hidden + text-[0] 缺一不可:iOS 的 file input 内部
                  原生控件有固有宽度,会从 32px 盒子向右透明溢出,把旁边的 /
                  (Skills)按钮整个盖住——点 Skills 弹出的全是文件菜单
                  (2026-07-28 用户实锤)。溢出被父级剪掉后不再参与命中。 */}
              {!(disabled || files.length >= MAX_FILES) && (
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  onChange={onPick}
                  aria-hidden
                  tabIndex={-1}
                  className="absolute inset-0 h-full w-full cursor-pointer text-[0] opacity-0"
                />
              )}
            </button>
            <button
              onClick={() => setSkillsOpen(true)}
              title={t("Skills（斜杠命令面板）")}
              aria-label={t("打开 Skills 面板")}
              disabled={disabled}
              className="flex size-8 items-center justify-center rounded-[9px] font-mono text-[15px] font-semibold text-base-content/60 transition-colors hover:bg-base-content/[0.06] hover:text-base-content disabled:opacity-30 disabled:hover:bg-transparent"
            >
              /
            </button>
            <button
              onPointerDown={(e) => {
                e.preventDefault(); // 不抢输入焦点/不触发长按系统菜单
                if (!disabled && recState === "idle") void holdStart();
              }}
              onPointerUp={holdEnd}
              onPointerCancel={holdEnd}
              onContextMenu={(e) => e.preventDefault()}
              title={t("按住说话，松开结束")}
              aria-label={t("按住说话")}
              disabled={disabled || recState === "busy"}
              style={{ touchAction: "none" }}
              className={`flex size-8 select-none items-center justify-center rounded-[9px] transition-colors disabled:opacity-30 ${
                recState === "recording"
                  ? "bg-error/20 text-error"
                  : "text-base-content/60 hover:bg-base-content/[0.06] hover:text-base-content"
              }`}
            >
              {recState === "busy" ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <MicIcon />
              )}
            </button>
            {recErr && recState === "idle" && (
              <span className="truncate text-[11px] text-error/70">{t(recErr)}</span>
            )}

            <div className="ml-auto flex items-center gap-1.5">
              {/* 流式期间：暂停与发送并列（不互斥替换）——可一边看回复一边输入插话 */}
              {streaming && (
                <button
                  onClick={() => store.interrupt()}
                  title={t("暂停（停止当前回复，Ctrl+C）")}
                  aria-label={t("暂停")}
                  className="flex size-[34px] items-center justify-center rounded-[10px] bg-base-content/15 text-base-content transition-colors hover:bg-base-content/25"
                >
                  <span className="block size-3 rounded-[2px] bg-current" />
                </button>
              )}
              <button
                onClick={submit}
                disabled={!canSend}
                title={
                  streaming ? t("追问（立刻插进当前对话）") : t("发送")
                }
                aria-label={t("发送")}
                className={`flex size-[34px] items-center justify-center rounded-[10px] transition-[background-color,transform] duration-150 active:scale-90 ${
                  canSend
                    ? "bg-accent text-white"
                    : "bg-base-300 text-base-content/40"
                }`}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </div>
      {skillsOpen && (
        <SkillsSheet
          skills={skills}
          onPick={(s) => {
            setText(`/${s.name} `);
            setSkillsOpen(false);
            // sheet 卸载后再聚焦,免得焦点被回收
            setTimeout(() => taRef.current?.focus(), 60);
          }}
          onClose={() => setSkillsOpen(false)}
        />
      )}
    </div>
  );
}
