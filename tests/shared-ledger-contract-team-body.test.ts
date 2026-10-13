import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/lib/canonical-json.js";
import {
  TEAM_BODY_BATCH_MAX_BYTES, TEAM_BODY_BATCH_MAX_RECORDS, TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS, TEAM_BODY_CLAIM_WAIT_MAX_MS,
  TEAM_BODY_ERROR_CODES, TEAM_BODY_KINDS, TEAM_BODY_PAGE_LIMIT_MAX, TEAM_BODY_PATHS, TEAM_BODY_STATUS, TEAM_BODY_TEXT_MAX_BYTES,
  parseTeamBodyCapability, parseTeamBodyError, parseTeamBodyPageClaim, parseTeamBodyPageClaimed, parseTeamBodyPageRead,
  parseTeamBodyPageRequest, parseTeamBodyPageReturn, parseTeamBodyPageTicket, parseTeamBodyRead, parseTeamBodyRecord, parseTeamBodyUpload,
  parseTeamBodyUploadReceipt, teamBodyDigest, teamBodyReceiptMatches, teamBodyUploadBytes,
  type TeamBodyKind, type TeamBodyRecord, type TeamBodyUpload, type TeamBodyUploadReceipt,
} from "../src/lib/shared-ledger-contract-team-body.js";

const rec = (kind: TeamBodyKind, sourceKey: string, text: string, extra: Partial<TeamBodyRecord> = {}): TeamBodyRecord => ({
  featureId: "feat-1", taskId: "task-1", kind, sourceKey, text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text), ...extra,
});
const records = [rec("event", "12", "开工：先读规格"), rec("review", "13", "P1：缺少校验", { maskedSegments: 2 }), rec("spec", "3", "# 规格\n正文")];
const pages = [rec("session-page", "page:40", "user: 你好"), rec("session-page", "page:41", "assistant: 在")];
const batchId = "ab".repeat(16);
const upload: TeamBodyUpload = { schemaVersion: 1, projectId: "proj-1", sourceInstanceId: "home-1", batchId, records };
const receipt: TeamBodyUploadReceipt = { schemaVersion: 1, batchId, results: [
  { taskId: "task-1", kind: "event", sourceKey: "12", status: "stored", code: null },
  { taskId: "task-1", kind: "review", sourceKey: "13", status: "unchanged", code: null },
  { taskId: "task-1", kind: "spec", sourceKey: "3", status: "refused", code: "not_open" },
] };
const read = { schemaVersion: 1, teamId: "team-a", projectId: "proj-1", featureId: "feat-1", taskId: "task-1", records, syncedAt: 1_700_000_000_000, homeOnline: true };
const pageRequest = { schemaVersion: 1, projectId: "proj-1", featureId: "feat-1", taskId: "task-1", cursor: null, limit: 200 };
const pending = { requestId: "req-1", expiresAt: 1_700_000_060_000, projectId: "proj-1", featureId: "feat-1", taskId: "task-1", cursor: "c:39", limit: 50 };
const page = { kind: "page", records: pages, nextCursor: "c:42" };
const pageReturn = { schemaVersion: 1, requestId: "req-1", sourceInstanceId: "home-1", result: page };
const pageRead = { schemaVersion: 1, requestId: "req-1", status: "ready", expiresAt: 1_700_000_060_000, homeOnline: true, result: page };

const refuses = (parse: (v: unknown) => unknown, value: unknown) => expect(() => parse(value)).toThrow("invalid_field");
const without = (value: object, key: string): Record<string, unknown> => {
  const { [key]: _drop, ...rest } = value as Record<string, unknown>;
  return rest;
};
const withRecord = (r: unknown) => ({ ...upload, records: [r] });

describe("team body constants", () => {
  test("kinds, error codes, statuses and limits are fixed", () => {
    expect([...TEAM_BODY_KINDS]).toEqual(["event", "review", "spec", "session-page"]);
    expect([...TEAM_BODY_ERROR_CODES]).toEqual(["home_offline", "not_member", "gate_refused", "not_open", "expired"]);
    expect(TEAM_BODY_STATUS).toEqual({ ok: 200, invalid: 400, not_member: 403, gate_refused: 403, unsupported: 404, not_open: 409, expired: 410, home_offline: 503 });
    expect(TEAM_BODY_TEXT_MAX_BYTES).toBe(921_600);
    expect(TEAM_BODY_BATCH_MAX_BYTES).toBe(1_048_576);
    expect(TEAM_BODY_PAGE_LIMIT_MAX).toBe(200);
    for (const path of Object.values(TEAM_BODY_PATHS)) expect(path.startsWith("/v1/teams/{teamId}/team-body/")).toBe(true);
  });
  test("claim long poll: one wait and the idle interval are both 8 s, under Bun's default 10 s idle timeout", () => {
    expect(TEAM_BODY_CLAIM_WAIT_MAX_MS).toBe(8_000);
    expect(TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS).toBe(8_000);
    expect(TEAM_BODY_CLAIM_WAIT_MAX_MS).toBeLessThan(10_000);
  });
});

describe("team body records and upload batch", () => {
  test("legal samples of every kind parse to themselves", () => {
    expect(parseTeamBodyUpload(upload)).toEqual(upload);
    expect(parseTeamBodyUpload(withRecord(pages[0]))).toEqual(withRecord(pages[0]) as TeamBodyUpload);
    expect(parseTeamBodyUpload(withRecord(rec("event", "0", "")))).toBeDefined();
  });
  test("a missing or extra field is refused, scrubVersion included", () => {
    for (const key of Object.keys(upload)) refuses(parseTeamBodyUpload, without(upload, key));
    for (const key of Object.keys(records[0]!)) refuses(parseTeamBodyUpload, withRecord(without(records[0]!, key)));
    refuses(parseTeamBodyUpload, withRecord(without(records[0]!, "scrubVersion")));
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], scrubVersion: 0 }));
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], scrubVersion: "1" }));
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], maskedSegments: -1 }));
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], author: "someone" }));
    refuses(parseTeamBodyUpload, { ...upload, schemaVersion: 2 });
  });
  test("an unknown kind is refused", () => {
    for (const kind of ["session", "comment", "", "Event", null]) refuses(parseTeamBodyUpload, withRecord({ ...records[0], kind }));
  });
  test("text over 900 KiB is refused, counted in UTF-8 bytes", () => {
    const full = "a".repeat(TEAM_BODY_TEXT_MAX_BYTES);
    expect(parseTeamBodyUpload(withRecord(rec("event", "1", full))).records[0]!.text).toHaveLength(TEAM_BODY_TEXT_MAX_BYTES);
    refuses(parseTeamBodyUpload, withRecord(rec("event", "1", `${full}a`)));
    // 307201 CJK characters are under the limit as characters and over it as bytes (3 each)
    refuses(parseTeamBodyUpload, withRecord(rec("event", "1", "文".repeat(307_201))));
    refuses(parseTeamBodyUpload, withRecord(rec("event", "1", "a\0b")));
  });
  test("digest must be sha256 of the text; event / review / spec keys are canonical decimals", () => {
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], digest: teamBodyDigest("别的正文") }));
    refuses(parseTeamBodyUpload, withRecord({ ...records[0], digest: "xyz" }));
    for (const key of ["01", "-1", "1.5", "abc", "", "12345678901234567"]) refuses(parseTeamBodyUpload, withRecord({ ...records[0], sourceKey: key }));
    refuses(parseTeamBodyUpload, withRecord({ ...records[2], sourceKey: "rev3" }));
    refuses(parseTeamBodyUpload, withRecord({ ...pages[0], sourceKey: "page 40" }));
  });
  test("batch bounds: not empty, no duplicate key, record count and total bytes capped", () => {
    refuses(parseTeamBodyUpload, { ...upload, records: [] });
    refuses(parseTeamBodyUpload, { ...upload, records: [records[0], records[0]] });
    expect(parseTeamBodyUpload({ ...upload, records: [records[0], { ...records[0], kind: "review" }] }).records).toHaveLength(2);
    const many = Array.from({ length: TEAM_BODY_BATCH_MAX_RECORDS + 1 }, (_, i) => rec("event", String(i), "x"));
    expect(parseTeamBodyUpload({ ...upload, records: many.slice(1) }).records).toHaveLength(TEAM_BODY_BATCH_MAX_RECORDS);
    refuses(parseTeamBodyUpload, { ...upload, records: many });
    refuses(parseTeamBodyUpload, { ...upload, batchId: "short" });
  });
  test("one record checks alone as a batch would: a NUL in the text is refused", () => {
    expect(parseTeamBodyRecord(records[0])).toEqual(records[0]);
    refuses(parseTeamBodyRecord, rec("event", "1", "含\0空字符"));
    refuses(parseTeamBodyUpload, withRecord(rec("event", "1", "含\0空字符")));
  });
  test("a batch is capped at 1 MiB of request body, metadata, escaping and transport envelope included", () => {
    const sized = (text: string, n: number) => ({ ...upload, records: Array.from({ length: n }, (_, i) => rec("event", String(i), text)) });
    // One record of full text fits; two do not, though each is within the per-record cap.
    const full = "b".repeat(TEAM_BODY_TEXT_MAX_BYTES);
    expect(teamBodyUploadBytes(sized(full, 1))).toBeLessThanOrEqual(TEAM_BODY_BATCH_MAX_BYTES);
    expect(parseTeamBodyUpload(sized(full, 1)).records).toHaveLength(1);
    refuses(parseTeamBodyUpload, sized(full, 2));
    // The measure is the signed request body: the batch inside {attemptNonce, payload}, with the longest nonce allowed.
    for (const nonce of ["0".repeat(48), "0".repeat(64)]) {
      expect(teamBodyUploadBytes(upload)).toBeGreaterThanOrEqual(Buffer.byteLength(canonicalJson({ attemptNonce: nonce, payload: upload }), "utf8"));
    }
    expect(teamBodyUploadBytes(upload)).toBe(Buffer.byteLength(canonicalJson({ attemptNonce: "0".repeat(64), payload: upload }), "utf8"));
    // Exactly at the cap is accepted, one byte over is refused.
    const pair = (tail: string) => ({ ...upload, records: [rec("event", "1", full), rec("event", "2", tail)] });
    const pad = TEAM_BODY_BATCH_MAX_BYTES - teamBodyUploadBytes(pair(""));
    expect(teamBodyUploadBytes(pair("c".repeat(pad)))).toBe(TEAM_BODY_BATCH_MAX_BYTES);
    expect(parseTeamBodyUpload(pair("c".repeat(pad))).records).toHaveLength(2);
    refuses(parseTeamBodyUpload, pair("c".repeat(pad + 1)));
    // Quotes and line breaks double on the wire: 600 KiB of them is under the text cap and over the batch cap.
    for (const ch of ['"', "\n", "\\"]) {
      const text = ch.repeat(600 * 1024);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(TEAM_BODY_TEXT_MAX_BYTES);
      refuses(parseTeamBodyUpload, sized(text, 1));
    }
    // Four 200 KiB records that would pass a text-byte sum fail once their quotes are escaped.
    const quoted = '"'.repeat(200 * 1024);
    expect(4 * Buffer.byteLength(quoted)).toBeLessThan(TEAM_BODY_BATCH_MAX_BYTES);
    refuses(parseTeamBodyUpload, sized(quoted, 4));
    expect(parseTeamBodyUpload(sized("q".repeat(200 * 1024), 4)).records).toHaveLength(4);
  });
});

describe("team body upload receipt", () => {
  test("legal receipt parses and matches the batch it answers", () => {
    expect(parseTeamBodyUploadReceipt(receipt)).toEqual(receipt);
    expect(teamBodyReceiptMatches(upload, receipt)).toBe(true);
    expect(teamBodyReceiptMatches(upload, { ...receipt, batchId: "cd".repeat(16) })).toBe(false);
    expect(teamBodyReceiptMatches(upload, { ...receipt, results: receipt.results.slice(1) })).toBe(false);
    expect(teamBodyReceiptMatches(upload, { ...receipt, results: [...receipt.results].reverse() })).toBe(false);
  });
  test("code is set exactly when refused; unknown status / code refused", () => {
    const one = (r: object) => ({ ...receipt, results: [{ ...receipt.results[0], ...r }] });
    refuses(parseTeamBodyUploadReceipt, one({ status: "refused" }));
    refuses(parseTeamBodyUploadReceipt, one({ code: "not_open" }));
    refuses(parseTeamBodyUploadReceipt, one({ status: "refused", code: "forbidden" }));
    refuses(parseTeamBodyUploadReceipt, one({ status: "queued" }));
    refuses(parseTeamBodyUploadReceipt, { ...receipt, results: [receipt.results[0], receipt.results[0]] });
    for (const key of Object.keys(receipt)) refuses(parseTeamBodyUploadReceipt, without(receipt, key));
  });
});

describe("team body member read", () => {
  test("legal response carries syncedAt and homeOnline; never-synced is null with no records", () => {
    expect(parseTeamBodyRead(read)).toEqual(read as ReturnType<typeof parseTeamBodyRead>);
    expect(parseTeamBodyRead({ ...read, records: [], syncedAt: null, homeOnline: false }).syncedAt).toBeNull();
  });
  test("missing fields, records of another task and tampered text are refused", () => {
    for (const key of Object.keys(read)) refuses(parseTeamBodyRead, without(read, key));
    refuses(parseTeamBodyRead, { ...read, homeOnline: "yes" });
    refuses(parseTeamBodyRead, { ...read, syncedAt: -1 });
    refuses(parseTeamBodyRead, { ...read, records: [{ ...records[0], taskId: "task-2" }] });
    refuses(parseTeamBodyRead, { ...read, records: [{ ...records[0], featureId: "feat-2" }] });
    refuses(parseTeamBodyRead, { ...read, records: [{ ...records[0], text: "被改过" }] });
    refuses(parseTeamBodyRead, { ...read, records: [records[0], records[0]] });
  });
});

describe("team body capability probe", () => {
  const body = { schemaVersion: 1, teamId: "team-a", teamBody: true };
  test("200 answers the bit; a center without the probe (404) is unsupported whatever the body", () => {
    expect(parseTeamBodyCapability(200, body)).toEqual({ supported: true });
    expect(parseTeamBodyCapability(200, { ...body, teamBody: false })).toEqual({ supported: false });
    expect(parseTeamBodyCapability(404, "<html>not found</html>")).toEqual({ supported: false });
    expect(parseTeamBodyCapability(404, undefined)).toEqual({ supported: false });
  });
  test("a malformed 200 or another status is not an answer", () => {
    refuses((v) => parseTeamBodyCapability(200, v), without(body, "teamBody"));
    refuses((v) => parseTeamBodyCapability(200, v), { ...body, teamBody: "true" });
    refuses((v) => parseTeamBodyCapability(200, v), { ...body, reads: {} });
    refuses((v) => parseTeamBodyCapability(500, v), body);
    refuses((v) => parseTeamBodyCapability(503, v), body);
  });
});

describe("team body session pages", () => {
  test("request: legal sample passes, limit is 1..200", () => {
    expect(parseTeamBodyPageRequest(pageRequest)).toEqual(pageRequest as ReturnType<typeof parseTeamBodyPageRequest>);
    expect(parseTeamBodyPageRequest({ ...pageRequest, cursor: "c:39", limit: 1 }).cursor).toBe("c:39");
    for (const limit of [TEAM_BODY_PAGE_LIMIT_MAX + 1, 1000, 0, -1, 1.5, "200", null]) refuses(parseTeamBodyPageRequest, { ...pageRequest, limit });
    refuses(parseTeamBodyPageRequest, without(pageRequest, "limit"));
    refuses(parseTeamBodyPageRequest, without(pageRequest, "cursor"));
    refuses(parseTeamBodyPageRequest, { ...pageRequest, cursor: "" });
    refuses(parseTeamBodyPageRequest, { ...pageRequest, cursor: "c".repeat(513) });
  });
  test("ticket carries requestId and expiresAt", () => {
    const ticket = { schemaVersion: 1, requestId: "req-1", expiresAt: 1_700_000_060_000 };
    expect(parseTeamBodyPageTicket(ticket)).toEqual(ticket as ReturnType<typeof parseTeamBodyPageTicket>);
    refuses(parseTeamBodyPageTicket, without(ticket, "expiresAt"));
    refuses(parseTeamBodyPageTicket, { ...ticket, expiresAt: 0 });
  });
  test("claim: waitMs is capped at 8 s; claimed requests keep limit and expiresAt", () => {
    const claim = { schemaVersion: 1, sourceInstanceId: "home-1", waitMs: TEAM_BODY_CLAIM_WAIT_MAX_MS };
    expect(parseTeamBodyPageClaim(claim)).toEqual(claim as ReturnType<typeof parseTeamBodyPageClaim>);
    expect(parseTeamBodyPageClaim({ ...claim, waitMs: 0 }).waitMs).toBe(0);
    refuses(parseTeamBodyPageClaim, { ...claim, waitMs: TEAM_BODY_CLAIM_WAIT_MAX_MS + 1 });
    refuses(parseTeamBodyPageClaim, without(claim, "waitMs"));
    const claimed = { schemaVersion: 1, requests: [pending] };
    expect(parseTeamBodyPageClaimed(claimed)).toEqual(claimed as ReturnType<typeof parseTeamBodyPageClaimed>);
    expect(parseTeamBodyPageClaimed({ schemaVersion: 1, requests: [] }).requests).toEqual([]);
    refuses(parseTeamBodyPageClaimed, { schemaVersion: 1, requests: [pending, pending] });
    refuses(parseTeamBodyPageClaimed, { schemaVersion: 1, requests: [{ ...pending, limit: 201 }] });
    refuses(parseTeamBodyPageClaimed, { schemaVersion: 1, requests: [without(pending, "expiresAt")] });
  });
  test("return: a page of session-page records or a refusal", () => {
    expect(parseTeamBodyPageReturn(pageReturn)).toEqual(pageReturn as ReturnType<typeof parseTeamBodyPageReturn>);
    const refused = { ...pageReturn, result: { kind: "refused", code: "gate_refused" } };
    expect(parseTeamBodyPageReturn(refused)).toEqual(refused as ReturnType<typeof parseTeamBodyPageReturn>);
    expect(parseTeamBodyPageReturn({ ...pageReturn, result: { ...page, records: [], nextCursor: null } }).result).toEqual({ kind: "page", records: [], nextCursor: null });
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: { kind: "refused", code: "home_offline" } });
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: { ...page, records: [records[0]] } });
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: { ...page, records: [pages[0], pages[0]] } });
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: { ...page, kind: "other" } });
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: without(page, "nextCursor") });
    const over = Array.from({ length: TEAM_BODY_PAGE_LIMIT_MAX + 1 }, (_, i) => rec("session-page", `page:${i}`, "x"));
    expect(parseTeamBodyPageReturn({ ...pageReturn, result: { ...page, records: over.slice(1) } })).toBeDefined();
    refuses(parseTeamBodyPageReturn, { ...pageReturn, result: { ...page, records: over } });
  });
  test("read: pending has no result, ready has one", () => {
    expect(parseTeamBodyPageRead(pageRead)).toEqual(pageRead as ReturnType<typeof parseTeamBodyPageRead>);
    const waiting = { ...pageRead, status: "pending", result: null, homeOnline: false };
    expect(parseTeamBodyPageRead(waiting)).toEqual(waiting as ReturnType<typeof parseTeamBodyPageRead>);
    refuses(parseTeamBodyPageRead, { ...pageRead, status: "pending" });
    refuses(parseTeamBodyPageRead, { ...pageRead, result: null });
    refuses(parseTeamBodyPageRead, { ...pageRead, status: "expired", result: null });
    for (const key of Object.keys(pageRead)) refuses(parseTeamBodyPageRead, without(pageRead, key));
  });
});

describe("team body errors", () => {
  test("every code parses under its own status and no other", () => {
    for (const code of TEAM_BODY_ERROR_CODES) {
      const body = { schemaVersion: 1 as const, code, status: TEAM_BODY_STATUS[code], message: "说明" };
      expect(parseTeamBodyError(TEAM_BODY_STATUS[code], body)).toEqual(body);
      refuses((v) => parseTeamBodyError(500, v), body);
      refuses((v) => parseTeamBodyError(TEAM_BODY_STATUS[code], v), { ...body, status: 500 });
    }
  });
  test("unknown codes and foreign bodies are refused", () => {
    refuses((v) => parseTeamBodyError(403, v), { schemaVersion: 1, code: "forbidden", status: 403, message: "" });
    refuses((v) => parseTeamBodyError(503, v), "<html>bad gateway</html>");
    refuses((v) => parseTeamBodyError(410, v), { schemaVersion: 1, code: "expired", status: 410 });
  });
});
