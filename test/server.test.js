'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpdir } = require('os');
const http = require('http');

// Isolated DB (stable shared dir — both test files in this process use it).
process.env.DATA_DIR = path.join(tmpdir(), 'lc-shared-test-db');
process.env.LLM_MODEL = 'test-model';
process.env.LLM_TIMEOUT_MS = '3000';
delete process.env.ANTHROPIC_API_KEY;
// LLM_BASE_URL is set dynamically below (it depends on the fake port).

// Pick a free TCP port so repeated runs never collide (EADDRINUSE).
function freePort(start) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.on('error', () => {
      s.close();
      resolve(start + 1);
    });
    s.listen({ port: start, reusePort: true }, () => {
      s.close();
      resolve(start);
    });
  });
}

function startFakeServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Drain the request body so POSTs don't hang.
      req.on('data', () => {});
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }));
        return;
      }
      if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{
              message: {
                content:
                  '"title": "Fake LLM Title", "summary": "Fake two or three sentence summary explaining the page.", "category": "AI Research & Papers", "tags": ["fake","llm"] }',
              },
            }],
          })
        );
        return;
      }
      // Serve a page for processLink page fetches.
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>Fake Page</title><meta property="og:description" content="Fake page description"></head></html>');
    });
    server.listen(port, () => resolve(server));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('server: /api/test-llm, /api/links curation, and stats', async () => {
  const FAKE_PORT = await freePort(39997);
  const APP_PORT = await freePort(39998);
  process.env.LLM_BASE_URL = `http://127.0.0.1:${FAKE_PORT}/v1`;
  const fake = await startFakeServer(FAKE_PORT);
  const app = require('../server.js');
  const appServer = app.listen(APP_PORT);
  const base = `http://127.0.0.1:${APP_PORT}`;
  await new Promise((r) => appServer.once('listening', r));

  try {
    // 1) /api/test-llm
    const tl = await fetch(`${base}/api/test-llm`);
    const tlj = await tl.json();
    assert.ok(tl.ok && tlj.ok, 'test-llm should return ok:true');
    assert.deepStrictEqual(tlj.available, ['test-model', 'other-model']);
    assert.strictEqual(tlj.model, 'test-model');
    assert.strictEqual(tlj.modelMatch, true);
    assert.ok(tlj.smoke && tlj.smoke.startsWith('OK:'), 'smoke completion should succeed');

    // 2) POST /api/links then poll status to done
    const post = await fetch(`${base}/api/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${FAKE_PORT}/fake-page` }),
    });
    assert.ok(post.ok, 'POST /api/links should 200');
    const created = await post.json();
    assert.ok(created.id, 'POST /api/links should return an id');
    assert.strictEqual(created.status, 'pending');

    let row;
    for (let i = 0; i < 30; i++) {
      const sr = await fetch(`${base}/api/links/${created.id}/status`);
      row = await sr.json();
      if (row.status && row.status !== 'pending') break;
      await sleep(100);
    }
    assert.strictEqual(row.status, 'done', 'link should finish as done');
    assert.strictEqual(row.title, 'Fake LLM Title');
    assert.strictEqual(row.category, 'AI Research & Papers');
    assert.deepStrictEqual(row.tags, ['fake', 'llm']);

    // Regression (forever spinner): /status must return the fields the save
    // screen's proc card needs. The SELECT used to omit url/source/created_at/
    // read/error_msg, so buildCard(statusResp) threw on truncUrl(undefined) and
    // the spinner never stopped. These asserts lock that in.
    assert.ok(row.url, 'status must return url');
    assert.ok(row.source, 'status must return source');
    assert.ok(row.created_at, 'status must return created_at');
    assert.ok('read' in row, 'status must return read');
    assert.ok('error_msg' in row, 'status must return error_msg');

    // 3) stats + categories
    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.ok(stats.total >= 1, 'stats.total >= 1');
    const cats = await (await fetch(`${base}/api/categories`)).json();
    assert.ok(Array.isArray(cats), 'categories should be an array');
  } finally {
    appServer.close(() => {});
    fake.close(() => {});
  }
});