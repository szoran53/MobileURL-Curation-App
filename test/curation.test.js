'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpdir } = require('os');

// Isolated DB (db.js reads DATA_DIR at load time), and a fast timeout.
process.env.DATA_DIR = path.join(tmpdir(), 'lc-shared-test-db');
process.env.LLM_BASE_URL = 'http://127.0.0.1:8080/v1';
process.env.LLM_MODEL = 'test-model';
process.env.LLM_TIMEOUT_MS = '1000';
process.env.PORT = '39999';

// Require AFTER env is set (claude.js reads LLM_TIMEOUT_MS at load time).
const { callLLM, processLink } = require('../claude.js');
const { getDB } = require('../db.js');

function mockFetch(handlers) {
  global.fetch = async (url) => {
    const u = new URL(url);
    for (const [re, h] of handlers) {
      if (re.test(u.pathname)) {
        return typeof h === 'function' ? h() : h;
      }
    }
    throw new Error('unhandled fetch: ' + u.pathname);
  };
}

function resp(body, { ok = true, status = 200 } = {}) {
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => str,
    json: async () => (typeof body === 'string' ? body : body),
  };
}

function page(title = 'Mock Page', desc = 'A short description') {
  return resp(`<html><head><title>${title}</title><meta property="og:description" content="${desc}"></head><body>hi</body></html>`);
}

function insert(url, note = null) {
  return getDB()
    .prepare("INSERT INTO links (url, note, source, status) VALUES (?, ?, 'web', 'pending')")
    .run(url, note)
    .lastInsertRowid;
}

function getRow(id) {
  return getDB().prepare('SELECT * FROM links WHERE id = ?').get(id);
}

// Handlers: specific first, a catch-all page handler last.
function llmHandlers(continuationOrObject) {
  return [
    [/chat\/completions/, resp({ choices: [{ message: { content: continuationOrObject } }] })],
    [/.*/, page()],
  ];
}

describe('callLLM (llama.cpp OpenAI-compatible client)', () => {
  test('returns continuation after the { pre-fill', async () => {
    const cont = '"title": "T", "summary": "S", "category": "Miscellaneous", "tags": ["a"] }';
    mockFetch(llmHandlers(cont));
    const out = await callLLM('prompt');
    assert.strictEqual(out, cont);
  });

  test('returns a complete object as-is', async () => {
    const full = '{"title": "T", "summary": "S", "category": "Miscellaneous", "tags": ["a"]}';
    mockFetch(llmHandlers(full));
    const out = await callLLM('prompt');
    assert.strictEqual(out, full);
  });

  test('throws a readable error on a 500', async () => {
    mockFetch([[/chat\/completions/, resp('model not found', { ok: false, status: 500 })]]);
    await assert.rejects(() => callLLM('prompt'), /LLM request failed \(500\)/);
  });

  test('throws a timeout error when the response hangs', async () => {
    mockFetch([[/chat\/completions/, () => new Promise(() => {})], [/.*/, page()]]);
    await assert.rejects(() => callLLM('prompt'), /LLM timeout/);
  });

  test('throws when LLM_BASE_URL is unset', async () => {
    const saved = process.env.LLM_BASE_URL;
    delete process.env.LLM_BASE_URL;
    try {
      await assert.rejects(() => callLLM('prompt'), /LLM_BASE_URL is not set/);
    } finally {
      process.env.LLM_BASE_URL = saved;
    }
  });
});

describe('processLink (curation + DB)', () => {
  test('curates a link from a continuation response', async () => {
    const cont =
      '"title": "Test Title", "summary": "A two or three sentence summary.", "category": "AI Research & Papers", "tags": ["a","b","c"] }';
    mockFetch(llmHandlers(cont));
    const id = insert('https://example.com/cont');
    await processLink(id, 'https://example.com/cont');
    const row = getRow(id);
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.title, 'Test Title');
    assert.ok(row.summary.length > 0);
    assert.strictEqual(row.category, 'AI Research & Papers');
    assert.deepStrictEqual(JSON.parse(row.tags), ['a', 'b', 'c']);
  });

  test('curates from a complete-object response (no double pre-fill)', async () => {
    const full =
      '{"title": "Obj Title", "summary": "Another two or three sentence summary.", "category": "Community Discussions", "tags": ["x","y"]}';
    mockFetch(llmHandlers(full));
    const id = insert('https://example.com/full');
    await processLink(id, 'https://example.com/full');
    const row = getRow(id);
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.title, 'Obj Title');
    assert.deepStrictEqual(JSON.parse(row.tags), ['x', 'y']);
  });

  test('caps tags at 5', async () => {
    const cont =
      '"title": "T", "summary": "S.", "category": "Miscellaneous", "tags": ["1","2","3","4","5","6","7"] }';
    mockFetch(llmHandlers(cont));
    const id = insert('https://example.com/manytags');
    await processLink(id, 'https://example.com/manytags');
    const row = getRow(id);
    assert.deepStrictEqual(JSON.parse(row.tags), ['1', '2', '3', '4', '5']);
  });

  test('falls back to metadata-only when LLM env is unset', async () => {
    const savedBase = process.env.LLM_BASE_URL;
    const savedModel = process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    try {
      mockFetch([[/chat\/completions/, resp('should-not-reach', { ok: false, status: 404 })], [/.*/, page('Fallback Page', 'Fallback description')]]);
      const id = insert('https://example.com/fallback');
      await processLink(id, 'https://example.com/fallback');
      const row = getRow(id);
      assert.strictEqual(row.status, 'done');
      assert.strictEqual(row.title, 'Fallback Page');
      assert.strictEqual(row.category, 'Miscellaneous');
    } finally {
      process.env.LLM_BASE_URL = savedBase;
      process.env.LLM_MODEL = savedModel;
    }
  });

  test('marks status=error and records error_msg when the LLM fails', async () => {
    mockFetch([[/chat\/completions/, resp('boom', { ok: false, status: 503 })], [/.*/, page()]]);
    const id = insert('https://example.com/bad');
    await processLink(id, 'https://example.com/bad');
    const row = getRow(id);
    assert.strictEqual(row.status, 'error');
    assert.ok(row.error_msg);
  });
});