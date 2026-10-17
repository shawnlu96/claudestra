import { expect, test } from "bun:test";
import { cardModelError, cardModelT } from "../web/features/chat/components/settings/card-model-copy";

test("Codex 错误不会匹配 code，错误定位与原因在中英文下都保留", () => {
  const raw = "合并后的表不合法：tiers.docs.adversarial-reviewer.codex 要是 null、inherit、down1 或 high";
  const zh = cardModelError(raw, (s) => cardModelT("zh", s));
  expect(zh).toContain("文档"); expect(zh).toContain("对抗审查"); expect(zh).toContain("Codex");
  expect(zh).not.toContain("代码x"); expect(zh).not.toContain("adversarial-reviewer");
  const en = cardModelError(raw, (s) => cardModelT("en", s));
  expect(en).toContain("Docs"); expect(en).toContain("Adversarial reviewer"); expect(en).toContain("Codex");
  expect(en).toContain("Invalid value"); expect(en).not.toMatch(/\p{Script=Han}/u);
  const roleOnly = cardModelError("codex 只认 null（照 Codex 配置）或 high", (s) => cardModelT("zh", s));
  expect(roleOnly).toContain("Codex"); expect(roleOnly).not.toContain("代码");
  expect(cardModelError("tier 只认 security / code / ui / docs", (s) => cardModelT("en", s))).not.toContain("Security ·");
});

test("安全错误保留执行方，角色名按完整 token 匹配", () => {
  const t = (s: string) => cardModelT("en", s);
  expect(cardModelError("security 的 pm-reviewer Codex 只能沿用原档", t)).toBe("Security · PM reviewer · Codex: Security floor not met");
  expect(cardModelError("合并后的表不合法：tiers.code.reviewer.claude 要是完整的 Claude 模型 id 或 inherit", t))
    .toContain("Code · Reviewer · Claude");
});
