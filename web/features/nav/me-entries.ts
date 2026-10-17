/**
 * 「我的」条目表（NAVBAR1）：电脑图标栏底部的菜单和手机「我的」页都读这一张，原侧栏顶栏 8 个无字图标按钮的功能全在这里，每条有字。
 * 出现条件照旧：管理类（全部已读、项目管理、多选、伙伴机器、用量看板）背后的接口要全权凭据，只给全权设备；
 * 新终端只在 GET /shells 答 200 时出现；设置、图片与文件谁都有（/media 自己按 scope 过滤）。纯函数，测试直接调。
 */
export type MeIconName = "settings" | "projectAdmin" | "manage" | "peers" | "stats" | "shell" | "media" | "readAll";
export type MeId = "settings" | "readAll" | "projectAdmin" | "manage" | "peers" | "stats" | "shell" | "media";

export interface MeEntry {
  id: MeId;
  /** 全名（中文原文，经 navTr / 全局 t 翻译） */
  label: string;
  icon: MeIconName;
}

const ALL: readonly (MeEntry & { full?: boolean; shell?: boolean })[] = [
  { id: "settings", label: "设置", icon: "settings" },
  { id: "readAll", label: "全部已读", icon: "readAll", full: true },
  { id: "projectAdmin", label: "项目管理", icon: "projectAdmin", full: true },
  { id: "manage", label: "多选管理", icon: "manage", full: true },
  { id: "peers", label: "伙伴机器", icon: "peers", full: true },
  { id: "stats", label: "用量看板", icon: "stats", full: true },
  { id: "shell", label: "新终端", icon: "shell", shell: true },
  { id: "media", label: "图片与文件", icon: "media" },
];

/** full = 全权设备（useFullScope() === true）；shell = /shells 答过 200；manage = 正在多选（那条换成「退出多选」） */
export function meEntries({ full, shell, manage }: { full: boolean; shell: boolean; manage: boolean }): MeEntry[] {
  return ALL.filter((e) => (!e.full || full) && (!e.shell || shell))
    .map(({ id, label, icon }) => ({ id, icon, label: id === "manage" && manage ? "退出多选" : label }));
}
