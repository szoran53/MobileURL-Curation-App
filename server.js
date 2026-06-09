require('dotenv').config();
const express = require('express');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '19999');
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');
const HISTORY_SIZE = 60; // ~5 min at 5s interval

function parseNodes(str) {
  if (!str) return [];
  return str.split(',').map(part => {
    const trimmed = part.trim();
    const colon = trimmed.lastIndexOf(':');
    if (colon > 0 && colon < trimmed.length - 1) {
      const name = trimmed.slice(0, colon);
      const ip = trimmed.slice(colon + 1);
      return { id: name.toLowerCase().replace(/\s+/g, '-'), name, ip };
    }
    return { id: trimmed, name: trimmed, ip: trimmed };
  }).filter(n => n.ip);
}

const NODES = parseNodes(process.env.FARM_NODES);
if (NODES.length === 0) {
  console.warn('No nodes configured. Set FARM_NODES=name1:ip1,name2:ip2');
} else {
  console.log(`Monitoring ${NODES.length} node(s): ${NODES.map(n => `${n.name}(${n.ip})`).join(', ')}`);
}

const state = new Map();
NODES.forEach(n => state.set(n.id, {
  ...n, alive: false, metrics: null, error: null,
  history: { cpu: [], gpus: [] }, lastPoll: 0
}));

function fetchMetrics(node) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: node.ip, port: METRICS_PORT, path: '/metrics', timeout: 3000 },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ alive: false, error: `HTTP ${res.statusCode}` });
        }
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            resolve({ alive: true, metrics: JSON.parse(body), error: null });
          } catch {
            resolve({ alive: false, error: 'JSON parse error' });
          }
        });
      }
    );
    req.on('error', e => resolve({ alive: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, error: 'Timeout' }); });
  });
}

async function poll() {
  await Promise.all(NODES.map(async node => {
    const result = await fetchMetrics(node);
    const prev = state.get(node.id);
    const history = prev?.history || { cpu: [], gpus: [] };

    if (result.alive && result.metrics) {
      history.cpu.push(result.metrics.cpu?.overall ?? 0);
      if (history.cpu.length > HISTORY_SIZE) history.cpu.shift();

      (result.metrics.gpus || []).forEach((gpu, i) => {
        if (!history.gpus[i]) history.gpus[i] = [];
        history.gpus[i].push(gpu.util_pct ?? 0);
        if (history.gpus[i].length > HISTORY_SIZE) history.gpus[i].shift();
      });
    }

    state.set(node.id, { ...node, ...result, history, lastPoll: Date.now() });
  }));
}

if (NODES.length > 0) {
  poll();
  setInterval(poll, POLL_MS);
}

app.use(express.static('public'));

app.get('/api/nodes', (_req, res) => {
  res.json(Array.from(state.values()));
});

app.get('/api/nodes/:id', (req, res) => {
  const node = state.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  res.json(node);
});

app.listen(PORT, () => console.log(`Farm monitor on :${PORT}`));
