/**
 * 授权卡的「批准的就是这个」（i28-OA1，peer He 10-02 建议）：建卡时由系统按 bind.action + params 生成，固定放在卡片说明最前面
 * （bridge/ask-reply.ts 接入）。agent 写的正文 / why 只能接在后面，替换不了也去不掉：否则被注入的 agent 可以在卡面写「调到 6」、bind 里放 10。
 * 纯函数，tests/ask-bind-render.test.ts。
 */
import type { AskBind } from "./ledger-asks.js";

/** 常见键的中文名（出借 / 借入声明）；其余按原键名 */
const LABELS: Record<string, string> = {
  "families.codex": "codex", "families.claude": "claude", until: "到期", repos: "仓库", projects: "项目", ordersPerDay: "每天单数",
  maxOpen: "同时在审", priority: "档位", codexModel: "codex 模型", codexEffort: "推理档", fp: "指纹", roles: "角色",
};

/** 值里只要有分隔符以外的字符就整段 JSON 引起来：agent 控制的字符串（peer 名之类）不能借「；」「=」在卡面伪造出别的键 */
const SAFE = /^[\w.:/@+-]*$/u;
const scalar = (v: unknown): string => (typeof v === "string" && SAFE.test(v) ? v : JSON.stringify(v ?? null));

function flatten(v: unknown, path: string, out: [string, string][]): void {
  if (Array.isArray(v)) {
    out.push([path, v.every((x) => typeof x !== "object" || x === null) ? v.map(scalar).join(",") : JSON.stringify(v)]);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort().filter((k) => o[k] !== undefined);
    if (!keys.length) out.push([path, "{}"]);
    for (const k of keys) flatten(o[k], path ? `${path}.${k}` : k, out);
  } else out.push([path, scalar(v)]);
}

/** 「动作：lend_grant；peer=team-a；codex=10；到期=…」；params 不是对象时整段写在「参数=」后面 */
export function renderBindSummary(bind: Pick<AskBind, "action" | "params" | "version">): string {
  const pairs: [string, string][] = [];
  flatten(bind.params, "", pairs);
  const parts = pairs.map(([k, v]) => `${k ? LABELS[k] ?? (/^[\w.-]+$/.test(k) ? k : JSON.stringify(k)) : "参数"}=${v}`);
  return [`动作：${bind.action}${bind.version ? `（版本 ${scalar(bind.version)}）` : ""}`, ...parts].join("；");
}

/** 系统那段在最前，agent 写的说明（可能为空）另起一行接在后面 */
export function withBindSummary(bind: Pick<AskBind, "action" | "params" | "version">, context: string | undefined): string {
  const head = `批准的就是这个 → ${renderBindSummary(bind)}`;
  return context?.trim() ? `${head}\n${context}` : head;
}

/**
 * 真正投出去的那条消息（Discord / 网页对话，owner 点按钮的地方）也要先看到系统那段：正文最前面单起一段。
 * 系统那段里的 markdown / 行内按钮符号全转义，agent 控制的值（peer 名之类）藏不了、折叠不了、伪造不出按钮。
 */
export function withBindSummaryText(bind: Pick<AskBind, "action" | "params" | "version">, content: string): string {
  const head = `批准的就是这个 → ${renderBindSummary(bind)}`.replace(/[\\`*_~|>#[\]()<]/g, "\\$&");
  return content.trim() ? `${head}\n\n${content}` : head;
}
