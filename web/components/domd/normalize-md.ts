/**
 * 喂给 DOMD 之前的 markdown 归一化（2026-08-22 owner：「表格有时候不渲染了」）。
 *
 * 实测根因（Playwright 直接跑 do-md 的渲染，新旧两个版本各跑一遍）：do-md 只在
 * **块的第一行**就是 `|` 开头时才认表格 —— 表格前面必须空一行。所以
 *
 *     **这个盒子固件支持 4 个玛莎协议:**
 *     | 协议ID | 厂商 |
 *     |---|---|
 *
 * 整块被当成一个段落，竖线原样显示（行内的粗体 / `code` 照常渲染，所以看起来
 * 「只有表格没渲染」）。中间空一行就正常。
 *
 * 已验证：升级救不了 —— 我们用的 0.2.10 与最新的 0.11.2 行为一模一样，
 * 都要求表格自成块。所以在渲染前把这个空行补上，比换库 / 升级都稳。
 *
 * 判据刻意抄 do-md 自己的那两条（表头 `|` 开头 `|` 结尾、分隔行 /^\|[-:\s|]+$/），
 * 补出来的空行必然能让它认出表格，也不会在别处误伤。
 */

/** 表格行：`| a | b |` —— 与 do-md 一致，要求首尾都是竖线。 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

/** 分隔行：`|---|---|` / `| :-- | --: |`（do-md 的原正则）。 */
function isDelimiterRow(line: string): boolean {
  return /^\|[-:\s|]+$/.test(line.trim());
}

/** 围栏代码块的起止（``` 或 ~~~）。 */
function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * 在「紧贴上文的表格」前补一个空行，其余内容一字不动。
 * 代码围栏内不动 —— 那里的竖线是给人看的原文，不是要渲染的表格。
 */
export function padTableBlocks(md: string): string {
  if (!md || !md.includes("|")) return md; // 绝大多数消息在这里就返回了
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) inFence = !inFence;
    const prev = out[out.length - 1];
    if (
      !inFence &&
      prev !== undefined &&
      prev.trim() !== "" && // 已经空行了,不用补
      !isTableRow(prev) && // 上一行本身就是表格行 → 同一张表,别劈开
      isTableRow(line) &&
      isDelimiterRow(lines[i + 1] ?? "")
    ) {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}
