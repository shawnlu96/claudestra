/**
 * 出站附件文件名清洗单测(peer 2026-08-25 中文名 bug)。
 * 关键:保 Unicode——中文名不被抹平、彼此可区分(旧实现全变 _-_.png 互撞)。
 */
import { describe, test, expect } from "bun:test";
import { sanitizeAttachmentBase } from "../src/lib/attachment-name.js";

describe("sanitizeAttachmentBase", () => {
  test("中文名保留、彼此可区分(旧实现的核心 bug)", () => {
    expect(sanitizeAttachmentBase("朱耷-新.png")).toBe("朱耷-新.png");
    expect(sanitizeAttachmentBase("八大山人-新.png")).toBe("八大山人-新.png");
    expect(sanitizeAttachmentBase("朱耷-新.png")).not.toBe(sanitizeAttachmentBase("八大山人-新.png"));
  });
  test("取 basename(去路径)", () => {
    expect(sanitizeAttachmentBase("/tmp/scratch/图 1.png")).toBe("图_1.png");
    expect(sanitizeAttachmentBase("/a/b/c.jpg")).toBe("c.jpg");
  });
  test("空格 / 危险字符 → _,点/连字符/下划线保留", () => {
    expect(sanitizeAttachmentBase("my photo (1).png")).toBe("my_photo_1_.png");
    expect(sanitizeAttachmentBase("c*d?.png")).toBe("c_d_.png");
    expect(sanitizeAttachmentBase("keep-._name.png")).toBe("keep-._name.png");
  });
  test("超 80 字符截断", () => {
    expect(sanitizeAttachmentBase("字".repeat(100) + ".png").length).toBe(80);
  });
  test("空 → file 兜底", () => {
    expect(sanitizeAttachmentBase("/tmp/")).toBe("file");
    expect(sanitizeAttachmentBase("")).toBe("file");
  });
});
