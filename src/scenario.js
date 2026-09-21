/**
 * 长输天然气管网示例场景。
 *
 * 主干线（约 300 km，东西向）：
 *   S1 首站(气源) -> G1 阀室 -> C1 压气站 -> G2 阀室 -> G3 阀室
 *                -> C2 压气站 -> G4 阀室 -> D1 门站(区域A)
 *                -> G5 阀室 -> D2 末段门站(区域B)
 *
 * 联络支线（C1 -> G3，经过 X1 联络阀室）：主干中段关断后可改由支线向 G3 以东供气。
 *
 * 站点压力量纲为 MPa，流量量纲为统一相对单位（万 m³/d）。
 */

export const P_SOURCE = 7.5; // 首站供气压力
export const MAOP = 9.2; // 最大允许运行压力，超过触发超压报警
export const P_HIGH = 8.8; // 高压预警线
export const P_MIN = 2.5; // 最低保障压力
export const WAVE_SPEED = 20; // 压力波传播速度 km/tick（1 tick = 1 min）

/**
 * @typedef {Object} SiteDef
 * @property {string} id
 * @property {string} name
 * @property {'source'|'gate'|'compressor'|'demand'} kind
 * @property {number} x 剖面横距 km（用于绘图与波传播时间）
 * @property {number} y 剖面纵距 km
 * @property {number} [demand] 需求负荷（demand 站点）
 * @property {string} [region] 所属供应区域
 * @property {number} [elevation] 海拔 m（剖面展示用）
 * @property {number} [maxBoost] 压缩机满负荷升压 MPa
 */

/** @type {SiteDef[]} */
export const SITES = [
  { id: 'S1', name: '首站（气源）', kind: 'source', x: 0, y: 0, elevation: 120, region: 'R0' },
  { id: 'G1', name: '1号阀室', kind: 'gate', x: 35, y: 0, elevation: 150 },
  { id: 'C1', name: '1号压气站', kind: 'compressor', x: 70, y: 0, elevation: 260, maxBoost: 2.2 },
  { id: 'X1', name: '联络阀室', kind: 'gate', x: 100, y: 34, elevation: 300 },
  { id: 'G2', name: '2号阀室', kind: 'gate', x: 105, y: 0, elevation: 320 },
  { id: 'G3', name: '3号阀室', kind: 'gate', x: 140, y: 0, elevation: 380 },
  { id: 'C2', name: '2号压气站', kind: 'compressor', x: 175, y: 0, elevation: 420, maxBoost: 2.2 },
  { id: 'G4', name: '4号阀室', kind: 'gate', x: 210, y: 0, elevation: 350 },
  { id: 'D1', name: '东部门站', kind: 'demand', x: 240, y: 0, elevation: 220, demand: 34, region: 'RA' },
  { id: 'G5', name: '5号阀室', kind: 'gate', x: 270, y: 0, elevation: 180 },
  { id: 'D2', name: '末段门站', kind: 'demand', x: 300, y: 0, elevation: 120, demand: 24, region: 'RB' },
];

/**
 * @typedef {Object} EdgeDef
 * @property {string} id
 * @property {[string, string]} ends
 * @property {number} length km
 * @property {number} k 单位流量压力损失系数 MPa/(万m³/d)
 * @property {Array<{id:string,name:string,open:boolean}>} valves 管段阀门
 * @property {string} [main] 干线标识（展示用）
 */

const v = (id, name, open = true) => ({ id, name, open });

/** @type {EdgeDef[]} */
export const EDGES = [
  { id: 'E_S1_G1', ends: ['S1', 'G1'], length: 35, k: 0.011, main: '主干', valves: [v('V1', '首站出口阀')] },
  { id: 'E_G1_C1', ends: ['G1', 'C1'], length: 35, k: 0.011, main: '主干', valves: [v('V2', '1号阀室东阀')] },
  { id: 'E_C1_G2', ends: ['C1', 'G2'], length: 35, k: 0.011, main: '主干', valves: [v('V3', 'C1出站阀')] },
  { id: 'E_G2_G3', ends: ['G2', 'G3'], length: 35, k: 0.011, main: '主干', valves: [v('V4', '2号阀室东阀')] },
  { id: 'E_C1_X1', ends: ['C1', 'X1'], length: 45, k: 0.013, main: '联络线', valves: [v('V6', '联络线起点阀')] },
  { id: 'E_X1_G3', ends: ['X1', 'G3'], length: 52, k: 0.013, main: '联络线', valves: [v('V7', '联络线终点阀', false)] },
  { id: 'E_G3_C2', ends: ['G3', 'C2'], length: 35, k: 0.011, main: '主干', valves: [v('V5', '3号阀室东阀')] },
  { id: 'E_C2_G4', ends: ['C2', 'G4'], length: 35, k: 0.011, main: '主干', valves: [v('V8', 'C2出站阀')] },
  { id: 'E_G4_D1', ends: ['G4', 'D1'], length: 30, k: 0.011, main: '主干', valves: [v('V9', '东部门站进站阀')] },
  { id: 'E_D1_G5', ends: ['D1', 'G5'], length: 30, k: 0.011, main: '主干', valves: [v('V10', '东部门站东阀')] },
  { id: 'E_G5_D2', ends: ['G5', 'D2'], length: 30, k: 0.011, main: '主干', valves: [v('V11', '末段门站进站阀')] },
];

/** @type {Record<string, {name:string, minFlow:number}>} */
export const REGIONS = {
  RA: { name: '东部区域', minFlow: 30 },
  RB: { name: '末段区域', minFlow: 22 },
};

/** 压气站初始负荷（0~1） */
export const INITIAL_LOAD = { C1: 0.85, C2: 0.85 };

/**
 * 剧本事件（不依赖人工操作，自动注入）：
 *  - leak：在某管段制造泄漏
 *  - service：现场采集/控制服务状态切换（online/offline）
 *  - restoreLeak：泄漏修复（现场完成封堵）
 */
export const SCRIPTED_EVENTS = [
  { tick: 3, type: 'leak', edge: 'E_G2_G3', offset: 0.5, rate: 42, detectedAt: 7 },
  { tick: 60, type: 'service', online: false, untilTick: 72 },
];
