import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEngine, advance, regionStatus, startLeak, setGateway, resolveReconcile, autoSnapshot } from '../src/engine.js';
import { submitCommand, approveCommand, cancelCommand } from '../src/commands.js';
import { restoreSnapshot } from '../src/state.js';

test('预热后压力自西向东逐级合理', () => {
  const eng = makeEngine();
  const g3 = eng.sites.get('G3');
  const d2 = eng.sites.get('D2');
  assert.ok(g3.pressure > 3 && g3.pressure < 9, `G3=${g3.pressure}`);
  assert.ok(d2.pressure > 2.5, `D2=${d2.pressure}`);
});

test('泄漏导致局部压降并触发报警', () => {
  const eng = makeEngine();
  startLeak(eng, 'E_G2_G3', 42, 0.5, null, false);
  for (let i = 0; i < 15; i++) advance(eng, 1);
  const alarm = eng.alarms.find((a) => a.code === 'LEAK' && a.active);
  assert.ok(alarm, '泄漏报警应触发');
  const before = eng.sites.get('D1').pressure;
  // 继续发展，下游压力应低于无泄漏水平
  for (let i = 0; i < 10; i++) advance(eng, 1);
  assert.ok(eng.sites.get('D1').pressure < 4.5, `D1=${eng.sites.get('D1').pressure}`);
  assert.ok(before > 0);
});

test('隔离管段后可改由联络线供气', () => {
  const eng = makeEngine();
  // 关闭主干 G2-G3（V4），打开联络线终点阀 V7
  const c1 = submitCommand(eng, { type: 'VALVE', ref: 'V4', payload: { open: false }, role: 'operator' });
  const c2 = submitCommand(eng, { type: 'VALVE', ref: 'V7', payload: { open: true }, role: 'operator' });
  approveCommand(eng, c1.id);
  approveCommand(eng, c2.id);
  for (let i = 0; i < 40; i++) advance(eng, 1);
  const d1 = eng.sites.get('D1');
  assert.ok(d1.connected, 'D1 应通过联络线保持连通');
  const eX = eng.edges.get('E_X1_G3');
  assert.notEqual(eX.dirSign, 0);
});

test('压气站先关出站阀会憋出超压点；先降负荷不会', () => {
  const bad = makeEngine();
  const cmd = submitCommand(bad, { type: 'VALVE', ref: 'V8', payload: { open: false } });
  const risks = cmd.risks.some((r) => r.level === 'critical' && r.text.includes('憋压'));
  assert.ok(risks, '预检应提示憋压风险');
  approveCommand(bad, cmd.id);
  for (let i = 0; i < 25; i++) advance(bad, 1);
  assert.ok(bad.alarms.some((a) => a.active && a.code === 'OVERPRESSURE'), '应形成超压点');

  const good = makeEngine();
  const load = submitCommand(good, { type: 'LOAD', ref: 'C2', payload: { load: 0 } });
  const v8 = submitCommand(good, { type: 'VALVE', ref: 'V8', payload: { open: false } });
  approveCommand(good, load.id);
  approveCommand(good, v8.id);
  for (let i = 0; i < 25; i++) advance(good, 1);
  assert.ok(!good.alarms.some((a) => a.active && a.code === 'OVERPRESSURE'), '先降负荷不应超压');
});

test('审批超时与执行窗口：未审批自动失效', () => {
  const eng = makeEngine();
  const cmd = submitCommand(eng, { type: 'VALVE', ref: 'V9', payload: { open: false } });
  for (let i = 0; i < 12; i++) advance(eng, 1);
  assert.equal(cmd.status, 'expired');
  assert.equal(cmd.expireReason, '审批超时失效');
  assert.equal(eng.valves.get('V9').open, true);
});

test('未执行指令可撤销', () => {
  const eng = makeEngine();
  const cmd = submitCommand(eng, { type: 'VALVE', ref: 'V9', payload: { open: false } });
  approveCommand(eng, cmd.id);
  cancelCommand(eng, cmd.id);
  advance(eng, 3);
  assert.equal(cmd.status, 'cancelled');
  assert.equal(eng.valves.get('V9').open, true);
});

test('服务中断挂起指令，恢复后需核对反馈，不一致可回滚', () => {
  const eng = makeEngine();
  setGateway(eng, false, false);
  const cmd = submitCommand(eng, { type: 'VALVE', ref: 'V10', payload: { open: false } });
  approveCommand(eng, cmd.id);
  for (let i = 0; i < 20; i++) advance(eng, 1);
  assert.equal(cmd.status, 'approved', '离线期间指令挂起');
  assert.equal(eng.valves.get('V10').open, true, '离线不下发');
  setGateway(eng, true, false);
  assert.ok(eng.reconciling, '恢复后进入核对状态');
  // 核对期间指令下发
  advance(eng, 1);
  assert.equal(cmd.status, 'dispatched');
  resolveReconcile(eng, cmd.id, false, '现场阀位仍为开启');
  assert.equal(cmd.status, 'feedback_mismatch');
  assert.equal(eng.valves.get('V10').open, true, '不一致则保持现场原状（尚未施加）');
});

test('从稳定状态重演后，新时间线可重新决策', () => {
  const eng = makeEngine();
  const snap = autoSnapshot(eng, '测试稳定点');
  const cmd = submitCommand(eng, { type: 'VALVE', ref: 'V4', payload: { open: false } });
  approveCommand(eng, cmd.id);
  for (let i = 0; i < 10; i++) advance(eng, 1);
  assert.equal(eng.valves.get('V4').open, false);
  restoreSnapshot(eng, snap.id);
  assert.equal(eng.valves.get('V4').open, true, '重演恢复阀门');
  assert.equal(cmd.status, 'obsoleted_by_replay');
});

test('区域保供状态随连通性变化', () => {
  const eng = makeEngine();
  const before = regionStatus(eng).find((r) => r.region === 'RA');
  assert.equal(before.status, 'OK');
  const cmd = submitCommand(eng, { type: 'VALVE', ref: 'V1', payload: { open: false } });
  approveCommand(eng, cmd.id);
  for (let i = 0; i < 60; i++) advance(eng, 1);
  const after = regionStatus(eng).find((r) => r.region === 'RA');
  assert.equal(after.status, 'FAIL');
});
