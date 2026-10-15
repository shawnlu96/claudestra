/** 只派生本卡的放大数据，不改项目地图公共夹具。 */
import { projectMapBoard, PROJECT_MAP_NOW } from './helpers/project-map-fixture';
import { productGraph } from '../web/features/collab/product/product-graph';

export function enlargedProjectMap() {
  const board = projectMapBoard(PROJECT_MAP_NOW);
  const solo = productGraph(board).solo.map(n => n.feature);
  const extra = Array.from({ length: 30 - solo.length }, (_, i) => ({ ...solo[i % solo.length]!, id: `solo-extra-${i}`, title: `独立推进 ${i + 1}` }));
  return { ...board, features: [...board.features, ...extra] };
}
