/** 括号内是工具匹配表达式；按普通空白切开会破坏 Bash 命令规则。 */
export function parseDisallowedRules(raw: string): string[] {
  const rules: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "\\") { i++; continue; }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (depth === 0 && /[\s,]/u.test(char)) {
      const rule = raw.slice(start, i).trim();
      if (rule) rules.push(rule);
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last) rules.push(last);
  return rules;
}

/** Claude Code 2.1.287 的 Op 切分逻辑：布尔括号状态，分隔符仅为空格和逗号。
 * 不能用深度解析替代，否则嵌套右括号后的分隔符会让展示与实际生效规则不一致。
 */
export function splitClaudeDisallowedRules(raw: string): string[] {
  const rules: string[] = [];
  let inside = false, current = "";
  for (const char of raw) {
    if (char === "(") inside = true;
    else if (char === ")") inside = false;
    else if (!inside && (char === " " || char === ",")) {
      if (current.trim()) rules.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) rules.push(current.trim());
  return rules;
}

/** 保存前校验；返回错误让命令在读取或写入 registry 前拒绝输入。 */
export function validateDisallowedRules(raw: string): string | undefined {
  const rules = parseDisallowedRules(raw);
  if (!rules.length) return "--disallowed 清单为空（第 1 条规则缺失）";
  for (const [index, rule] of rules.entries()) {
    const error = `--disallowed 第 ${index + 1} 条规则 ${JSON.stringify(rule)}`;
    let depth = 0;
    let closedAt = -1;
    let openAt = -1;
    for (let i = 0; i < rule.length; i++) {
      if (rule[i] === "\\") { i++; continue; }
      if (rule[i] === "(") {
        if (closedAt >= 0 && depth === 0) return `${error}：应为工具名或工具名(…)`;
        if (openAt < 0) openAt = i;
        depth++;
      }
      else if (rule[i] === ")") {
        if (--depth < 0) return `${error}：括号不配对`;
        if (depth === 0) closedAt = i;
      }
    }
    if (depth !== 0) return `${error}：括号不配对`;
    const tool = openAt < 0 ? rule : rule.slice(0, openAt);
    const validTool = /^[A-Za-z_][A-Za-z0-9_:-]*$/u.test(tool) || /^mcp__[A-Za-z0-9_*:-]+$/u.test(tool);
    if (!validTool || (openAt >= 0 && closedAt !== rule.length - 1)) {
      return `${error}：应为工具名或工具名(…)`;
    }
    const actual = splitClaudeDisallowedRules(rule);
    if (actual.length !== 1 || actual[0] !== rule) {
      return `${error}：Claude Code 会把它拆成 ${JSON.stringify(actual)}`;
    }
  }
}
