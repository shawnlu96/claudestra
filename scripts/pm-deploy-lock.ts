// 本机部署入口整机互斥 wrapper,逻辑在 src/lib/pm-deploy-lock-run.ts。用法:bun scripts/pm-deploy-lock.ts run --label deploy-full -- <命令> [参数...]
import { EXIT, lockStatus, runLocked, USAGE } from "../src/lib/pm-deploy-lock-run.ts";

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "run") return runLocked(rest);
  if (cmd === "status") return lockStatus();
  process.stderr.write(`${USAGE}\n`);
  return EXIT.usage;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
