/** 项目地图卡片的尺寸（纯数据，布局和画布共用）。卡高按卡算：PDCARD1 会按内容改 cardHeight，布局按它逐张摆 */
import type { ProductFeature } from '../../../lib/api/product-board-types';

/** 卡宽、完成小标签的宽高（同原型 C-project-dag.html:416） */
export const CARD_W = 272, CHIP_W = 176, CHIP_H = 34;

export function cardHeight(f: ProductFeature): number {
  void f;
  return 142;
}
