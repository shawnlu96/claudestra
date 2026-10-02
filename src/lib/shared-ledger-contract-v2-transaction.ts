import { fail, id, parseFence, record, timestamp, type V2Fence } from "./shared-ledger-contract-v2-validation.js";
import { parseActor, type V2Actor } from "./shared-ledger-contract-v2-transfer.js";

type Scalar = string | number | null;
type Bindings = Readonly<Record<string, Scalar>>;
/** Only the composition root holds this adapter. Neither domains nor contexts receive it. */
export interface V2TransactionBackend {
  readonly inTransaction: boolean;
  prepare(sql: string): {
    all(bindings: Bindings): unknown[];
    run(bindings: Bindings): { changes: number | bigint };
  };
}
export interface V2Statement { readonly sql: string; readonly mode: "read" | "write" }
export interface V2TransactionScope extends V2Fence {
  readonly teamId: string; readonly projectId: string; readonly actor: V2Actor; readonly now: number;
}
declare const transactionBrand: unique symbol;
/** Named pre-registered statements, scalar binds and mandatory scope: no executable SQL or transaction handle. */
export interface V2TransactionContext {
  readonly [transactionBrand]: true;
  readonly scope: Readonly<V2TransactionScope>;
  assertActive(): void;
  all(statement: string, bindings?: Bindings): unknown[];
  run(statement: string, bindings?: Bindings): number;
}
declare const schemaBrand: unique symbol;
export interface V2SchemaContext {
  readonly [schemaBrand]: true;
  install(statement: string): void;
}
/** A domain exports these two functions; apply must propagate failure so X12 rolls back all domains/events/receipt. */
export interface V2DomainModule<Command, Result> {
  installSchema(context: V2SchemaContext): void;
  applyInTransaction(context: V2TransactionContext, command: Command): Result;
}

/** Reject multi-statements, comments and all transaction/connection controls before prepare.
 * Schema statements are owner-registered separately; runtime domains can only choose a granted name.
 */
function validateSql(sql: string, schema: boolean): void {
  if (schema && /^\s*CREATE\s+TRIGGER\b/i.test(sql)) { validateTrigger(sql); return; }
  if (typeof sql !== "string" || sql.length > 16000 || /;|--|\/\*|\*\/|\0/.test(sql)
    || /\b(?:BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(sql)) fail("transaction_control");
  const allowed = schema ? /^\s*(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)|ALTER\s+TABLE)\b/i : /^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i;
  if (!allowed.test(sql)) fail("transaction_control");
  if (!schema && (!sql.includes("$teamId") || !sql.includes("$projectId"))) fail("transaction_control");
}
/** Trigger BEGIN/END is SQLite grammar, not a transaction. Only one trigger body may reach prepare. */
function validateTrigger(sql: string): void {
  const match = sql.match(/^(\s*CREATE\s+TRIGGER\b[^;]+?)\bBEGIN\b([\s\S]+)\bEND\s*$/i);
  if (!match || sql.length > 16000 || /--|\/\*|\*\/|\0/.test(sql)
    || /\b(?:BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(match[1] + match[2])) fail("transaction_control");
  if (!match[2].split(";").filter(s => s.trim()).every(s => /^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(s))) fail("transaction_control");
}
const contexts = new WeakSet<object>();
export function assertTransactionContext(context: V2TransactionContext): void {
  if (!context || !contexts.has(context)) fail("transaction_required");
  context.assertActive();
}
/** X12 creates this facade once, registers statements, then supplies a context inside its own SQLite transaction.
 * This function never opens/commits/rolls back. Async callbacks are refused to keep the context within the transaction.
 */
export function createTransactionOwner(
  backend: V2TransactionBackend, statements: Readonly<Record<string, V2Statement>>, schemaStatements: Readonly<Record<string, string>> = {},
) {
  const entries = new Map(Object.entries(statements).map(([name, spec]) => {
    id(name); validateSql(spec.sql, false);
    if (spec.mode === "read" ? !/^\s*SELECT\b/i.test(spec.sql) : !/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(spec.sql)) fail("transaction_control");
    const parameters = new Set(Array.from(spec.sql.matchAll(/\$([A-Za-z_]\w*)/g), match => match[1]));
    return [name, { mode: spec.mode, sql: spec.sql, parameters }] as const;
  }));
  const installs = new Map(Object.entries(schemaStatements).map(([name, sql]) => {
    id(name); validateSql(sql, true); return [name, sql] as const;
  }));
  function requireTransaction() { if (!backend.inTransaction) fail("transaction_required"); }
  function within<T>(fn: (active: () => void) => T): T {
    requireTransaction();
    let open = true;
    const active = () => { if (!open || !backend.inTransaction) fail("transaction_closed"); };
    try {
      const result = fn(active);
      if (result && typeof (result as { then?: unknown }).then === "function") fail("transaction_control");
      active(); return result;
    } finally { open = false; }
  }
  return Object.freeze({
    installSchema<T>(fn: (context: V2SchemaContext) => T): T {
      return within(active => fn(Object.freeze({ install(name: string) {
        active(); const sql = installs.get(name); if (!sql) fail("forbidden"); backend.prepare(sql).run({});
      } }) as V2SchemaContext));
    },
    inCallerTransaction<T>(scope: V2TransactionScope, allowed: readonly string[], fn: (context: V2TransactionContext) => T): T {
      id(scope.teamId); id(scope.projectId); timestamp(scope.now); parseActor(scope.actor);
      parseFence({ serviceGeneration: scope.serviceGeneration, epoch: scope.epoch, bootId: scope.bootId });
      if (!scope.actor.projects.includes(scope.projectId)) fail("forbidden");
      const immutable = deepFreeze(structuredClone(scope));
      const reserved = {
        teamId: immutable.teamId, projectId: immutable.projectId, serviceGeneration: immutable.serviceGeneration,
        epoch: immutable.epoch, bootId: immutable.bootId, now: immutable.now, personId: immutable.actor.personId,
        instanceId: immutable.actor.instanceId, serviceId: immutable.actor.serviceId,
        representedPersonId: immutable.actor.representedPersonId, actorOrderId: immutable.actor.orderId,
      };
      const names = new Set(allowed);
      return within(active => {
        function operation(name: string, bindings: Bindings, mode: "read" | "write") {
          active(); const statement = entries.get(name);
          if (!names.has(name) || !statement || statement.mode !== mode) fail("forbidden");
          for (const [key, value] of Object.entries(record(bindings))) {
            if (Object.hasOwn(reserved, key) || !/^\w+$/.test(key)) fail("forbidden");
            if (!statement.parameters.has(key)) fail();
            if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) fail();
          }
          const values = { ...bindings, ...Object.fromEntries(Object.entries(reserved).filter(([key]) => statement.sql.includes(`$${key}`))) };
          if ([...statement.parameters].some(key => !Object.hasOwn(values, key))) fail();
          return { statement, args: Object.fromEntries(Object.entries(values).map(([key, value]) => [`$${key}`, value])) };
        }
        const context = Object.freeze({ scope: immutable, assertActive: active,
          all(name: string, bindings: Bindings = {}) {
            const op = operation(name, bindings, "read"); return structuredClone(backend.prepare(op.statement.sql).all(op.args));
          },
          run(name: string, bindings: Bindings = {}) {
            const op = operation(name, bindings, "write"); return Number(backend.prepare(op.statement.sql).run(op.args).changes);
          },
        }) as V2TransactionContext;
        contexts.add(context); return fn(context);
      });
    },
  });
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
