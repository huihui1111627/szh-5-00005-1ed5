/* 前端逻辑：轮询状态、SVG 管线剖面、指令工作流、核对与重演。 */
const $ = (sel) => document.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';
let STATE = null;
let pollTimer = null;

async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opt);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (data.state) { STATE = data.state; render(); return data; }
  if (data.sites) { STATE = data; render(); return data; }
  return data;
}

function role() { return $('#role-select').value; }
function pColor(p) {
  if (p > 9.2) return '#f43f5e';
  if (p > 8.8) return '#f59e0b';
  if (p < 2.5) return '#f43f5e';
  if (p < 3.5) return '#f59e0b';
  return '#4ea1ff';
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ----------------------------- 剖面图 ----------------------------- */

function renderProfile() {
  const box = $('#profile');
  const W = 980, H = 340, PAD_L = 40, PAD_R = 40, TOP = 40;
  const xs = STATE.sites.map((s) => s.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const pos = new Map();
  for (const s of STATE.sites) {
    const x = PAD_L + ((s.x - xmin) / (xmax - xmin)) * (W - PAD_L - PAD_R);
    const y = TOP + 190 + s.y * 1.25 - s.elevation * 0.12;
    pos.set(s.id, { x, y });
  }
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // 地形剖面线
  const terrain = document.createElementNS(SVGNS, 'path');
  terrain.setAttribute('class', 'elev');
  terrain.setAttribute('d', STATE.sites.filter((s) => s.y === 0)
    .map((s, i) => `${i ? 'L' : 'M'} ${pos.get(s.id).x} ${pos.get(s.id).y + 26}`).join(' '));
  el.appendChild(terrain);

  // 管段
  for (const edge of STATE.edges) {
    const [a, b] = edge.ends;
    const pa = pos.get(a), pb = pos.get(b);
    const allOpen = edge.valves.every((v) => v.open);
    const base = document.createElementNS(SVGNS, 'path');
    base.setAttribute('class', `pipe ${edge.main === '联络线' ? 'loop' : ''}`);
    base.setAttribute('d', `M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`);
    if (!allOpen) base.setAttribute('stroke-dasharray', '2 6');
    base.setAttribute('stroke', allOpen ? undefined : '#4b2030');
    el.appendChild(base);
    if (allOpen && edge.dirSign !== 0) {
      const flow = document.createElementNS(SVGNS, 'path');
      flow.setAttribute('class', `pipe-flow ${edge.dirSign < 0 ? 'rev' : ''}`);
      flow.setAttribute('d', `M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`);
      el.appendChild(flow);
    }
    // 泄漏标记
    if (edge.leak) {
      const leak = STATE.leaks.find((l) => l.id === edge.leak);
      const lx = pa.x + (pb.x - pa.x) * leak.offset;
      const ly = pa.y + (pb.y - pa.y) * leak.offset;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'leak-mark');
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', lx); c.setAttribute('cy', ly); c.setAttribute('r', 7);
      c.setAttribute('fill', '#f43f5e');
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', lx); t.setAttribute('y', ly - 12); t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', '#fda4af'); t.setAttribute('font-size', '10');
      t.textContent = `泄漏 ${leak.rate}`;
      g.appendChild(c); g.appendChild(t); el.appendChild(g);
    }
    // 阀门
    const n = edge.valves.length;
    edge.valves.forEach((v, i) => {
      const frac = n === 1 ? 0.5 : (i + 1) / (n + 1);
      const vx = pa.x + (pb.x - pa.x) * frac;
      const vy = pa.y + (pb.y - pa.y) * frac;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'valve-mark');
      g.setAttribute('transform', `translate(${vx},${vy}) rotate(45)`);
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', -5); r.setAttribute('y', -5); r.setAttribute('width', 10); r.setAttribute('height', 10);
      r.setAttribute('fill', v.open ? '#14532d' : '#7f1d1d');
      r.setAttribute('stroke', v.open ? '#22c55e' : '#ef4444');
      g.appendChild(r);
      el.appendChild(g);
      const vt = document.createElementNS(SVGNS, 'text');
      vt.setAttribute('x', vx); vt.setAttribute('y', vy + 20); vt.setAttribute('text-anchor', 'middle');
      vt.setAttribute('class', 'node-name'); vt.textContent = v.id;
      el.appendChild(vt);
    });
  }

  // 站点
  for (const s of STATE.sites) {
    const { x, y } = pos.get(s.id);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'node-g');
    g.setAttribute('transform', `translate(${x},${y})`);
    const fill = s.kind === 'source' ? '#38bdf8' : s.kind === 'compressor' ? '#f59e0b'
      : s.kind === 'demand' ? '#22c55e' : '#94a3b8';
    const c = document.createElementNS(s.kind === 'compressor' ? 'rect' : 'circle');
    c.setAttribute('class', 'node-ring');
    c.setAttribute('r', 9);
    c.setAttribute('x', -8); c.setAttribute('y', -8); c.setAttribute('width', 16); c.setAttribute('height', 16); c.setAttribute('rx', 3);
    c.setAttribute('fill', fill);
    c.setAttribute('stroke', s.connected ? '#0e1420' : '#ef4444');
    c.setAttribute('stroke-width', s.connected ? 2 : 3);
    g.appendChild(c);
    const tp = document.createElementNS(SVGNS, 'text');
    tp.setAttribute('class', 'node-press'); tp.setAttribute('text-anchor', 'middle');
    tp.setAttribute('x', 0); tp.setAttribute('y', -16);
    tp.setAttribute('fill', s.connected ? pColor(s.pressure) : '#ef4444');
    tp.textContent = `${s.pressure.toFixed(2)}`;
    g.appendChild(tp);
    const tn = document.createElementNS(SVGNS, 'text');
    tn.setAttribute('class', 'node-name'); tn.setAttribute('text-anchor', 'middle');
    tn.setAttribute('x', 0); tn.setAttribute('y', 28);
    tn.textContent = s.name;
    g.appendChild(tn);
    if (s.kind === 'compressor') {
      const tl = document.createElementNS(SVGNS, 'text');
      tl.setAttribute('text-anchor', 'middle'); tl.setAttribute('x', 0); tl.setAttribute('y', 42);
      tl.setAttribute('fill', '#f59e0b'); tl.setAttribute('font-size', '9.5');
      tl.textContent = `负荷 ${Math.round((s.load ?? 0) * 100)}%`;
      g.appendChild(tl);
    }
    el.appendChild(g);
  }
  box.innerHTML = '';
  box.appendChild(el);
}

/* ----------------------------- 表格与列表 ----------------------------- */

function renderRegions() {
  const map = { OK: ['ok', '可维持最低供应'], WEAK: ['warn', '压力偏低/减量'], FAIL: ['crit', '无法维持最低供应'] };
  $('#region-table').innerHTML = `<tr><th>区域</th><th>需求/最低</th><th>实际供应</th><th>最低站压</th><th>结论</th></tr>` +
    STATE.regions.map((r) => {
      const [cls, text] = map[r.status];
      const flowPct = Math.min(100, Math.round((r.delivered / r.minFlow) * 100));
      return `<tr>
        <td><b>${esc(r.name)}</b><div style="color:var(--muted);font-size:10.5px">${r.region}</div></td>
        <td>— / ${r.minFlow}</td>
        <td><span class="pbar"><i style="width:${flowPct}%"></i></span> ${r.delivered}</td>
        <td>${r.minPressure === null ? '—' : `<span style="color:${r.minPressure < 2.5 ? '#f43f5e' : '#dce6f2'}">${r.minPressure} MPa</span>`}</td>
        <td><span class="pill ${cls}">${text}</span></td>
      </tr>`;
    }).join('');
}

function renderAlarms() {
  const active = STATE.alarms.filter((a) => a.active).slice().reverse();
  $('#alarm-count').textContent = active.length || '';
  $('#alarm-list').innerHTML = active.length ? active.map((a) => `
    <div class="list-item">
      <div class="li-top"><span class="li-title"><span class="pill ${a.level === 'critical' ? 'crit' : 'warn'}">${a.level === 'critical' ? '严重' : '预警'}</span> ${esc(a.title)}</span>
      <span class="li-meta">T+${a.raisedTick}</span></div>
      <div class="li-detail">${esc(a.detail)}</div>
    </div>`).join('') : '<div class="li-detail" style="color:var(--muted)">无活动报警</div>';
}

function renderSites() {
  const rows = STATE.sites.map((s) => {
    const kindText = { source: '气源', gate: '阀室', compressor: '压气站', demand: '门站' }[s.kind];
    return `<tr>
      <td><b>${esc(s.name)}</b> <span class="pill muted" style="margin-left:4px">${kindText}</span></td>
      <td style="color:${pColor(s.pressure)};font-weight:600">${s.pressure.toFixed(2)} MPa</td>
      <td style="color:var(--muted)">${s.target.toFixed(2)}</td>
      <td>${s.kind === 'compressor' ? `${Math.round(s.load * 100)}%` : '—'}</td>
      <td>${s.flow ? s.flow : '—'}</td>
      <td>${s.connected ? '<span class="pill ok">连通</span>' : '<span class="pill crit">断连</span>'}</td>
    </tr>`;
  }).join('');
  $('#site-table').innerHTML = `<tr><th>站场</th><th>显示压力</th><th>目标压力</th><th>负荷</th><th>子树流量</th><th>供气状态</th></tr>${rows}`;
}

const CMD_STATUS = {
  pending: ['warn', '待审批'], approved: ['info', '已批准/待执行'], dispatched: ['info', '已下发待反馈'],
  done: ['ok', '已执行'], cancelled: ['muted', '已撤销'], expired: ['muted', '已失效'],
  rejected: ['muted', '已驳回'], feedback_mismatch: ['crit', '反馈不一致'], undone: ['muted', '已撤销还原'],
  obsoleted_by_replay: ['muted', '重演作废'],
};

function renderCommands() {
  const list = STATE.commands.slice().reverse();
  $('#cmd-list').innerHTML = list.map((c) => {
    const [cls, text] = CMD_STATUS[c.status] ?? ['muted', c.status];
    const can = (cond) => cond ? '' : 'disabled';
    const isSup = role() === 'supervisor';
    let actions = '';
    if (c.status === 'pending') {
      actions = isSup
        ? `<button class="btn mini primary" data-act="approve" data-id="${c.id}">批准</button>
           <button class="btn mini danger-ghost" data-act="reject" data-id="${c.id}">驳回</button>`
        : '<span class="li-meta">等待主管审批</span>';
    }
    if (['pending', 'approved'].includes(c.status)) {
      actions += ` <button class="btn mini ghost" data-act="cancel" data-id="${c.id}">撤销</button>`;
    }
    if (STATE.reconciling && c.status === 'dispatched' && STATE.pendingReconcile.includes(c.id)) {
      actions = `<span class="pill warn">等待现场反馈</span>
        <button class="btn mini primary" data-act="match" data-id="${c.id}">反馈一致</button>
        <button class="btn mini danger-ghost" data-act="mismatch" data-id="${c.id}">不一致/回滚</button>`;
    }
    if (['done', 'feedback_mismatch'].includes(c.status) && !STATE.reconciling) {
      actions = `<button class="btn mini ghost" data-act="undo" data-id="${c.id}">撤销并还原</button>`;
    }
    const risks = (c.risks ?? []).map((r) => `<div class="risk ${r.level}">${esc(r.text)}</div>`).join('');
    const ttl = c.status === 'pending' ? `审批截止 T+${c.approveDueTick}`
      : c.status === 'approved' ? `执行截止 T+${c.execDueTick}`
      : c.status === 'dispatched' ? `下发于 T+${c.dispatchTick}` : '';
    return `<div class="list-item">
      <div class="li-top"><span class="li-title">${esc(c.title)} <span class="pill ${cls}">${text}</span></span>
      <span class="li-meta">${c.id} · T+${c.createdTick}${ttl ? ' · ' + ttl : ''}</span></div>
      ${risks}
      ${c.feedback?.note ? `<div class="li-detail">现场反馈：${esc(c.feedback.note)}</div>` : ''}
      ${c.expireReason || c.cancelReason || c.undoReason || c.reason ? `<div class="li-detail" style="color:var(--muted)">${esc(c.expireReason || c.cancelReason || c.undoReason || c.reason)}</div>` : ''}
      ${actions ? `<div class="li-actions">${actions}</div>` : ''}
    </div>`;
  }).join('');
}

function renderSnapshots() {
  const list = STATE.snapshots.slice().reverse();
  $('#snap-list').innerHTML = (list.length ? list : []).map((s) => `
    <div class="list-item">
      <div class="li-top"><span class="li-title">${esc(s.label)} ${s.auto ? '<span class="pill info">自动</span>' : ''}</span>
      <span class="li-meta">T+${s.tick}</span></div>
      <div class="li-detail">台账指令 ${s.commandCount} 条</div>
      <div class="li-actions">
        <button class="btn mini primary" data-replay="${s.id}">从此状态重演</button>
      </div>
    </div>`).join('') || '<div class="li-detail" style="color:var(--muted)">尚无快照；系统恢复稳定后会自动记录</div>';
}

function renderEvents() {
  const filter = $('#evt-filter').value;
  let evs = STATE.events.slice().reverse();
  if (filter === 'ALARM') evs = evs.filter((e) => /ALARM|RESOLVE|LEAK|SERVICE/.test(e.type));
  if (filter === 'CMD') evs = evs.filter((e) => e.type.startsWith('CMD') || e.type.includes('RECONCILE') || e.type.includes('REPLAY'));
  $('#event-log').innerHTML = evs.slice(0, 80).map((e) => `
    <div class="list-item" style="padding:5px 8px">
      <span class="li-meta">T+${e.tick}</span>
      <b style="margin:0 6px">${esc(e.title)}</b>
      <span style="color:#a9bfd9">${esc(e.detail)}</span>
    </div>`).join('');
}

/* ----------------------------- 指令表单 ----------------------------- */

function refreshRefOptions() {
  const type = $('#act-type').value;
  const refSel = $('#act-ref');
  $('#act-ref-label').firstChild.textContent = type === 'VALVE' ? '目标阀门 ' : type === 'LOAD' ? '目标压气站 ' : '泄漏点 ';
  $('#act-val-label').style.display = type === 'VALVE' ? '' : 'none';
  $('#act-load-label').style.display = type === 'LOAD' ? '' : 'none';
  let opts = [];
  if (type === 'VALVE') {
    for (const e of STATE.edges) for (const v of e.valves) opts.push({ id: v.id, name: `${v.name}（${v.id}，${v.open ? '开' : '关'}）` });
  } else if (type === 'LOAD') {
    opts = STATE.sites.filter((s) => s.kind === 'compressor').map((s) => ({ id: s.id, name: `${s.name}（当前 ${Math.round(s.load * 100)}%）` }));
  } else {
    opts = STATE.leaks.filter((l) => !l.repaired).map((l) => ({ id: l.id, name: `泄漏点 ${l.id}（${l.edge}，${l.rate} 万m³/d）` }));
  }
  refSel.innerHTML = opts.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
}

async function runPreflight() {
  const type = $('#act-type').value;
  const ref = $('#act-ref').value;
  const payload = type === 'VALVE' ? { open: $('#act-val').value === 'true' }
    : type === 'LOAD' ? { load: Number($('#act-load').value) / 100 } : {};
  const box = $('#preflight-box');
  if (!ref) { box.innerHTML = ''; return; }
  try {
    const { risks } = await fetch('/api/preflight', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ref, payload }),
    }).then((r) => r.json());
    box.innerHTML = risks.length ? risks.map((r) => `<div class="risk ${r.level}">${r.level === 'critical' ? '⛔ ' : r.level === 'warning' ? '⚠ ' : 'ℹ '}${esc(r.text)}</div>`).join('')
      : '<div class="risk info">✓ 预检未发现风险</div>';
  } catch { box.innerHTML = ''; }
}

async function submitAction() {
  const type = $('#act-type').value;
  const ref = $('#act-ref').value;
  if (!ref) return;
  const payload = type === 'VALVE' ? { open: $('#act-val').value === 'true' }
    : type === 'LOAD' ? { load: Number($('#act-load').value) / 100 } : {};
  try {
    await api('/api/commands', { type, ref, payload, role: role(), note: '' });
  } catch (e) { alert(e.message); }
}

/* ----------------------------- 事件绑定 ----------------------------- */

function bind() {
  $('#btn-step').onclick = () => api('/api/advance', { steps: 1 });
  $('#btn-step5').onclick = () => api('/api/advance', { steps: 5 });
  let running = false;
  $('#btn-run').onclick = async () => {
    running = !running;
    await api('/api/run', { on: running });
    $('#btn-run').textContent = running ? '暂停推演' : '自动推演';
  };
  $('#btn-gw-down').onclick = async () => { await api('/api/gateway', { online: false }); };
  $('#btn-gw-up').onclick = async () => { await api('/api/gateway', { online: true }); };
  $('#btn-snapshot').onclick = () => api('/api/snapshots', { label: `手动快照（T+${STATE.tick}）` });
  $('#btn-reset').onclick = async () => { if (confirm('确认重置到初始场景？')) { await api('/api/reset', {}); } };
  $('#role-select').onchange = render;
  $('#act-type').onchange = () => { refreshRefOptions(); runPreflight(); };
  $('#act-ref').onchange = runPreflight;
  $('#act-val').onchange = runPreflight;
  $('#act-load').oninput = () => { $('#act-load-val').textContent = `${$('#act-load').value}%`; runPreflight(); };
  $('#btn-submit').onclick = submitAction;
  $('#evt-filter').onchange = renderEvents;

  document.body.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act], button[data-replay]');
    if (!btn) return;
    try {
      if (btn.dataset.replay) {
        if (confirm('从该稳定状态重演？其后的指令将作废，可重新决策。')) {
          await api('/api/replay', { id: btn.dataset.replay, reason: '调度员手动重演' });
        }
        return;
      }
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'approve') await api(`/api/commands/${id}/approve`, { role: role() });
      else if (act === 'reject') { const reason = prompt('驳回原因（可留空）', '') ?? ''; await api(`/api/commands/${id}/reject`, { role: role(), reason }); }
      else if (act === 'cancel') { const reason = prompt('撤销原因（可留空）', '') ?? ''; await api(`/api/commands/${id}/cancel`, { reason }); }
      else if (act === 'undo') { const reason = prompt('撤销原因（可留空）', '') ?? ''; await api('/api/undo', { id, reason }); }
      else if (act === 'match') await api('/api/reconcile', { id, matched: true, note: '现场阀位/负荷反馈与指令一致' });
      else if (act === 'mismatch') await api('/api/reconcile', { id, matched: false, note: '现场设备反馈与指令不符，已按实况回滚' });
    } catch (e) { alert(e.message); }
  });
}

/* ----------------------------- 主渲染 ----------------------------- */

function render() {
  if (!STATE) return;
  $('#hud-tick').textContent = `T+${STATE.tick} min`;
  $('#hud-gw').textContent = STATE.gatewayOnline ? '在线' : '中断（指令挂起）';
  $('#hud-gw').className = STATE.gatewayOnline ? 'ok' : 'bad';
  $('#hud-gw-wrap').title = STATE.gatewayOnline ? '' : '现场服务中断';
  $('#hud-recon-wrap').style.display = STATE.reconciling ? '' : 'none';
  $('#reconcile-banner').style.display = STATE.reconciling ? '' : 'none';
  $('#btn-gw-down').style.display = STATE.gatewayOnline ? '' : 'none';
  $('#btn-gw-up').style.display = STATE.gatewayOnline ? 'none' : '';

  renderProfile();
  renderRegions();
  renderAlarms();
  renderSites();
  renderCommands();
  renderSnapshots();
  renderEvents();
  refreshRefOptions();
  runPreflight();
}

async function loop() {
  try {
    const res = await fetch('/api/state');
    STATE = await res.json();
    render();
  } catch { /* 服务未就绪时静默重试 */ }
}

bind();
loop();
pollTimer = setInterval(loop, 1000);
