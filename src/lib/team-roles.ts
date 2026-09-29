/**
 * 编排班子的内置角色（仓库 roles/*.md，docs/team/orchestration-team.md）→ Claude Code 启动参数。
 *   dispatcher：`--agents <json> --agent claudestra-dispatcher`——窄职责、主线程就是这个角色；json 里顺带两种审查员，它能直接派
 *   pm：`--agents <审查员 json> --append-system-prompt-file pm.md`——通用编码会话，保留默认系统提示与 CLAUDE.md，只追加角色
 *   executor：`--append-system-prompt-file executor.md`
 * 交互模式的 --agents 只收内联 JSON（传文件路径只在 -p 下可用），所以落盘成文件、由 buildClaudeCommand 拼成 `"$(cat 文件)"`：
 * 窗口里的 shell 启动时展开，tmux send-keys 的那一行不会被几 KB 的角色 JSON 撑长。
 * 为什么不装进 ~/.claude/agents：不碰用户全局目录（可能已有同名 agent），换机器、换项目不用安装，仓库更新后下次启动即新版。
 * 角色文件公开发布：只有 {{manager}} 这类占位符，落盘时才填本机路径（落在状态目录，沙箱随之隔离）。tests/team-roles.test.ts。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { statePath } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { writeJsonAtomicSync, writeTextAtomicSync } from "./state-file.js";

export const TEAM_ROLES = ["pm", "dispatcher", "executor"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const REVIEWER_AGENT = { regular: "claudestra-reviewer", adversarial: "claudestra-adversarial-reviewer" } as const;
const DISPATCHER_AGENT = "claudestra-dispatcher";

export function isTeamRole(v: unknown): v is TeamRole {
  return typeof v === "string" && (TEAM_ROLES as readonly string[]).includes(v);
}

export interface RoleDoc {
  name: string;
  description: string;
  body: string;
}

/** `---` frontmatter（只认单行 key: value）+ 正文；缺 name / description 抛错——角色文件坏了要在测试里就炸 */
export function parseRole(md: string): RoleDoc {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("角色文件缺 frontmatter");
  const fm = Object.fromEntries(
    m[1].split("\n").flatMap((l) => {
      const i = l.indexOf(":");
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : [];
    }),
  );
  if (!fm.name || !fm.description) throw new Error("角色文件 frontmatter 要有 name 和 description");
  return { name: fm.name, description: fm.description, body: m[2].trim() };
}

export interface RoleVars {
  /** 例如 `bun /abs/path/src/manager.ts` */
  manager: string;
}

/** 填占位符；有没认出的 {{x}} 就抛错（漏填的占位符进了系统提示，agent 会照着跑一条不存在的命令） */
export function renderRole(body: string, vars: RoleVars): string {
  const out = body.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in vars ? vars[k as keyof RoleVars] : all));
  const left = out.match(/\{\{\w+\}\}/);
  if (left) throw new Error(`角色文件里有没填的占位符 ${left[0]}`);
  return out;
}

export interface RoleSource {
  /** 仓库 roles/ 目录 */
  rolesDir: string;
  /** 落盘目录（状态目录下） */
  outDir: string;
  vars: RoleVars;
}

function load(src: RoleSource, file: string): RoleDoc {
  const doc = parseRole(readFileSync(join(src.rolesDir, `${file}.md`), "utf-8"));
  return { ...doc, body: renderRole(doc.body, src.vars) };
}

/** --agents 的 JSON：{名字: {description, prompt}}；不写 tools / model = 继承会话的（频道 MCP 工具因此都在） */
function agentsJson(docs: RoleDoc[]): Record<string, { description: string; prompt: string }> {
  return Object.fromEntries(docs.map((d) => [d.name, { description: d.description, prompt: d.body }]));
}

/** 一个角色落盘后的启动要素（claude-launch.ts 拼成命令行） */
export interface RoleLaunch {
  /** --agents 的 JSON 文件（命令行里以 "$(cat 文件)" 内联） */
  agentsFile?: string;
  /** --agent：主线程直接成为这个 agent */
  agent?: string;
  /** --append-system-prompt-file */
  promptFile?: string;
}

/**
 * 拼成 claude 命令行片段。交互模式的 --agents 只收内联 JSON：写成 "$(cat 文件)"，由窗口里的 shell 展开
 * （双引号里的替换结果不再分词），tmux send-keys 的一行保持短。esc = claude-launch 的 shellEscape（传进来免得循环依赖）
 */
export function roleFlags(r: RoleLaunch, esc: (s: string) => string): string[] {
  return [
    ...(r.agentsFile ? ["--agents", `"$(cat ${esc(r.agentsFile)})"`] : []),
    ...(r.agent ? ["--agent", esc(r.agent)] : []),
    ...(r.promptFile ? ["--append-system-prompt-file", esc(r.promptFile)] : []),
  ];
}

/**
 * 按角色落盘。落盘用原子写：同一台机器上几个 agent 同时启动也不会读到半截文件；
 * 已在跑的会话启动时就读完了文件，之后覆盖不影响它们。
 */
export function materializeRole(role: TeamRole, src: RoleSource): RoleLaunch {
  const reviewers = [load(src, "reviewer"), load(src, "adversarial-reviewer")];
  if (role === "dispatcher") {
    const agentsFile = join(src.outDir, "dispatcher-agents.json");
    writeJsonAtomicSync(agentsFile, agentsJson([load(src, "dispatcher"), ...reviewers]));
    return { agentsFile, agent: DISPATCHER_AGENT };
  }
  const promptFile = join(src.outDir, `${role}.md`);
  writeTextAtomicSync(promptFile, `${load(src, role).body}\n`);
  if (role === "executor") return { promptFile };
  const agentsFile = join(src.outDir, "reviewer-agents.json");
  writeJsonAtomicSync(agentsFile, agentsJson(reviewers));
  return { agentsFile, promptFile };
}

/**
 * 启动适配器（runtimes/claude-code.ts）用：registry 里的 role → 参数。没有 role / 不认识 → 不加参数。
 * 落盘失败（角色文件缺失、状态目录不可写）只报错不拦启动：少了角色提示的 agent 仍能干活，拉不起来就什么都做不了。
 */
export function roleLaunch(role: unknown): RoleLaunch | undefined {
  if (!isTeamRole(role)) return undefined;
  const repo = resolve(SRC_DIR, "..");
  try {
    return materializeRole(role, { rolesDir: join(repo, "roles"), outDir: statePath("roles"), vars: { manager: `bun ${join(repo, "src", "manager.ts")}` } });
  } catch (e) {
    console.error(`⚠️ 角色 ${role} 的启动参数生成失败，按无角色启动: ${(e as Error).message}`);
    return undefined;
  }
}
