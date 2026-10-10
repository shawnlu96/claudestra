/**
 * LENDUI1: the format rules of one screenshot upload (POST /api/v1/lend/shot), shared by the side that receives (A,
 * bridge/local-api/lend-shot.ts) and the side that sends: body shape, limits, PNG rules, answer codes. Pure, no I/O.
 * view / size / phase are the screenshot manifest's own rules (order-deliver-ui.ts), so an accepted upload can always be listed.
 * Only PNG, never decoded or re-encoded: the bytes kept are stripImageMeta's output (text / EXIF chunks and anything after IEND gone).
 * tests/lend-ui-wire.test.ts.
 */
import { sniffImage, stripImageMeta } from "./image-meta-strip.js";
import { fields, guard, no, ORDER_ID, pattern, pick, SHA40, version, whole } from "./lend-wire-v2-schema.js";
import { SIZE, UI_EVIDENCE_LIMITS, VIEW, type UiPhase } from "./order-deliver-ui.js";

const MIB = 1024 * 1024;
/** body: the whole JSON request; png: the decoded image; slots: view + size + phase combinations one order may hold */
export const LEND_SHOT_LIMITS = { body: 1.5 * MIB, png: MIB, slots: UI_EVIDENCE_LIMITS.shots, width: 4096, height: 16384 } as const;
export const LEND_SHOT_STATUS = { unauthorized: 401, invalid: 400, too_large: 413, not_held: 409, conflict: 409, shots_off: 403, unavailable: 503 } as const;
export type LendShotCode = keyof typeof LEND_SHOT_STATUS;
export type LendShotRefusal = { ok: false; code: LendShotCode; error: string };
export interface LendShotSlot { view: string; size: string; phase: UiPhase }
/** A parsed upload: `png` is already the stripped bytes that get stored, width / height are its IHDR's. */
export interface LendShot extends LendShotSlot { v: 1; orderId: string; gen: number; head: string; png: Uint8Array; width: number; height: number }

export const shotRefusal = (code: LendShotCode, error: string): LendShotRefusal => ({ ok: false, code, error });
const PHASES: readonly UiPhase[] = ["before", "after"];
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_MAX = Math.ceil(LEND_SHOT_LIMITS.png / 3) * 4;
const IHDR_LEN = 13;
const PNG_MIN = 8 + 12 + IHDR_LEN;

/** PNG only, first chunk a 13-byte IHDR, bounded dimensions, a chunk walk that reaches IEND; data = the bytes to store. */
function checkShotPng(b: Uint8Array): { ok: true; data: Uint8Array; width: number; height: number } | LendShotRefusal {
  if (b.length > LEND_SHOT_LIMITS.png) return shotRefusal("too_large", `截图超过 ${LEND_SHOT_LIMITS.png} 字节`);
  if (sniffImage(b) !== "image/png") return shotRefusal("invalid", "只收 PNG（按文件头认）");
  if (b.length < PNG_MIN) return shotRefusal("invalid", "PNG 不完整");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(8) !== IHDR_LEN || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return shotRefusal("invalid", "PNG 的首块要是 13 字节的 IHDR");
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width < 1 || width > LEND_SHOT_LIMITS.width || height < 1 || height > LEND_SHOT_LIMITS.height) {
    return shotRefusal("invalid", `截图尺寸要在 1–${LEND_SHOT_LIMITS.width} × 1–${LEND_SHOT_LIMITS.height} 之内`);
  }
  const stripped = stripImageMeta(b);
  if (!stripped.ok || stripped.mime !== "image/png") return shotRefusal("invalid", "PNG 结构不完整（走不到 IEND）");
  return { ok: true, data: stripped.data, width, height };
}

/** Standard padded base64 whose decode re-encodes to the same text; anything else (url-safe, whitespace, missing padding) is refused. */
function decodePng(text: string): Uint8Array | LendShotRefusal {
  if (text.length > B64_MAX) return shotRefusal("too_large", `截图超过 ${LEND_SHOT_LIMITS.png} 字节`);
  if (!text || !B64.test(text)) return shotRefusal("invalid", "png: 要是带填充的标准 base64");
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : shotRefusal("invalid", "png: base64 不规范（解码后再编码与原文不同）");
}

/** Strict: exactly {v, orderId, gen, head, view, size, phase, png}; no path, no digest and no name is taken from the sender. */
export function parseLendShot(raw: unknown): { ok: true; value: LendShot } | LendShotRefusal {
  const shape = guard(() => {
    const r = fields(raw, "$", ["v", "orderId", "gen", "head", "view", "size", "phase", "png"]);
    return { v: version(r), orderId: pattern(r.orderId, "orderId", ORDER_ID), gen: whole(r.gen, "gen", 1, 1e9), head: pattern(r.head, "head", SHA40),
      view: pattern(r.view, "view", VIEW), size: pattern(r.size, "size", SIZE), phase: pick(r.phase, "phase", PHASES),
      png: typeof r.png === "string" ? r.png : no("png", "要是字符串") };
  });
  if (!shape.ok) return shotRefusal("invalid", shape.error);
  const bytes = decodePng(shape.value.png);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const png = checkShotPng(bytes);
  if (!png.ok) return png;
  return { ok: true, value: { ...shape.value, png: png.data, width: png.width, height: png.height } };
}

/** The request text of one upload (what the sending side posts). */
export const lendShotBody = (s: LendShotSlot & { orderId: string; gen: number; head: string }, png: Uint8Array): string =>
  JSON.stringify({ v: 1, orderId: s.orderId, gen: s.gen, head: s.head, view: s.view, size: s.size, phase: s.phase, png: Buffer.from(png).toString("base64") });
