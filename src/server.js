/**
 * 零依赖 HTTP 服务：
 *  - GET  /                 前端页面
 *  - GET  /api/state        全量推演状态（前端 1s 轮询）
 *  - POST /api/advance      推进 ticks {steps}
 *  - POST /api/run          自动推进 {on:boolean}
 *  - POST /api/commands     提交指令 {type,ref,payload,role,note}
 *  - POST /api/commands/:id/approve | /reject | /cancel
 *  - POST /api/reconcile    服务恢复后的设备反馈核对 {id,matched,note}
 *  - POST /api/undo         撤销已生效指令 {id,reason}
 *  - POST /api/gateway      现场服务 {online}
 *  - POST /api/leak         人工注入泄漏 {edge,rate,offset}
 *  - POST /api/snapshots    手动快照 {label}
 *  - POST /api/replay       从快照重演 {id,reason}
 *  - POST /api/reset        重置场景
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { makeEngine, advance, regionStatus, autoSnapshot, setGateway, startLeak, resolveReconcile } from './engine.js';
import { submitCommand, approveCommand, rejectCommand, cancelCommand, preflight } from './commands.js';
import { restoreSnapshot, undoDispatched } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

let eng = makeEngine(Date.now(), { scripted: true });
let runTimer = null;

function serialize() {
  return {
    tick: eng.tick,
    running: eng.running,
    gatewayOnline: eng.gatewayOnline,
    reconciling: eng.reconciling,
    pendingReconcile: eng.pendingReconcile,
    sites: [...eng.sites.values()].map((s) => ({
      id: s.id, name: s.name, kind: s.kind, x: s.x, y: s.y,
      elevation: s.elevation ?? 0, pressure: round(s.pressure),
      target: round(s.target), flow: Math.round(s.flow * 10) / 10,
      connected: s.connected, load: s.load, region: s.region ?? null, online: s.online,
    })),
    edges: [...eng.edges.values()].map((e) => ({
      id: e.id, ends: e.ends, length: e.length, main: e.main,
      flow: Math.round(e.flow * 10) / 10, dirSign: e.dirSign,
      valves: e.valves.map((v) => ({ id: v.id, name: v.name, open: v.open })),
      leak: [...eng.leaks.values()].find((l) => l.edge === e.id && !l.repaired)?.id ?? null,
    })),
    leaks: [...eng.leaks.values()].map((l) => ({
      id: l.id, edge: l.edge, rate: l.rate, offset: l.offset,
      startTick: l.startTick, detectedAt: l.detectedAt, repaired: !!l.repaired,
    })),
    alarms: eng.alarms.slice(-40),
    regions: regionStatus(eng),
    commands: eng.commands.slice(-60).map((c) => ({
      id: c.id, type: c.type, ref: c.ref, payload: c.payload, status: c.status,
      title: c.title, note: c.note, createdTick: c.createdTick,
      approveDueTick: c.approveDueTick, execDueTick: c.execDueTick,
      approvedBy: c.approvedBy, submittedBy: c.submittedBy,
      dispatchTick: c.dispatchTick, doneTick: c.doneTick,
      risks: c.risks, feedback: c.feedback,
      expireReason: c.expireReason ?? null, cancelReason: c.cancelReason ?? null,
      undoReason: c.undoReason ?? null, reason: c.reason ?? null,
    })),
    events: eng.events.slice(-120),
    snapshots: eng.snapshots.map((s) => ({
      id: s.id, label: s.label, tick: s.tick, at: s.at, auto: !!s.auto,
      commandCount: s.commandCount,
    })),
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

function stopRun() {
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  eng.running = false;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/' ) {
      const html = await readFile(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (p.startsWith('/web/')) {
      const file = path.join(WEB_DIR, path.normalize(p.slice(4)).replace(/^(\.\.[/\\])+/, ''));
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      return res.end(buf);
    }

    if (p === '/api/state' && req.method === 'GET') return json(res, 200, serialize());

    if (p === '/api/preflight' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { risks: preflight(eng, b.type, b.ref, b.payload ?? {}) });
    }
    if (p === '/api/advance' && req.method === 'POST') {
      stopRun();
      const b = await readBody(req);
      advance(eng, Math.max(1, Math.min(50, Number(b.steps ?? 1))));
      return json(res, 200, serialize());
    }
    if (p === '/api/run' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.on) {
        stopRun();
        eng.running = true;
        runTimer = setInterval(() => { try { advance(eng, 1); } catch (e) { stopRun(); console.error(e); } }, 650);
      } else stopRun();
      return json(res, 200, serialize());
    }
    if (p === '/api/commands' && req.method === 'POST') {
      const b = await readBody(req);
      const cmd = submitCommand(eng, b);
      return json(res, 200, { command: cmd, state: serialize() });
    }
    const cmdMatch = p.match(/^\/api\/commands\/([^/]+)\/(approve|reject|cancel)$/);
    if (cmdMatch && req.method === 'POST') {
      const b = await readBody(req);
      const [, id, action] = cmdMatch;
      let cmd;
      if (action === 'approve') cmd = approveCommand(eng, id, b.role ?? 'supervisor');
      if (action === 'reject') cmd = rejectCommand(eng, id, b.role ?? 'supervisor', b.reason ?? '');
      if (action === 'cancel') cmd = cancelCommand(eng, id, b.reason ?? '');
      return json(res, 200, { command: cmd, state: serialize() });
    }
    if (p === '/api/reconcile' && req.method === 'POST') {
      const b = await readBody(req);
      resolveReconcile(eng, b.id, !!b.matched, b.note ?? "");
      return json(res, 200, serialize());
    }
    if (p === '/api/undo' && req.method === 'POST') {
      const b = await readBody(req);
      await undoDispatched(eng, b.id, b.reason ?? '');
      return json(res, 200, serialize());
    }
    if (p === '/api/gateway' && req.method === 'POST') {
      const b = await readBody(req);
      setGateway(eng, !!b.online, false);
      return json(res, 200, serialize());
    }
    if (p === '/api/leak' && req.method === 'POST') {
      const b = await readBody(req);
      const leak = startLeak(eng, b.edge, Number(b.rate ?? 20), Number(b.offset ?? 0.5), null, false);
      return json(res, 200, { leak, state: serialize() });
    }
    if (p === '/api/snapshots' && req.method === 'POST') {
      const b = await readBody(req);
      const snap = autoSnapshot(eng, b.label || `手动快照（tick ${eng.tick}）`, false);
      return json(res, 200, { snapshot: snap, state: serialize() });
    }
    if (p === '/api/replay' && req.method === 'POST') {
      const b = await readBody(req);
      restoreSnapshot(eng, b.id, b.reason ?? '');
      return json(res, 200, serialize());
    }
    if (p === '/api/reset' && req.method === 'POST') {
      stopRun();
      eng = makeEngine(Date.now(), { scripted: true });
      return json(res, 200, serialize());
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: String(e.message ?? e) });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
server.listen(PORT, () => {
  console.log(`管网异常处置推演系统已启动: http://localhost:${PORT}`);
});
