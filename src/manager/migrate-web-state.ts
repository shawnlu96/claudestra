/**
 * `manager migrate-web-state`：旧 Next BFF 的数据搬进 bridge。逻辑在 lib/web-state-migrate.ts（install-cli 的自动迁移也用它）；
 * 这里只接仓库的真实路径（web/.env.local → 根 .env 的推送配置）并输出结果。
 */
import { join } from "node:path";
import { REPO_ROOT } from "../lib/repo-root.js";
import { migrateWebState } from "../lib/web-state-migrate.js";
import { output } from "./core.js";

export async function cmdMigrateWebState(): Promise<void> {
  output({ ...(await migrateWebState({ env: { webEnvLocal: join(REPO_ROOT, "web", ".env.local"), envFile: join(REPO_ROOT, ".env") } })) });
}
