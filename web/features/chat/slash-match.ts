/**
 * Composer 的 slash 命令面板匹配（纯函数，D8-9：从 composer.tsx 渲染体原样搬出，单测见
 * tests/web-slash-match.test.ts）。
 */

/** Slash 命令（bridge /skills 端点形状）。web 无 Discord 的 100 命令上限/描述截断。 */
export interface SlashCmd {
  name: string;
  invokeName: string;
  description: string;
  scope: string;
  argHint?: string;
}

/**
 * 只在输入命令 token 期间弹(无空格/换行):pickSlash 填入「/cmd 」带尾随空格
 * 即自动收起——否则填入后菜单基于新文本重新匹配(description 子串能撞上无关
 * 命令),二次回车被菜单拦截选中错误命令而不是发送(2026-07-24 owner:输 /save
 * 补全后再回车,期望发送却变成 Discord Configure)。
 * 返回小写的查询词（"/" 本身 → ""），不在命令 token 里 → null。
 */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
}

/**
 * 匹配优先级:name 前缀 > name 子串 > 仅 description 命中。不排序的话
 * skills 原序里 description 撞词的无关命令会排在 name 精确命中前——输 /save
 * 第一项竟是 discord-configure(描述含 "save the bot"),回车直接填错命令
 * (2026-07-24 owner 报障,Playwright 复现实锤)。sort 稳定,同级保持原序。最多 40 条。
 */
export function matchSlashCommands<T extends SlashCmd>(skills: T[], slashQ: string | null): T[] {
  const slashRank = (c: SlashCmd) => {
    const n = c.name.toLowerCase();
    if (slashQ && n.startsWith(slashQ)) return 0;
    if (slashQ && n.includes(slashQ)) return 1;
    return 2;
  };
  return slashQ !== null && skills.length
    ? skills
        .filter((c) => c.name.toLowerCase().includes(slashQ) || c.description.toLowerCase().includes(slashQ))
        .sort((a, b) => slashRank(a) - slashRank(b))
        .slice(0, 40)
    : [];
}
