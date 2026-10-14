/**
 * CBUDGET2: the bridge merges page reads of the center feature list / feature detail. Several open team views (phone,
 * desktop, PM headless check) read the same list at the same time; the center limits per IP (2r/s), so the bridge sends one.
 * - GET features and GET features/<id> are keyed by state dir + credential (subject, and which credential: one subject can
 *   hold one per project and the center answers each by its own grants) + resource. A 200 result
 *   is reused for 10 seconds; callers of the same key while a read is in flight share that one Promise.
 * - Center 429 on a key: until Retry-After (5 seconds without one) the same key answers 429 with a Retry-After header
 *   without going to the network. Errors other than 429 are not remembered.
 * - Writes never go through here; a successful write (command / import / projection) by a credential subject drops that
 *   subject's cached list, so the next GET features goes out.
 */
import type { SharedLedgerLocalCredential } from "../../lib/shared-ledger-mode.js";
import { createHash } from "node:crypto";
import { SharedLedgerClient, SharedLedgerRemoteError, type SharedLedgerConnection } from "../../lib/shared-ledger-client.js";

const READ_CACHE_MS = 10_000;

type Subject = Pick<SharedLedgerLocalCredential, "centerId" | "teamId" | "kind" | "localSubject">;
type Credential = Subject & SharedLedgerConnection;
interface Entry { value?: unknown; expires: number; running?: Promise<unknown>; blockedUntil?: number; header?: string | null }
/** Retry-After as the handler holds it: the raw header of the center's 429, and the value to send back to the page */
export interface RetryAfterSlot { get(): string | null; set(value: string): void }

/** Clock is replaceable for tests only */
export const sharedLedgerReadClock = { now: Date.now };
const entries = new Map<string, Entry>();

const subjectKey = (c: Subject) => JSON.stringify([c.centerId, c.teamId, c.kind, c.localSubject]);
/** The bearer itself never sits in a key */
const credentialKey = (c: Credential) => JSON.stringify([c.baseUrl, c.personId, c.instanceId, createHash("sha256").update(c.bearer).digest("hex")]);
const keyOf = (scope: string, c: Credential, resource: string) => JSON.stringify([scope, subjectKey(c), credentialKey(c), resource]);

/** Merge a 429 cooldown into an entry: the later deadline (and the header that came with it) wins, never the latest reply */
function holdCooldown(e: Entry, block: { blockedUntil: number; header: string | null }): void {
  if (e.blockedUntil === undefined || block.blockedUntil > e.blockedUntil) Object.assign(e, block);
}

function prune(now: number) {
  for (const [key, e] of entries) if (!e.running && e.expires <= now && (e.blockedUntil ?? 0) <= now) entries.delete(key);
}

/**
 * Drop every cached feature list of this credential subject (any state dir): called after its write succeeded. The cached
 * value and any in-flight read become obsolete, but an active 429 cooldown stays: a write does not lift the center's limit.
 */
function forgetSharedLedgerList(c: Subject): void {
  const subject = subjectKey(c), now = sharedLedgerReadClock.now();
  for (const [key, e] of entries) {
    const [, s, , resource] = JSON.parse(key) as [string, string, string, string];
    if (s !== subject || resource !== "features") continue;
    if (e.blockedUntil !== undefined && now < e.blockedUntil) entries.set(key, { expires: 0, blockedUntil: e.blockedUntil, header: e.header });
    else entries.delete(key);
  }
}

/** Tests only */
export function clearSharedLedgerReadCache(): void { entries.clear(); }

/**
 * Read `resource` through the cache. `read` goes to the center through the handler's client; `retry` is the handler's
 * Retry-After slot (the transport error holds the center's header; a cached 429 writes its remaining seconds into it).
 */
export async function cachedSharedLedgerRead<T>(scope: string, credential: Credential, resource: string,
  read: () => Promise<T>, retry: RetryAfterSlot): Promise<T> {
  const now = sharedLedgerReadClock.now();
  prune(now);
  const key = keyOf(scope, credential, resource);
  let entry = entries.get(key);
  if (entry?.blockedUntil !== undefined && now < entry.blockedUntil) {
    const seconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    retry.set(String(seconds));
    throw new SharedLedgerRemoteError(429, { error: "rate limited" }, seconds * 1000);
  }
  if (entry && !entry.running && "value" in entry && now < entry.expires) return entry.value as T;
  if (!entry?.running) {
    const mine: Entry = { expires: 0 };
    entries.set(key, (entry = mine));
    mine.running = read().then((value) => {
      if (entries.get(key) === mine) Object.assign(mine, { value, expires: sharedLedgerReadClock.now() + READ_CACHE_MS });
      return value;
    }, (error: unknown) => {
      if (error instanceof SharedLedgerRemoteError && error.status === 429) {
        // The cooldown holds even when a write made this read obsolete meanwhile
        const at = sharedLedgerReadClock.now(), header = error.retryAfter;
        const block = { blockedUntil: at + error.retryAfterMs, header };
        holdCooldown(mine, block);
        const current = entries.get(key);
        if (current && current !== mine) holdCooldown(current, block);
        else if (!current) entries.set(key, { expires: 0, ...block });
      } else if (entries.get(key) === mine) entries.delete(key);
      throw error;
    }).finally(() => { delete mine.running; });
  }
  const shared = entry;
  try { return (await shared.running) as T; }
  catch (error) {
    // Callers that joined the in-flight read answer with the same Retry-After the center gave the first caller
    const header = shared.header;
    if (header && retry.get() === null) retry.set(header);
    throw error;
  }
}

// Writes go through SharedLedgerClient (the handler's POST branch); a successful one drops the writer's cached list.
const proto = SharedLedgerClient.prototype as unknown as Record<"command" | "import" | "projection", (...args: unknown[]) => Promise<unknown>>;
for (const name of ["command", "import", "projection"] as const) {
  const original = proto[name];
  proto[name] = async function (this: SharedLedgerClient, ...args: unknown[]) {
    const result = await original.apply(this, args);
    const c = this.connection as Partial<Subject> & SharedLedgerClient["connection"];
    if (typeof c.localSubject === "string" && (c.kind === "person" || c.kind === "service")) forgetSharedLedgerList(c as Subject);
    return result;
  };
}
