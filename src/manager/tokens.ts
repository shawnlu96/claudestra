/**
 * HTTP API token 管理命令（token-add/list/revoke）。
 *
 * 从 manager.ts 逐字搬出（函数体未改，只加 export / 改相对路径）。
 */
import { loadRegistry, output } from "./core.js";

// ============================================================
// v2.6.0+ HTTP API token（多前端架构 Phase B，设计 §3.4 / §5.1 / R1）
// ============================================================

/**
 * token-add <name> --agents a,b [--force] [--no-mirror]
 * 生成一个 API token，scope 限定在指定 agent。secret 只显示这一次。
 * R1 防呆：目标 agent 未标 external:true（create --external）时要求 --force。
 */
export async function cmdTokenAdd(name: string, agentsCsv: string, force: boolean, noMirror: boolean, terminal: boolean) {
  const { readPrincipals, writePrincipals, newTokenPrincipal, tokenIdOf } =
    await import("../lib/principals.js");
  const agents = agentsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!name || agents.length === 0) {
    output({ ok: false, error: 'token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]' });
    return;
  }

  // scope 里的 agent 校验：存在性 + R1 external 检查（"*" 跳过存在性，仍警告）
  const reg = await loadRegistry();
  const warnings: string[] = [];
  for (const a of agents) {
    if (a === "*") {
      if (!force) {
        output({
          ok: false,
          error: `--agents "*" 会把全部 agent 开放给这个 token（master 除外）。上下文共享有泄密风险（R1），确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"*" scope：所有普通 agent 都对此 token 可见`);
      continue;
    }
    // "master" 是特殊 scope 值（大总管不在 registry）：显式列出 + --force 才放行
    if (a === "master") {
      if (!force) {
        output({
          ok: false,
          error: `--agents 含 "master" 会把大总管开放给这个 token（上下文最敏感，R1）。确认请加 --force。`,
        });
        return;
      }
      warnings.push(`"master" scope：大总管对此 token 可见`);
      continue;
    }
    const info = reg.agents[a] || reg.agents[`agent-${a}`];
    if (!info) {
      output({ ok: false, error: `agent "${a}" 不存在（registry 里没有 ${a} / agent-${a}）` });
      return;
    }
    if (!info.external && !force) {
      output({
        ok: false,
        error:
          `agent "${a}" 未标记为对外专用（external）。把日常在用的 agent 开放给外部 token，` +
          `对方可以套出该 agent 上下文里的既有内容（R1 共享上下文风险）。` +
          `建议：为外部用途新建专用 agent（create <name> <dir> --external）；` +
          `确实要开放这个就加 --force。`,
      });
      return;
    }
    if (!info.external) warnings.push(`"${a}" 未标 external，已用 --force 强制开放`);
  }

  if (terminal) {
    warnings.push(`--terminal：此 token 可开远程终端（往 agent 的 tmux 注入按键 = 宿主 shell 级访问，可绕过 --disallowedTools）`);
  }

  const file = await readPrincipals();
  const p = newTokenPrincipal(name, agents, { terminal });
  if (noMirror) p.mirror = false;
  file.principals.push(p);
  await writePrincipals(file);

  output({
    ok: true,
    tokenId: tokenIdOf(p),
    name,
    agents,
    mirror: p.mirror,
    terminal: p.terminal === true,
    secret: p.secret,
    secretNote: "⚠️ secret 只显示这一次，请立即保存。调用方式: Authorization: Bearer <secret>",
    warnings,
    usage: `curl -H "Authorization: Bearer ${p.secret}" -X POST http://<bridge>/api/v1/agents/${agents[0] === "*" ? "<agent>" : agents[0]}/messages -H "Content-Type: application/json" -d '{"text":"你好","wait":60}'`,
  });
}

export async function cmdTokenList() {
  const { readPrincipals, tokenIdOf } = await import("../lib/principals.js");
  const file = await readPrincipals();
  const tokens = file.principals
    .filter((p) => p.id.startsWith("token:"))
    .map((p) => ({
      tokenId: tokenIdOf(p),
      name: p.name,
      agents: p.agents,
      disabled: !!p.disabled,
      mirror: p.mirror !== false,
      createdAt: p.createdAt,
      secretPreview: p.secret ? `${p.secret.slice(0, 8)}…` : "",
    }));
  output({ ok: true, count: tokens.length, tokens });
}

export async function cmdTokenRevoke(idOrName: string) {
  const { readPrincipals, writePrincipals, findToken, tokenIdOf } =
    await import("../lib/principals.js");
  const file = await readPrincipals();
  const p = findToken(file, idOrName);
  if (!p) {
    output({ ok: false, error: `找不到 token: ${idOrName}（token-list 查看现有的）` });
    return;
  }
  file.principals = file.principals.filter((x) => x !== p);
  await writePrincipals(file);
  output({ ok: true, revoked: tokenIdOf(p), name: p.name, message: "token 已删除，立即失效" });
}
