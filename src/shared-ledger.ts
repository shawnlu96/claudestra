import { Store } from "./shared-ledger/store.js";
import { LedgerService } from "./shared-ledger/service.js";
import { startServer } from "./shared-ledger/server.js";

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const option = (name: string) => args[args.indexOf(name) + 1];
  const path = args.includes("--db") ? option("--db") : undefined;
  const port = args.includes("--port") ? Number(option("--port")) : 0;
  if (!path || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Usage: --db <independent.sqlite> [--port <port>]");
  const store = new Store(path);
  const server = startServer(new LedgerService(store), { port });
  console.log(`Shared ledger listening on loopback port ${server.port}`);
  const stop = () => { server.stop(true); store.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
