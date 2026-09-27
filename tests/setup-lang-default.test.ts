/** setup 选语言的默认值：lib/i18n.ts langFromLocaleEnv */
import { describe, expect, test } from "bun:test";
import { langFromLocaleEnv } from "../src/lib/i18n.js";

describe("langFromLocaleEnv", () => {
  test("zh 开头的 locale → 中文，大小写与地区都不挑", () => {
    expect(langFromLocaleEnv({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(langFromLocaleEnv({ LANG: "zh_TW.UTF-8" })).toBe("zh");
    expect(langFromLocaleEnv({ LANG: "ZH-Hans" })).toBe("zh");
  });
  test("其余一律英文：en_US、C、POSIX、没设、空串", () => {
    expect(langFromLocaleEnv({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(langFromLocaleEnv({ LANG: "C" })).toBe("en");
    expect(langFromLocaleEnv({ LC_ALL: "POSIX" })).toBe("en");
    expect(langFromLocaleEnv({})).toBe("en");
    expect(langFromLocaleEnv({ LANG: "  " })).toBe("en");
  });
  test("POSIX 优先级 LC_ALL > LC_MESSAGES > LANG；空值跳过", () => {
    expect(langFromLocaleEnv({ LC_ALL: "en_US.UTF-8", LC_MESSAGES: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(langFromLocaleEnv({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(langFromLocaleEnv({ LC_ALL: "", LC_MESSAGES: "", LANG: "zh_CN.UTF-8" })).toBe("zh");
  });
  test("CLAUDESTRA_LANG（install.sh 的显式开关）压过 locale；认不出的值当没设", () => {
    expect(langFromLocaleEnv({ CLAUDESTRA_LANG: "zh", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(langFromLocaleEnv({ CLAUDESTRA_LANG: "cn", LC_ALL: "en_US.UTF-8" })).toBe("zh");
    expect(langFromLocaleEnv({ CLAUDESTRA_LANG: "en_US", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(langFromLocaleEnv({ CLAUDESTRA_LANG: "fr", LANG: "zh_CN.UTF-8" })).toBe("zh");
  });
});
