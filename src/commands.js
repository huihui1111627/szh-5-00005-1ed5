/**
 * 调度指令台账：提交 -> 审批 -> 下发 -> 现场反馈确认。
 * 支持：动作前风险预检、审批超时失效、执行超时失效、撤销未执行指令、反馈不一致回滚。
 */

import { emit, applyRepairRef } from "./engine.js";

const APPROVAL_TTL = 10; // 待审批有效期（tick）
const EXEC_TTL = 8; // 审批通过后的执行有效期（tick）
const FIELD_ACK = 2; // 在线情况下现场反馈到达延迟（tick）

let seq = 0;
const cmdId = () => `CMD-${String(++seq).padStart(4, '0')}`;

const TYPE_TITLE = {
  VALVE: '阀门操作',
  LOAD: '压缩机负荷调整',
  REPAIR: '泄漏封堵作业',
};

/* ----------------------------- 风险预检 ----------------------------- */

function hypotheticalEdges(eng, mutate) {
  // 返回一组临时开闭状态的管段副本（不写回真实状态）
  const open = new Map();
  for (const edge of eng.edges.values()) {
    open.set(edge.id, edge.valves.map((val) => ({ id: val.id, open: val.open })));
  }
  mutate(open);
  return open;
}

function reachableFromSources(eng, valveStates) {
  const adj = new Map();
  for (const id of eng.sites.keys()) adj.set(id, []);
  for (const edge of eng.edges.values()) {
    const states = valveStates.get(edge.id);
    const isOpen = states.every((s) => s.open);
    if (isOpen) {
      const [a, b] = edge.ends;
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
  }
  const seen = new Set();
  const queue = [];
  for (const s of eng.sites.values()) if (s.kind === 'source') { seen.add(s.id); queue.push(s.id); }
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of adj.get(cur)) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }
  return { seen, adj };
}

export function preflight(eng, type, ref, payload = {}) {
  const risks = [];
  if (type === 'VALVE') {
    const valve = eng.valves.get(ref);
    if (!valve) throw new Error('未知阀门');
    const wantOpen = payload.open ?? false;
    const edge = eng.edges.get(valve.edge);
    if (wantOpen === valve.open) {
      risks.push({ level: 'info', text: `阀门当前已处于${wantOpen ? '开启' : '关闭'}状态，指令不会改变工况` });
    }
    if (!wantOpen) {
      const states = hypotheticalEdges(eng, (map) => {
        for (const s of map.get(edge.id)) if (s.id === ref) s.open = false;
      });
      const { seen } = reachableFromSources(eng, states);
      const cut = [...eng.sites.values()].filter((s) => s.kind === 'demand' && !seen.has(s.id));
      for (const d of cut) {
        if (d.connected) risks.push({ level: 'critical', text: `将切断 ${d.name} 的全部供气路径，${d.region ? '区域保供可能失效' : '下游将停输'}` });
      }
      // 憋压检查：仍带负荷的压气站，关闭后是否没有任何一条开启的出站通道连向需求
      for (const c of eng.sites.values()) {
        if (c.kind !== 'compressor' || (c.load ?? 0) <= 0.01) continue;
        if (!seen.has(c.id)) continue;
        // 从该压气站出发，沿“关阀后仍开启”的管段做一次 BFS
        const localSeen = new Set([c.id]);
        const q = [c.id];
        while (q.length) {
          const cur = q.shift();
          for (const e of eng.edges.values()) {
            if (!e.ends.includes(cur)) continue;
            const isOpen = e.valves.every((v) => (v.id === ref ? false : v.open));
            if (!isOpen) continue;
            const other = e.ends.find((x) => x !== cur);
            if (!localSeen.has(other)) { localSeen.add(other); q.push(other); }
          }
        }
        const feedsDemand = [...eng.sites.values()].some((d) => d.kind === 'demand' && localSeen.has(d.id));
        if (!feedsDemand) risks.push({ level: 'critical', text: `${c.name} 仍带负荷而出站通道将被截断，可能憋压并形成新的超压点（应先降负荷）` });
      }
    } else {
      // 开阀：两端压差冲击
      const [a, b] = edge.ends;
      const dp = Math.abs(eng.sites.get(a).pressure - eng.sites.get(b).pressure);
      if (dp > 1.2) risks.push({ level: 'warning', text: `阀门两端压差 ${dp.toFixed(2)} MPa，贸然开启可能造成压力冲击并产生新的超压点` });
      else if (dp > 0.6) risks.push({ level: 'info', text: `阀门两端存在 ${dp.toFixed(2)} MPa 压差，开启后压力将重新分配` });
    }
  } else if (type === 'LOAD') {
    const site = eng.sites.get(ref);
    if (!site || site.kind !== 'compressor') throw new Error('未知压气站');
    const want = payload.load;
    if (want == null || want < 0 || want > 1) throw new Error('负荷须在 0~1 之间');
    if (want > (site.load ?? 0)) {
      const hasHighDown = [...eng.sites.values()].some((s) => s.pressure > P_HIGH_LOCAL(s));
      if (hasHighDown) risks.push({ level: 'warning', text: '管网已有高压点，提升负荷可能扩大超压异常' });
    }
    if (want < (site.load ?? 0)) risks.push({ level: 'info', text: '降低负荷会减小下游输送能力，需关注低压区域保供' });
  } else if (type === 'REPAIR') {
    const leak = eng.leaks.get(ref);
    if (!leak) throw new Error('未知泄漏点');
    if (leak.repaired) risks.push({ level: 'info', text: '该泄漏点已完成封堵' });
  }
  return risks;
}

function P_HIGH_LOCAL() {
  return 8.8;
}

/* ----------------------------- 指令生命周期 ----------------------------- */

export function submitCommand(eng, { type, ref, payload = {}, role = 'operator', note = '' }) {
  if (!['VALVE', 'LOAD', 'REPAIR'].includes(type)) throw new Error('未知指令类型');
  if (role !== 'operator' && role !== 'supervisor') throw new Error('未知角色');
  const risks = preflight(eng, type, ref, payload);
  const title = describe(eng, type, ref, payload);
  const cmd = {
    id: cmdId(),
    type, ref, payload: { ...payload },
    status: 'pending',
    createdTick: eng.tick,
    approveDueTick: eng.tick + APPROVAL_TTL,
    execDueTick: null,
    submittedBy: role,
    approvedBy: null,
    title, note,
    risks,
    dispatchTick: null,
    feedback: null,
    rollback: null,
  };
  eng.commands.push(cmd);
  emit(eng, 'CMD_SUBMIT', `指令待审批：${title}`,
    risks.length ? `预检提示 ${risks.length} 项风险` : '预检未发现阻断性风险', cmd.id);
  return cmd;
}

export function describe(eng, type, ref, payload) {
  if (type === 'VALVE') {
    const valve = eng.valves.get(ref);
    return `${payload.open ? '开启' : '关闭'} ${valve?.name ?? ref}`;
  }
  if (type === 'LOAD') {
    const site = eng.sites.get(ref);
    return `${site?.name ?? ref} 负荷调至 ${(payload.load * 100).toFixed(0)}%`;
  }
  return `泄漏点 ${ref} 封堵作业`;
}

export function approveCommand(eng, id, role = 'supervisor') {
  const cmd = mustFind(eng, id);
  if (cmd.status !== 'pending') throw new Error('仅待审批指令可审批');
  if (role !== 'supervisor') throw new Error('仅调度主管可审批');
  cmd.status = 'approved';
  cmd.approvedBy = role;
  cmd.approvedTick = eng.tick;
  cmd.execDueTick = eng.tick + EXEC_TTL;
  emit(eng, 'CMD_APPROVE', `指令已批准：${cmd.title}`, `执行窗口 ${EXEC_TTL} min`, cmd.id);
  return cmd;
}

export function rejectCommand(eng, id, role = 'supervisor', reason = '') {
  const cmd = mustFind(eng, id);
  if (cmd.status !== 'pending') throw new Error('仅待审批指令可驳回');
  cmd.status = 'rejected';
  cmd.reason = reason;
  emit(eng, 'CMD_REJECT', `指令已驳回：${cmd.title}`, reason, cmd.id);
  return cmd;
}

/** 撤销：仅未实际下发的指令（待审批 / 已批准待执行）可撤销 */
export function cancelCommand(eng, id, reason = '') {
  const cmd = mustFind(eng, id);
  if (!['pending', 'approved'].includes(cmd.status)) {
    throw new Error('已下发或已终结的指令不可撤销');
  }
  cmd.status = 'cancelled';
  cmd.cancelReason = reason;
  cmd.cancelTick = eng.tick;
  emit(eng, 'CMD_CANCEL', `指令已撤销：${cmd.title}`, reason, cmd.id);
  return cmd;
}

function mustFind(eng, id) {
  const cmd = eng.commands.find((c) => c.id === id);
  if (!cmd) throw new Error('指令不存在');
  return cmd;
}

/* ------------------------- 每 tick 驱动台账 ------------------------- */

export function tickCommands(eng) {
  for (const cmd of eng.commands) {
    // 审批超时（与现场服务无关，调度中心侧计时）
    if (cmd.status === 'pending' && eng.tick > cmd.approveDueTick) {
      cmd.status = 'expired';
      cmd.expireReason = '审批超时失效';
      emit(eng, 'CMD_EXPIRE', `审批超时，指令失效：${cmd.title}`, '', cmd.id);
      continue;
    }
    // 已批准：现场在线立即下发（核对窗口内也补下发并等待人工核对）；离线则挂起
    if (cmd.status === 'approved' && eng.gatewayOnline) {
      if (!eng.reconciling && eng.tick > cmd.execDueTick) {
        cmd.status = 'expired';
        cmd.expireReason = '执行超时失效';
        emit(eng, 'CMD_EXPIRE', `执行窗口超时，指令失效：${cmd.title}`, '', cmd.id);
        continue;
      }
      dispatch(eng, cmd);
      if (eng.reconciling && !eng.pendingReconcile.includes(cmd.id)) eng.pendingReconcile.push(cmd.id);
      continue;
    }
    if (cmd.status === 'approved' && (!eng.gatewayOnline || eng.reconciling)) {
      cmd.execDueTick += 1; // 现场不可达期间执行有效期顺延
    }
    // 已下发：在线情况下等待现场反馈；中断恢复后转人工核对（不自动确认）
    if (cmd.status === 'dispatched' && eng.gatewayOnline && !eng.reconciling) {
      if (eng.tick - cmd.dispatchTick >= FIELD_ACK) {
        cmd.status = 'done';
        cmd.doneTick = eng.tick;
        emit(eng, 'CMD_DONE', `现场反馈已执行：${cmd.title}`, '', cmd.id);
      }
    }
  }
}

function dispatch(eng, cmd) {
  cmd.status = 'dispatched';
  cmd.dispatchTick = eng.tick;
  cmd.rollback = captureRollback(eng, cmd);
  applyEffect(eng, cmd);
  emit(eng, 'CMD_DISPATCH', `指令已下发现场：${cmd.title}`, '等待设备反馈', cmd.id);
}

function captureRollback(eng, cmd) {
  if (cmd.type === 'VALVE') {
    const valve = eng.valves.get(cmd.ref);
    return { kind: 'VALVE', ref: cmd.ref, open: valve.open };
  }
  if (cmd.type === 'LOAD') {
    return { kind: 'LOAD', ref: cmd.ref, load: eng.sites.get(cmd.ref).load };
  }
  return { kind: 'REPAIR', ref: cmd.ref };
}

export function applyEffect(eng, cmd) {
  if (cmd.type === 'VALVE') {
    const valve = eng.valves.get(cmd.ref);
    const edge = eng.edges.get(valve.edge);
    valve.open = !!cmd.payload.open;
    edge.valves.find((v) => v.id === valve.id).open = valve.open;
    if (!valve.open) edge.inbox = []; // 关阀后该管段在途压力波作废，避免旧波继续影响站点
  } else if (cmd.type === 'LOAD') {
    eng.sites.get(cmd.ref).load = cmd.payload.load;
  } else if (cmd.type === 'REPAIR') {
    const leak = eng.leaks.get(cmd.ref);
    applyRepairRef(eng, cmd.ref);
    if (leak) eng.edges.get(leak.edge).inbox = []; // 封堵后泄漏管段上的旧波作废
  }
}

/** 反馈不一致：回滚已施加的设备动作 */
export function rollbackEffect(eng, cmd) {
  const rb = cmd.rollback;
  if (!rb) return;
  if (rb.kind === 'VALVE') {
    const valve = eng.valves.get(rb.ref);
    valve.open = rb.open;
    eng.edges.get(valve.edge).valves.find((v) => v.id === rb.ref).open = rb.open;
  } else if (rb.kind === 'LOAD') {
    eng.sites.get(rb.ref).load = rb.load;
  }
}
