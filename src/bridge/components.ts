/**
 * Discord UI 组件构建 + Typing indicator 管理
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  TextChannel,
  type MessageActionRowComponentBuilder,
} from "discord.js";

// ============================================================
// Typing Indicator
// ============================================================

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

export { typingIntervals }; // 暴露给状态检测用

export function startTyping(channelId: string, discord: any) {
  stopTyping(channelId);
  discord.channels
    .fetch(channelId)
    .then((ch: any) => {
      if (ch && "sendTyping" in ch)
        (ch as TextChannel).sendTyping().catch(() => {});
    })
    .catch(() => {});
  const interval = setInterval(() => {
    discord.channels
      .fetch(channelId)
      .then((ch: any) => {
        if (ch && "sendTyping" in ch)
          (ch as TextChannel).sendTyping().catch(() => {});
      })
      .catch(() => {});
  }, 8000);
  typingIntervals.set(channelId, interval);
}

export function stopTyping(channelId: string) {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
}

export function ensureTyping(channelId: string, discord: any) {
  if (!typingIntervals.has(channelId)) {
    startTyping(channelId, discord);
  }
}

// ============================================================
// Component Builder
// ============================================================

export function buildComponents(
  components: any[]
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  for (const comp of components) {
    if (comp.type === "buttons") {
      const row =
        new ActionRowBuilder<MessageActionRowComponentBuilder>();
      for (const btn of comp.buttons || []) {
        const style =
          btn.style === "primary"
            ? ButtonStyle.Primary
            : btn.style === "danger"
              ? ButtonStyle.Danger
              : btn.style === "success"
                ? ButtonStyle.Success
                : ButtonStyle.Secondary;
        const button = new ButtonBuilder()
          .setCustomId(btn.id)
          .setLabel(btn.label)
          .setStyle(style);
        if (btn.emoji) button.setEmoji(btn.emoji);
        row.addComponents(button);
      }
      rows.push(row);
    } else if (comp.type === "select") {
      const row =
        new ActionRowBuilder<MessageActionRowComponentBuilder>();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(comp.id)
        .setPlaceholder(comp.placeholder || "选择...");
      for (const opt of comp.options || []) {
        menu.addOptions({
          label: opt.label,
          value: opt.value,
          description: opt.description,
        });
      }
      row.addComponents(menu);
      rows.push(row);
    }
  }

  return rows;
}
