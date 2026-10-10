/**
 * i28-SECPOOL2 PM 补：开关写者（security-pool / private-pool 共用的 setProjectMode）清临时文件不再吞掉所有错误。
 * ENOENT = 临时文件没建成，不警告；别的错误（EACCES / EIO …）打一条带路径的警告、不抛。删除函数注入，不在真实文件系统造 EACCES。
 */
import { expect, spyOn, test } from "bun:test";
import { dropTmp } from "../src/lib/security-pool.js";

const fail = (code: string) => () => { throw Object.assign(new Error(`${code}: boom`), { code }); };

test("非 ENOENT：带路径警告一条，不抛；ENOENT 与删成功都不警告", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => dropTmp("security-pool", "/x/a.tmp", fail("EACCES"))).not.toThrow();
    expect(() => dropTmp("private-pool", "/x/b.tmp", fail("EIO"))).not.toThrow();
    dropTmp("security-pool", "/x/c.tmp", fail("ENOENT"));
    dropTmp("security-pool", "/x/d.tmp", () => {});
    const warns = err.mock.calls.map((c) => String(c[0]));
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("/x/a.tmp");
    expect(warns[0]).toContain("security-pool");
    expect(warns[1]).toContain("/x/b.tmp");
  } finally { err.mockRestore(); }
});
