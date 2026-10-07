/** scripts/scheduler-memory-probe.ts 读 footprint(1) 的输出：读错单位或行，探针的通过 / 不通过就是假的 */
import { expect, test } from "bun:test";
import { parseFootprint } from "../scripts/scheduler-memory-probe.ts";

const SAMPLE = `======================================================================
bun [53917]: 64-bit    Footprint: 3626 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
3554 MB        0 B        15 MB        120    WebKit malloc
  48 MB        0 B      5920 KB         10    IOAccelerator
6880 KB        0 B      3456 KB        545    JS VM Gigacage
`;

test("取总 footprint 与 WebKit malloc 的 Dirty 列", () => {
  expect(parseFootprint(SAMPLE)).toEqual({ physMb: 3626, webkitMb: 3554 });
});

test("KB / GB 换算成 MB", () => {
  const out = SAMPLE.replace("Footprint: 3626 MB", "Footprint: 2 GB").replace("3554 MB        0 B", "512 KB        0 B");
  expect(parseFootprint(out)).toEqual({ physMb: 2048, webkitMb: 0.5 });
});

test("缺行 → NaN（不当成 0，免得把读不到算成没涨）", () => {
  const r = parseFootprint("nothing here");
  expect(Number.isNaN(r.physMb) && Number.isNaN(r.webkitMb)).toBe(true);
});
