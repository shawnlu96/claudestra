import type { Database } from "bun:sqlite";
import { H2 } from "./scheduler-auto-helpers.js";

export function addSeat(db: Database, id: string, role = "reviewer", stage = "review") {
  db.run("PRAGMA foreign_keys=OFF");
  db.query(`INSERT INTO tasks (id,project,title,kind,stage,agent,round,headSHA,createdAt,updatedAt)
    VALUES (?,'p',?,'code',?,?,2,?,0,0)`).run(id, id, stage, role === "author" ? id : `writer-${id}`, H2);
  db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (0,'owner','p',?,'task','','{"op":"new"}')`).run(id);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,?,?,?,'codex','acp','active','created',0,0)`).run(id, role, id, `s-${id}`);
}
export function reviewEffect(db: Database, id: string, status: string, head = H2) {
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,status,recipient,reason,causalSeq,taskRev,specRev,head,
    templateVersion,eventSeq,createdAt,updatedAt) VALUES (? ,?,'p','adversarial_review','review',?,?,'test',1,1,1,?,2,1,0,0)`)
    .run(`effect-${id}`, id, status, id, head);
}
export function reviewEvent(db: Database, id: string, head = H2, round = 2, session = `s-${id}`) {
  db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (0,'reviewer','p',?,'review','',?)`)
    .run(id, JSON.stringify({ head, round, reviewer: id, reviewerFamily: "codex", reviewerSessionId: session, verdict: "pass" }));
}
