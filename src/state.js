/**
 * 快照恢复与“从稳定状态重演”。
 *
 * 主引擎始终保存完整事件链；恢复快照时：
 *  - 站点压力/目标、阀门状态、压缩机负荷、泄漏点回到快照时刻；
 *  - 清理在途压力波，由水力模型重新收敛；
 *  - 指令台账裁剪到快照之前（其后的指令视为未发生，可重新决策）；
 *  - 事件链保留并追加 REPLAY 标记，保证审计连续；
 *  - 剧本事件游标回退，自动事件在新的时间线上再次发生。
 */

import { emit } from './engine.js';
import { SCRIPTED_EVENTS } from './scenario.js';

export function restoreSnapshot(eng, snapshotId, reason = '') {
  const snap = eng.snapshots.find((s) => s.id === snapshotId);
  if (!snap) throw new Error('快照不存在');

  emit(eng, 'REPLAY', `从稳定状态重演：${snap.label}`,
    `回退到 tick ${snap.tick}${reason ? `；${reason}` : ''}；其后未执行/已执行指令均可重新下达`);

  eng.tick = snap.tick;
  for (const ss of snap.sites) {
    const site = eng.sites.get(ss.id);
    site.pressure = ss.pressure;
    site.target = ss.target;
    site.prevTarget = ss.target;
    site.load = ss.load;
    site.connected = ss.connected;
  }
  for (const vv of snap.valves) {
    const valve = eng.valves.get(vv.id);
    valve.open = vv.open;
    eng.edges.get(valve.edge).valves.find((v) => v.id === vv.id).open = vv.open;
  }
  // 泄漏点集合回到快照时刻
  eng.leaks = new Map(snap.leaks.map((l) => [l.id, { ...l }]));

  for (const edge of eng.edges.values()) { edge.inbox = []; edge.flow = 0; edge.dirSign = 0; }

  // 指令台账裁剪：快照之后创建的指令全部作废留痕（按台账序号）
  const keep = snap.commandCount;
  eng.commands.forEach((cmd, idx) => {
    if (idx >= keep && !['cancelled', 'expired', 'rejected'].includes(cmd.status)) {
      cmd.status = 'obsoleted_by_replay';
    }
  });

  // 剧本事件游标回退到快照之后的第一个事件
  eng.scripted = SCRIPTED_EVENTS.map((e) => ({ ...e }));
  eng.scriptCursor = eng.scripted.findIndex((e) => e.tick > eng.tick);
  if (eng.scriptCursor < 0) eng.scriptCursor = eng.scripted.length;

  eng.alarms = eng.alarms.filter((a) => a.clearedTick !== null && a.clearedTick <= snap.tick);
  eng.reconciling = false;
  eng.pendingReconcile = [];
  eng.stableSince = eng.tick;
  eng.stableMarked = false;
  return snap;
}

/** 撤销单条已生效指令：以其下发前记录的 rollback 信息还原设备状态 */
export function undoDispatched(eng, commandId, reason = '') {
  const cmd = eng.commands.find((c) => c.id === commandId);
  if (!cmd) throw new Error('指令不存在');
  if (!['done', 'dispatched', 'feedback_mismatch'].includes(cmd.status)) {
    throw new Error('仅已下发/已执行的指令可撤销还原');
  }
  // 延迟导入避免循环依赖
  return import('./commands.js').then((m) => {
    m.rollbackEffect(eng, cmd);
    cmd.status = 'undone';
    cmd.undoReason = reason;
    cmd.undoTick = eng.tick;
    emit(eng, 'CMD_UNDO', `已撤销并还原：${cmd.title}`, reason, cmd.id);
    return cmd;
  });
}
