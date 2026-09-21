/**
 * 管网压力异常处置仿真引擎。
 *
 * 模型约定（教学/推演级，非工业水力计算）：
 *  - 1 tick = 1 min；压力波沿管段以 WAVE_SPEED(km/tick) 逐站传播；
 *  - 每个 tick 先计算各站“目标压力”（由气源沿开阀管段 BFS 建树，
 *    沿树进行流量汇总、沿程压降与压气站升压），再以“在途压力波消息”
 *    方式把变化投递到各站，站点显示压力平滑跟踪，形成逐站传播过程；
 *  - 压气站出站阀全部关闭且仍在升压时出现憋压（超压点）；
 *  - 泄漏点作为虚拟节点加入图，持续抽走流量并在上/下游产生压降；
 *  - 关阀导致站点与所有气源断连时，该站及下游进入停输（压力衰减）。
 */

import {
  SITES, EDGES, REGIONS, P_SOURCE, MAOP, P_HIGH, P_MIN,
  WAVE_SPEED, INITIAL_LOAD, SCRIPTED_EVENTS,
} from './scenario.js';
import * as cmdModule from './commands.js';
import { tickCommands } from './commands.js';

const DECAY_PER_TICK = 0.04; // 断气站点压力衰减
const SMOOTH = 0.62; // 显示压力跟踪系数
const SURGE_RISE = 0.35; // 憋压点每 tick 上升
const DEADHEAD_LIMIT = MAOP + 1.6;
const FLOW_CAP = 120;
const MIN_FLOW_LOSS = 10; // 最小摩阻流量（停输段仍有稳态沿程压力梯度）
const LEAK_ALARM_RATE = 6;
const DIR_EPS = 0.02;

let nextId = 1;
const cid = (p) => `${p}-${String(nextId++).padStart(4, '0')}`;

export function makeEngine(now = Date.now(), { scripted = false } = {}) {
  const eng = {
    tick: 0,
    now,
    running: false,
    gatewayOnline: true,
    reconciling: false,
    pendingReconcile: [],
    sites: new Map(),
    edges: new Map(),
    valves: new Map(),
    leaks: new Map(),
    alarms: [],
    events: [],
    commands: [],
    snapshots: [],
    scripted: (scripted ? SCRIPTED_EVENTS : []).map((e) => ({ ...e })),
    scriptCursor: 0,
    stableSince: 0,
    stableMarked: false,
    lastWaveValue: new Map(),
  };

  for (const s of SITES) {
    eng.sites.set(s.id, {
      ...s,
      pressure: s.kind === 'source' ? P_SOURCE : P_SOURCE,
      target: P_SOURCE,
      prevTarget: P_SOURCE,
      flow: 0,
      connected: true,
      dirOut: {},
      load: s.kind === 'compressor' ? (INITIAL_LOAD[s.id] ?? 0) : null,
      online: true, // 现场设备反馈在线（可注入故障）
    });
  }

  for (const e of EDGES) {
    eng.edges.set(e.id, {
      id: e.id, ends: [...e.ends], length: e.length, k: e.k,
      valves: e.valves.map((val) => ({ ...val })),
      flow: 0, dirSign: 0, main: e.main ?? '',
      inbox: [],
    });
    for (const val of e.valves) eng.valves.set(val.id, { edge: e.id, ...val });
  }

  emit(eng, 'SCENARIO', '场景加载', `长输管网：${SITES.length} 座站场/阀室，${EDGES.length} 条管段`);

  // 预热至稳态
  for (let i = 0; i < 200; i++) hydraulicTick(eng, false);
  for (const site of eng.sites.values()) {
    site.pressure = site.target;
    site.prevTarget = site.target;
  }
  for (const edge of eng.edges.values()) edge.inbox = [];
  emit(eng, 'INFO', '预热完成', '管网已进入稳定运行状态');
  eng.stableSince = 0;
  return eng;
}

export function emit(eng, type, title, detail = '', ref = null) {
  const ev = { seq: eng.events.length + 1, tick: eng.tick, at: eng.now + eng.tick * 60000, type, title, detail, ref };
  eng.events.push(ev);
  return ev;
}

/* ----------------------------- 图构建 ----------------------------- */

function buildGraph(eng) {
  const nodes = [];
  const siteVirt = new Map();
  const virtSite = new Map();
  for (const s of eng.sites.keys()) { siteVirt.set(s, s); nodes.push(s); }
  let vn = 0;
  for (const [id, leak] of eng.leaks) {
    if (leak.repaired) continue;
    const edge = eng.edges.get(leak.edge);
    const [a, b] = edge.ends;
    const va = `L${++vn}a`, vb = `L${vn}b`;
    virtSite.set(va, a); virtSite.set(vb, a);
    nodes.push(va, vb);
    siteVirt.set(`${id}:a`, va); siteVirt.set(`${id}:b`, vb);
    leak._va = va; leak._vb = vb;
  }

  const adj = new Map(nodes.map((n) => [n, []]));
  const link = (a, b, edge, lag, flowCap = true) => {
    adj.get(a).push({ to: b, edge, lag, flowCap });
    adj.get(b).push({ to: a, edge, lag, flowCap });
  };
  for (const edge of eng.edges.values()) {
    const open = edge.valves.every((val) => val.open);
    if (!open) continue;
    const leak = [...eng.leaks.values()].find((l) => l.edge === edge.id && !l.repaired);
    const lag = Math.max(1, Math.round(edge.length / WAVE_SPEED));
    if (!leak) {
      link(...edge.ends, edge, lag);
    } else {
      const [a, b] = edge.ends;
      link(a, leak._va, edge, Math.max(1, Math.round(lag * leak.offset)), true);
      link(leak._vb, b, edge, Math.max(1, Math.round(lag * (1 - leak.offset))), true);
      adj.get(leak._va).push({ to: leak._vb, edge, lag: 0, flowCap: false });
      adj.get(leak._vb).push({ to: leak._va, edge, lag: 0, flowCap: false });
    }
  }
  return { nodes, adj, virtSite };
}

function isVirtual(eng, id) {
  return id[0] === 'L';
}
function realSite(eng, id) {
  return isVirtual(eng, id) ? null : eng.sites.get(id);
}

/* --------------------------- 水力核心计算 --------------------------- */

function hydraulicTick(eng, withWaves = true) {
  const { adj } = buildGraph(eng);

  // 1) BFS：从气源建树（距离为跳数；压力在第二步显式传播）
  const parent = new Map();
  const pEdge = new Map();
  const pEdgeInfo = new Map();
  const sources = [...eng.sites.values()].filter((s) => s.kind === 'source');
  const queue = [];
  for (const s of sources) { parent.set(s.id, null); queue.push(s.id); }
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of adj.get(cur) ?? []) {
      if (!parent.has(nb.to)) { parent.set(nb.to, cur); pEdge.set(nb.to, nb.edge); pEdgeInfo.set(nb.to, nb); queue.push(nb.to); }
    }
  }

  // 2) 层序遍历（自根向叶）
  const layers = [[...sources].map((s) => s.id)];
  const placed = new Set(layers[0]);
  while (true) {
    const layer = [];
    for (const cur of layers[layers.length - 1]) {
      for (const nb of adj.get(cur) ?? []) {
        if (parent.get(nb.to) === cur && !placed.has(nb.to)) { layer.push(nb.to); placed.add(nb.to); }
      }
    }
    if (!layer.length) break;
    layers.push(layer);
  }
  const fwd = layers.slice(1).flat();
  const all = [...parent.keys()];

  // 3) 子树需求汇总（自叶向根）
  const subDemand = new Map();
  for (const id of all) {
    const site = realSite(eng, id);
    subDemand.set(id, site?.kind === 'demand' ? site.demand : 0);
  }
  for (const leak of eng.leaks.values()) {
    if (!leak.repaired) subDemand.set(leak._va, (subDemand.get(leak._va) ?? 0) + leak.rate);
  }
  for (let li = layers.length - 1; li >= 1; li--) {
    for (const id of layers[li]) subDemand.set(parent.get(id), (subDemand.get(parent.get(id)) ?? 0) + (subDemand.get(id) ?? 0));
  }

  // 4) 目标压力（自根向叶）：入口压 - 沿程压降；压气站子节点获得升压
  const target = new Map();
  for (const s of sources) target.set(s.id, P_SOURCE);
  const edgeFlow = new Map();
  const childCount = new Map();
  for (const id of fwd) childCount.set(parent.get(id), (childCount.get(parent.get(id)) ?? 0) + 1);
  for (const id of fwd) {
    const p = parent.get(id);
    const linkInfo = pEdgeInfo.get(id);
    const edge = pEdge.get(id);
    const q = Math.min(FLOW_CAP, subDemand.get(id) ?? 0);
    if (linkInfo?.flowCap !== false) edgeFlow.set(edge.id, (edgeFlow.get(edge.id) ?? 0) + q);
    const pSite = realSite(eng, p);
    let pin = target.get(p);
    if (pSite?.kind === 'compressor') {
      const stopped = pSite.load <= 0.01;
      pin = target.get(p) + (stopped ? 0 : pSite.load * (pSite.maxBoost ?? 2.2));
    }
    target.set(id, pin - edge.k * Math.max(q, MIN_FLOW_LOSS));
  }

  // 5) 憋压：仍带负荷的压气站在供气树上没有任何下游子节点
  const deadheadAt = new Set();
  for (const site of eng.sites.values()) {
    if (site.kind === 'compressor' && site.load > 0.01 && parent.has(site.id)) {
      if ((childCount.get(site.id) ?? 0) === 0) deadheadAt.add(site.id);
    }
  }

  // 4) 写回各真实站点目标压力 / 断连衰减 / 憋压上升
  const reachable = new Set();
  for (const id of parent.keys()) if (!isVirtual(eng, id)) reachable.add(id);
  for (const site of eng.sites.values()) {
    site.prevTarget = site.target;
    if (site.kind === 'source') { site.target = P_SOURCE; continue; }
    if (reachable.has(site.id)) {
      site.target = target.get(site.id);
      site.connected = true;
    } else {
      site.target = Math.max(0, site.pressure - DECAY_PER_TICK);
      site.connected = false;
    }
    if (deadheadAt.has(site.id)) {
      site.target = Math.min(DEADHEAD_LIMIT, Math.max(site.target, site.pressure) + SURGE_RISE);
      site.pressure = site.target; // 憋压是站内过程，无需管段传播延迟
    }
    site.flow = subDemand.get(site.id) ?? 0;
  }
  for (const edge of eng.edges.values()) edge.flow = edgeFlow.get(edge.id) ?? 0;

  // 5) 压力波：目标变化沿管段延迟投递
  //    - 已到达(atTick<=当前)的波留给随后 applyWaves 消费，绝不在此删除；
  //    - 仅对尚未到达的在途波按目的站去重，保留最新一条。
  for (const edge of eng.edges.values()) {
    const arrived = edge.inbox.filter((m) => m.atTick <= eng.tick);
    const pending = new Map();
    for (const m of edge.inbox) {
      if (m.atTick <= eng.tick) continue;
      const prev = pending.get(m.dest);
      if (!prev || m.atTick > prev.atTick) pending.set(m.dest, m);
    }
    edge.inbox = [...arrived, ...pending.values()];
  }
  if (withWaves) {
    for (const id of fwd) {
      const edge = pEdge.get(id);
      const site = realSite(eng, id);
      if (!site || edge.id.startsWith('__')) continue;
      // 仅当目标压力与“上一次已发出的波”不同时才发新波；
      // 稳态下不再产生新波，避免把在途旧波不断推后而无法到达
      const waveKey = `${edge.id}:${id}`;
      const prevWave = eng.lastWaveValue.get(waveKey);
      if (prevWave !== undefined && Math.abs(target.get(id) - prevWave) < 0.005) continue;
      eng.lastWaveValue.set(waveKey, target.get(id));
      const lag = Math.max(1, Math.round(edge.length / WAVE_SPEED));
      edge.inbox.push({ atTick: eng.tick + lag, sentTick: eng.tick, value: target.get(id), dest: id });
    }
  }

  return { parent, pEdge, edgeFlow };
}

/* ----------------------------- 主步进 ----------------------------- */

export function advance(eng, steps = 1) {
  for (let n = 0; n < steps; n++) {
    eng.tick += 1;
    runScripted(eng);
    if (eng.gatewayOnline && !eng.reconciling) {
      hydraulicTick(eng, true);
      applyWaves(eng);
      evaluateAlarms(eng);
    }
    tickCommands(eng);
    checkStable(eng);
  }
}

function applyWaves(eng) {
  // 汇总所有已到达波；每个目的站只采用“发出时刻最新”的一条（旧波不再回拉）
  const arrived = new Map(); // siteId -> {msg, sentTick}
  for (const edge of eng.edges.values()) {
    const remain = [];
    for (const m of edge.inbox) {
      if (m.atTick <= eng.tick) {
        const prev = arrived.get(m.dest);
        if (!prev || m.sentTick > prev.sentTick) arrived.set(m.dest, { msg: m, sentTick: m.sentTick });
      } else remain.push(m);
    }
    edge.inbox = remain;
  }
  for (const site of eng.sites.values()) {
    if (site.kind === 'source') { site.pressure = P_SOURCE; continue; }
    const hit = arrived.get(site.id);
    if (hit) {
      const incoming = hit.msg;
      site.pressure += (incoming.value - site.pressure) * SMOOTH;
    } else if (site.connected) {
      // 没有新到达波（入站波已消费完）：继续向本地目标压力松弛，
      // 使站点在变化源停止发波后能完成最终收敛
      if (Math.abs(site.target - site.pressure) > 1e-4) {
        site.pressure += (site.target - site.pressure) * SMOOTH * 0.5;
      }
    } else {
      site.pressure = Math.max(0, site.pressure - DECAY_PER_TICK);
    }
  }
  // 供气方向（按相邻站点压力梯度）
  for (const edge of eng.edges.values()) {
    const [a, b] = edge.ends;
    const pa = eng.sites.get(a).pressure;
    const pb = eng.sites.get(b).pressure;
    const open = edge.valves.every((val) => val.open);
    edge.dirSign = !open ? 0 : pa - pb > DIR_EPS ? 1 : pb - pa > DIR_EPS ? -1 : 0;
  }
}

/* ----------------------------- 报警评估 ----------------------------- */

function raiseAlarm(eng, code, level, title, detail, ref) {
  const key = `${code}:${ref ?? ''}`;
  let alarm = eng.alarms.find((a) => a.key === key && a.active);
  if (alarm) return;
  alarm = {
    key, code, level, title, detail, ref,
    active: true, raisedTick: eng.tick, clearedTick: null,
  };
  eng.alarms.push(alarm);
  emit(eng, 'ALARM', title, detail, ref);
}

function clearAlarm(eng, code, ref) {
  const key = `${code}:${ref ?? ''}`;
  const alarm = eng.alarms.find((a) => a.key === key && a.active);
  if (alarm) {
    alarm.active = false;
    alarm.clearedTick = eng.tick;
    emit(eng, 'RESOLVE', `报警消除：${alarm.title}`, '', ref);
  }
}

function evaluateAlarms(eng) {
  for (const site of eng.sites.values()) {
    if (site.kind === 'source') continue;
    if (!site) continue;
    if (site.pressure > MAOP) {
      raiseAlarm(eng, 'OVERPRESSURE', 'critical', `${site.name} 超压`,
        `当前压力 ${site.pressure.toFixed(2)} MPa，超过 MAOP ${MAOP} MPa`, site.id);
    } else if (site.pressure > P_HIGH) {
      raiseAlarm(eng, 'HIGHPRESSURE', 'warning', `${site.name} 高压预警`,
        `当前压力 ${site.pressure.toFixed(2)} MPa，高于预警线 ${P_HIGH} MPa`, site.id);
    } else {
      clearAlarm(eng, 'OVERPRESSURE', site.id);
      clearAlarm(eng, 'HIGHPRESSURE', site.id);
    }
    if (site.connected && site.pressure < P_MIN) {
      raiseAlarm(eng, 'LOWPRESSURE', site.kind === 'demand' ? 'critical' : 'warning',
        `${site.name} 低压`, `当前压力 ${site.pressure.toFixed(2)} MPa，低于最低保障压力 ${P_MIN} MPa`, site.id);
    } else {
      clearAlarm(eng, 'LOWPRESSURE', site.id);
    }
    if (!site.connected) {
      raiseAlarm(eng, 'ISOLATED', 'critical', `${site.name} 已与气源断连`, '所有连通路径上的阀门均已关断', site.id);
    } else {
      clearAlarm(eng, 'ISOLATED', site.id);
    }
  }

  for (const leak of eng.leaks.values()) {
    if (leak.repaired) {
      clearAlarm(eng, 'LEAK', leak.id);
      clearAlarm(eng, 'SUSPECT_LEAK', leak.edge);
      continue;
    }
    if (eng.tick >= leak.detectedAt) {
      raiseAlarm(eng, 'LEAK', 'critical', `疑似泄漏：${edgeName(eng, leak.edge)}`,
        `泄漏估算 ${leak.rate} 万m³/d，位于管段 ${(leak.offset * 100).toFixed(0)}% 位置`, leak.id);
    } else if (leak.rate >= LEAK_ALARM_RATE && eng.tick >= leak.startTick + 2) {
      raiseAlarm(eng, 'SUSPECT_LEAK', 'warning', `流量平衡异常：${edgeName(eng, leak.edge)}`,
        '上下游流量偏差超过阈值，疑似存在未明泄漏', leak.edge);
    }
  }
}

function edgeName(eng, edgeId) {
  const e = eng.edges.get(edgeId);
  if (!e) return edgeId;
  return `${eng.sites.get(e.ends[0]).name}—${eng.sites.get(e.ends[1]).name}`;
}

/* ----------------------------- 剧本事件 ----------------------------- */

function runScripted(eng) {
  while (eng.scriptCursor < eng.scripted.length) {
    const ev = eng.scripted[eng.scriptCursor];
    if (ev.tick > eng.tick) break;
    eng.scriptCursor += 1;
    if (ev.type === 'leak') startLeak(eng, ev.edge, ev.rate, ev.offset, ev.detectedAt, true);
    else if (ev.type === 'service') setGateway(eng, ev.online, true);
    else if (ev.type === 'restoreLeak') repairLeakInternal(eng, ev.leakId);
  }
}

export function startLeak(eng, edgeId, rate, offset = 0.5, detectedAt = null, scripted = false) {
  const edge = eng.edges.get(edgeId);
  if (!edge) throw new Error(`未知管段 ${edgeId}`);
  const id = cid('LEAK');
  const leak = {
    id, edge: edgeId, rate, offset, startTick: eng.tick,
    detectedAt: detectedAt ?? eng.tick + 1, repaired: false,
  };
  eng.leaks.set(id, leak);
  emit(eng, 'LEAK_DETECT', scripted ? '监测到新增泄漏' : '人工标记泄漏点',
    `${edgeName(eng, edgeId)}，估算 ${rate} 万m³/d`, id);
  return leak;
}

export function setGateway(eng, online, scripted = false) {
  if (online === eng.gatewayOnline) return;

  if (online) eng._downAtTick = eng._downStart ?? 0;
  else eng._downStart = eng.tick;
  eng.gatewayOnline = online;
  if (!online) {
    emit(eng, 'SERVICE_DOWN', '现场采集/控制服务中断',
      scripted ? '通信链路异常，下发指令将挂起等待恢复' : '管理员手动切断了现场链路');
  } else {
    // 恢复瞬间把“已批准但因离线未能下发”的指令补下发（随后进入核对清单）
    for (const cmd of eng.commands) {
      if (cmd.status === 'approved') {
        cmd.status = 'dispatched';
        cmd.dispatchTick = eng.tick;
        cmd.rollback = { kind: cmd.type === 'VALVE' ? 'VALVE' : cmd.type === 'LOAD' ? 'LOAD' : 'REPAIR',
          ref: cmd.ref, open: cmd.type === 'VALVE' ? eng.valves.get(cmd.ref).open : undefined,
          load: cmd.type === 'LOAD' ? eng.sites.get(cmd.ref).load : undefined };
        cmdModule.applyEffect(eng, cmd);
        emit(eng, 'CMD_DISPATCH', `链路恢复，指令补下发：${cmd.title}`, '等待设备反馈核对', cmd.id);
      }
    }
    // 恢复后进入核对状态：暂停仿真，等待逐条核实现场设备反馈
    eng.reconciling = true;
    eng._downAtTick = 0; // 恢复后所有在途/补下发指令都需要核对
    eng.pendingReconcile = eng.commands
      .filter((c) => ['dispatched', 'approved'].includes(c.status))
      .map((c) => c.id);
    emit(eng, 'SERVICE_RECOVER', '现场服务恢复，等待设备反馈核对',
      `有 ${eng.pendingReconcile.length} 条已下发指令需要核对实际执行结果`);
  }
}

export function resolveReconcile(eng, commandId, matched, note = '') {
  const cmd = eng.commands.find((c) => c.id === commandId);
  if (!cmd || cmd.status !== 'dispatched') throw new Error('指令不在待核对状态');
  cmd.feedback = { matched, note, tick: eng.tick };
  if (matched) {
    cmd.status = 'done';
    cmd.doneTick = eng.tick;
    emit(eng, 'CMD_DONE', `指令已确认执行：${cmd.title}`, note || '现场反馈与指令一致', cmd.id);
  } else {
    cmdModule.rollbackEffect(eng, cmd);
    cmd.status = 'feedback_mismatch';
    emit(eng, 'CMD_MISMATCH', `现场反馈不一致：${cmd.title}`, (note || '设备实际位置与指令不符') + '；已按现场实况回滚指令动作', cmd.id);
  }
  // 核对清单动态计算：恢复时已在下发途中的，以及恢复后补下发的，都要逐条确认
  eng.pendingReconcile = eng.commands
    .filter((c) => c.status === 'dispatched' && c.dispatchTick >= eng._downAtTick)
    .map((c) => c.id);
  if (eng.pendingReconcile.length === 0) {
    eng.reconciling = false;
    emit(eng, 'RECONCILE_DONE', '设备反馈核对完成', '恢复推演');
  }
  return cmd;
}

export function applyRepairRef(eng, leakId) {
  repairLeakInternal(eng, leakId);
}

function repairLeakInternal(eng, leakId) {
  const leak = eng.leaks.get(leakId);
  if (leak && !leak.repaired) {
    leak.repaired = true;
    leak.repairedTick = eng.tick;
    emit(eng, 'LEAK_REPAIR', '泄漏点完成封堵', edgeName(eng, leak.edge), leakId);
  }
}

/* ----------------------------- 稳态判定 ----------------------------- */

function checkStable(eng) {
  if (!eng.gatewayOnline || eng.reconciling) return;
  const activeCritical = eng.alarms.some((a) => a.active && a.level === 'critical');
  const pending = eng.commands.some((c) => ['pending', 'approved', 'dispatched'].includes(c.status));
  let settled = true;
  for (const s of eng.sites.values()) {
    if (Math.abs(s.pressure - s.target) > 0.04) { settled = false; break; }
  }
  const stable = !activeCritical && !pending && settled && eng.leaks.size === 0 ||
    !activeCritical && !pending && settled && [...eng.leaks.values()].every((l) => l.repaired);
  if (!stable) {
    eng.stableSince = eng.tick;
    eng.stableMarked = false;
  } else if (!eng.stableMarked && eng.tick - eng.stableSince >= 4) {
    eng.stableMarked = true;
    // 自动记录“最近稳定状态”（仅保留每轮不稳定之前最近的一个）
    autoSnapshot(eng, `稳定状态（tick ${eng.tick}）`, true);
  }
}

export function autoSnapshot(eng, label, auto = false) {
  const snap = takeSnapshot(eng, label);
  snap.auto = auto;
  eng.snapshots.push(snap);
  if (auto) {
    // 自动快照只保留最近 3 个
    const autos = eng.snapshots.filter((s) => s.auto);
    if (autos.length > 3) {
      const rm = autos[0];
      eng.snapshots = eng.snapshots.filter((s) => s !== rm);
    }
  }
  emit(eng, 'SNAPSHOT', auto ? '已记录稳定状态快照' : '手动保存快照', label, snap.id);
  return snap;
}

/* ----------------------------- 区域保供 ----------------------------- */

export function regionStatus(eng) {
  const out = [];
  for (const [rid, def] of Object.entries(REGIONS)) {
    const demands = [...eng.sites.values()].filter((s) => s.region === rid);
    let delivered = 0;
    let minPressure = Infinity;
    let connected = true;
    for (const s of demands) {
      if (!s.connected) connected = false;
      minPressure = Math.min(minPressure, s.pressure);
      // 简化：连通且压力达标即认为需求可兑现；压力不足按比例折减
      if (s.connected) {
        delivered += s.demand * Math.max(0, Math.min(1, (s.pressure - 1.0) / (P_MIN - 1.0)));
      }
    }
    const status = !connected || delivered < def.minFlow * 0.98 ? 'FAIL'
      : minPressure < P_MIN ? 'WEAK' : 'OK';
    out.push({
      region: rid, name: def.name, minFlow: def.minFlow,
      delivered: Math.round(delivered * 10) / 10,
      minPressure: minPressure === Infinity ? null : Math.round(minPressure * 100) / 100,
      connected, status,
    });
  }
  return out;
}

export function takeSnapshot(eng, label) {
  return {
    id: cid('SNAP'),
    label,
    tick: eng.tick,
    at: eng.now + eng.tick * 60000,
    sites: [...eng.sites.values()].map((s) => ({
      id: s.id, pressure: s.pressure, target: s.target, load: s.load, connected: s.connected,
    })),
    valves: [...eng.valves.values()].map((val) => ({ id: val.id, open: val.open })),
    leaks: [...eng.leaks.values()].map((l) => ({ ...l })),
    commandCount: eng.commands.length,
    eventSeq: eng.events.length,
  };
}
