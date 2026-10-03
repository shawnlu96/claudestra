import { Database } from "bun:sqlite";
import {
  createTransactionOwner, parseCommand, parseFeature, parseTask, parseWorkflow, parseActor, parseAuthorizationBind,
  V2_COMMAND_NAMES, v2ObjectDigest, type V2TransactionScope, type V2Statement, type V2Task,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import {
  createAsksDomain, asksSchema, asksStatements, proposalDigest, readAsk, type AskPorts, type AskCommand,
} from "../src/shared-ledger/asks/index.js";

export function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE fixture (teamId TEXT,projectId TEXT,id TEXT,body TEXT,PRIMARY KEY(teamId,projectId,id));
    CREATE TABLE fixture_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,teamId TEXT,projectId TEXT,body TEXT)`);
  const s = V2_FIXTURE_SCOPE;
  const seed = (id: string, body: unknown) => db.query("INSERT OR REPLACE INTO fixture VALUES (?,?,?,?)").run(s.teamId, s.projectId, id, JSON.stringify(body));
  const f = parseFeature(V2_DTO_FIXTURES.feature.valid);
  const rawTask = parseTask(V2_DTO_FIXTURES.task.valid);
  const t = parseTask({ ...rawTask, spec: { ...rawTask.spec, sharedDigest: "a".repeat(64), artifactId: "artifact", visibility: "approved_copy" } });
  seed("feature", f); seed("task", t); seed("workflow", V2_DTO_FIXTURES.workflow.valid);
  seed("dag", V2_DTO_FIXTURES.dag.valid); seed("owner", { personId: "person" });
  const statements: Record<string, V2Statement> = { ...asksStatements,
    "fixture.read": { mode: "read", sql: "SELECT body FROM fixture WHERE teamId=$teamId AND projectId=$projectId AND id=$id" },
    "fixture.write": { mode: "write", sql: "UPDATE fixture SET body=$body WHERE teamId=$teamId AND projectId=$projectId AND id=$id" },
    "fixture.event": { mode: "write", sql: "INSERT INTO fixture_events(teamId,projectId,body) VALUES ($teamId,$projectId,$body)" },
    "fixture.sequence": { mode: "read", sql: "SELECT MAX(seq) AS seq FROM fixture_events WHERE teamId=$teamId AND projectId=$projectId" },
  };
  const owner = createTransactionOwner(db, statements, asksSchema);
  let now = 2000, personId = "person", kind: "person" | "service" = "person", failEvent = false, failGraph = false;
  const read = (ctx: Parameters<AskPorts["readTask"]>[0], id: string) => {
    const row = ctx.all("fixture.read", { id })[0] as { body: string }; return JSON.parse(row.body);
  };
  const ports: AskPorts = {
    authorize() {},
    isOwner(ctx, person) { return read(ctx, "owner").personId === person; },
    readFeature(ctx, id) { return parseFeature(read(ctx, id)); },
    readTask(ctx, id) { return parseTask(read(ctx, id)); },
    readWorkflow(ctx) { return parseWorkflow(read(ctx, "workflow")); },
    readDag(ctx) { return read(ctx, "dag"); },
    readTasks(ctx) { return [parseTask(read(ctx, "task"))]; },
    replaceDag(ctx, feature, dag) {
      ctx.run("fixture.write", { id: "dag", body: JSON.stringify(dag) });
      ctx.run("fixture.write", { id: "feature", body: JSON.stringify({ ...feature, rev: feature.rev + 1, currentVersion: dag.version }) });
      if (failGraph) throw Error("graph write failed");
    },
    appendEvent(ctx, event) {
      ctx.run("fixture.event", { body: JSON.stringify(event) });
      if (failEvent) throw Error("event failed");
      return (ctx.all("fixture.sequence")[0] as { seq: number }).seq;
    },
  };
  const domain = createAsksDomain(ports);
  db.transaction(() => owner.installSchema(ctx => domain.installSchema(ctx)))();
  const scope = (): V2TransactionScope => ({ ...s, ...V2_FIXTURE_FENCE, now,
    actor: parseActor({ kind, personId, instanceId: "local", serviceId: kind === "service" ? "service" : null,
      representedPersonId: kind === "service" ? "person" : null, orderId: null, projects: ["project"], actions: V2_COMMAND_NAMES }) });
  const transaction = <T>(fn: (ctx: Parameters<AskPorts["readTask"]>[0]) => T) =>
    db.transaction(() => owner.inCallerTransaction(scope(), Object.keys(statements), fn))() as T;
  let request = 0;
  function command(type: AskCommand["type"], patch: Record<string, unknown> = {}): AskCommand {
    const base = V2_COMMAND_FIXTURES.find(c => c.type === type)!.valid;
    return parseCommand({ ...base, requestId: `request-${++request}`, payload: { ...base.payload, ...patch } }) as AskCommand;
  }
  const apply = (c: AskCommand, after?: () => void) => transaction<ReturnType<typeof domain.applyInTransaction>>(ctx => {
    const result = domain.applyInTransaction(ctx, c); after?.(); return result;
  });
  const create = () => apply(command("ask.create"));
  const propose = () => {
    const c = command("dag.propose", { baseDigest: v2ObjectDigest(V2_DTO_FIXTURES.dag.valid) }) as Extract<AskCommand, { type: "dag.propose" }>;
    c.payload.proposalDigest = proposalDigest(c.payload); return apply(c);
  };
  const decide = (result: ReturnType<typeof propose>, decision = "approved") => command("dag.decide", {
    proposalId: result.proposal!.id, proposalDigest: result.proposal!.proposalDigest, askId: result.ask.id, decision,
  });
  const answer = (ask: ReturnType<typeof create>["ask"], decision = "approved") => command("ask.answer", {
    askId: ask.id, expectedRev: ask.rev, bindDigest: v2ObjectDigest(ask.bind), answer: { kind: "text", text: "owner decision" }, decision,
  });
  const check = (ask: ReturnType<typeof create>["ask"]) => command("authorization.check", { askId: ask.id, bind: ask.bind });
  return { db, seed, ports, domain, owner, scope, transaction, command, apply, create, propose, decide, answer, check, t, f,
    bind: parseAuthorizationBind(V2_DTO_FIXTURES.authorizationBind.valid),
    getAsk: (id: string) => transaction<ReturnType<typeof readAsk>>(ctx => readAsk(ctx, id)),
    setNow: (value: number) => { now = value; }, setPerson: (value: string) => { personId = value; },
    setService: () => { kind = "service"; }, failEvent: () => { failEvent = true; }, failGraph: () => { failGraph = true; },
    mutateTask: (patch: Partial<V2Task>) => seed("task", { ...t, ...patch }),
    graph: () => JSON.parse((db.query("SELECT body FROM fixture WHERE id='dag'").get() as { body: string }).body),
  };
}
