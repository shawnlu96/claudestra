const WORDS: Record<string, string> = {
  "最低": "Minimal", "低": "Low", "中": "Medium", "高": "High", "超高": "Extra high", "最大": "Maximum", "极限": "Ultra",
  "每格显示服务端解析值；开关状态见下方，关闭时仍可编辑。": "Each cell shows the server-resolved value. Switch states are below; inactive cells remain editable.",
  "关闭或观察仅影响对应启动路径；类型格的继承仍会读取角色格。":
    "Off and observe affect only their launch path; task-type inheritance still reads undeclared role cells.",
  "安全下限：Claude 至少 Opus；跟随时也会检查『未声明』格，保存时校验。":
    "Security floor: Claude requires Opus or higher, including when following the undeclared cell. Checked on save.",
  "安全下限：Codex 只能跟随原档。": "Security floor: Codex must follow the original level.",
  "值不合法，请检查所选模型或推理档": "Invalid value; check the selected model or reasoning level",
  "开关对应项目": "Switches for project",
  "现存设置": "Stored setting", "不符合安全下限": "Security floor not met",
  "卡片模型": "Card models", "职责": "Role", "作者": "Author", "审查": "Reviewer", "对抗审查": "Adversarial reviewer", "PM 审查": "PM reviewer",
  "安全": "Security", "代码": "Code", "界面": "UI", "文档": "Docs", "未声明": "Undeclared",
  "任务类型": "Task types", "角色格": "Undeclared roles", "生效": "Active", "不生效": "Inactive",
  "只记录，不改启动参数": "Record only; launch arguments unchanged",
  "本页设置": "Page setting", "产品默认": "Product default", "跟随『未声明』那一格": "Follow the undeclared cell",
  "全局默认": "Global default", "跟随全局默认": "Follow global default", "跟随": "Follow", "降一档": "One level lower", "恢复产品默认": "Use product default",
  "Claude 模型": "Claude model", "Claude 推理档": "Claude reasoning", "Codex 模型": "Codex model", "Codex 推理档": "Codex reasoning",
  "保存": "Save", "已保存": "Saved", "加载中": "Loading", "加载失败": "Failed to load", "保存失败": "Save failed",
  "别处先改了，已刷新，请重新检查": "Changed elsewhere first. Refreshed; please review again",
  "会自动派子 agent，卡片会话里不建议使用": "Automatically spawns subagents; not recommended in card sessions",
  "原档不可核实，不猜降档": "Original level cannot be verified; no downgrade is guessed",
  "档位表文件读不了，正按默认表执行；修好文件权限后再保存": "The file is unreadable; defaults apply. Fix permissions before saving",
  "档位表文件内容不合法，正按默认表执行；保存一次即修复": "The file is invalid; defaults apply. Save once to repair",
  "原档位表文件损坏，已另存备份后按这次保存的内容重写": "The invalid file was backed up and repaired",
  "模型档位表正被别的请求修改，稍后再试": "Another request is editing the table; try again shortly",
  "读不了模型档位表文件，没有保存（详情见本机日志）": "Cannot read the settings file; nothing saved (see local log)",
  "这次修改不符合档位约束，没有保存": "The changes violate the model constraints; nothing saved",
  "保存模型档位表失败，没有生效（详情见本机日志）": "Could not save the settings; nothing changed (see local log)",
  "请求失败，请重试；安全类型须满足表中下限": "Request failed; retry and check the security floor shown in the table",
};
export const CARD_ROLE_LABELS: Record<string, string> = { author: "作者", reviewer: "审查", "adversarial-reviewer": "对抗审查", "pm-reviewer": "PM 审查" };
export const CARD_TIER_LABELS: Record<string, string> = { security: "安全", code: "代码", ui: "界面", docs: "文档", undeclared: "未声明" };
export const CARD_EFFORT_LABELS: Record<string, string> = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极限" };
export function cardModelT(lang: "zh" | "en", text: string): string {
  return lang === "zh" ? text : WORDS[text] ?? (/\p{Script=Han}/u.test(text) ? WORDS["请求失败，请重试；安全类型须满足表中下限"] : text);
}
/** 按完整 token 定位，不把 codex 当成 code；定位与原因分开翻译，避免整句回退丢掉格子。 */
export function cardModelError(raw: string, t: (s: string) => string): string {
  const has = (token: string) => new RegExp(`(?<![a-zA-Z0-9-])${token}(?![a-zA-Z0-9-])`, "i").test(raw);
  const role = Object.keys(CARD_ROLE_LABELS).find(has);
  const tier = raw.match(/\b(security|code|ui|docs|undeclared)(?=\.|\s+(?:的|卡的))/)?.[1];
  const family = has("codex") ? "Codex" : has("claude") || tier === "security" ? "Claude" : null;
  const location = [tier && t(CARD_TIER_LABELS[tier]), role && t(CARD_ROLE_LABELS[role]), family].filter(Boolean).join(" · ");
  if (!location) return t(raw);
  const reason = tier === "security" && /不得低于|只能沿用|只能跟随/.test(raw) ? "不符合安全下限" : "值不合法，请检查所选模型或推理档";
  return `${location}: ${t(reason)}`;
}
