/**
 * 设置 ·「技能」页：本机的有效技能清单（lib/skill-library.ts）。
 *   GET /api/v1/skills/library → { roots: [{runtime, scope, dir, exists, project?, plugin?}], skills: LibrarySkill[] }
 * 要 manage：技能路径、项目目录都是机器信息。只读；启停 / 安装以后另开端点，写操作仍由 manager 做唯一写者。
 */
import { homedir } from "node:os";
import { canManage } from "../../lib/devices.js";
import { readPiGlobalEnv } from "../../lib/pi-env.js";
import type { Principal } from "../../lib/principals.js";
import { agentRuntime, readActiveAgents } from "../../lib/registry.js";
import { REPO_ROOT } from "../../lib/repo-root.js";
import { buildSkillLibrary, readInstalledPlugins } from "../../lib/skill-library.js";
import { apiJson, forbidden } from "../api-respond.js";

export async function handleSkillLibrary(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/skills/library" || req.method !== "GET") return null;
  if (!canManage(principal)) return forbidden("skills/library requires a credential with manage grant");
  const home = homedir();
  const agents = (await readActiveAgents())
    .filter((a) => a.cwd)
    .map((a) => ({ cwd: a.cwd!.replace(/^~/, home), runtime: agentRuntime(a) }));
  const lib = await buildSkillLibrary(
    { home, agents, plugins: readInstalledPlugins(home), piSkillPaths: readPiGlobalEnv().skillPaths },
    `${REPO_ROOT}/skills`,
  );
  return apiJson(200, { ok: true, ...lib });
}
