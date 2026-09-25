require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDB, getDB } = require('./db');
const { processLink } = require('./claude');
const { extractURLsFromEmail } = require('./emailParser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

initDB();

// Save a new link
app.post('/api/links', async (req, res) => {
  const { url, note } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Valid URL required' });

  const db = getDB();
  const result = db.prepare(
    `INSERT INTO links (url, note, source, status) VALUES (?, ?, 'web', 'pending')`
  ).run(url.trim(), note || null);

  const id = result.lastInsertRowid;
  processLink(id, url.trim()).catch(console.error);
  res.json({ id, status: 'pending' });
});

// Poll link status
app.get('/api/links/:id/status', (req, res) => {
  const db = getDB();
  const link = db.prepare('SELECT id, url, source, status, title, category, tags, summary, note, created_at, read, error_msg FROM links WHERE id = ?').get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Not found' });
  res.json({ ...link, tags: JSON.parse(link.tags || '[]') });
});

function tzDateExpr(tzMins) {
  const n = parseInt(tzMins);
  const safe = isNaN(n) ? 0 : Math.max(-840, Math.min(840, n));
  return safe === 0 ? 'created_at' : `datetime(created_at, '${safe} minutes')`;
}

// Get today's digest grouped by category
app.get('/api/digest', (req, res) => {
  const db = getDB();
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const expr = tzDateExpr(req.query.tz);

  const links = db.prepare(`
    SELECT * FROM links
    WHERE date(${expr}) = ? AND status = 'done'
    ORDER BY category ASC, created_at DESC
  `).all(date);

  const grouped = {};
  for (const link of links) {
    const cat = link.category || 'Miscellaneous';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ ...link, tags: JSON.parse(link.tags || '[]') });
  }

  res.json({ date, categories: grouped, total: links.length });
});

// Get all links (browse)
app.get('/api/links', (req, res) => {
  const db = getDB();
  const { search, category, unread, limit = 50, offset = 0 } = req.query;

  let query = `SELECT * FROM links WHERE status != 'pending'`;
  const params = [];

  if (search) {
    query += ' AND (title LIKE ? OR summary LIKE ? OR url LIKE ? OR tags LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (unread === '1') { query += ' AND read = 0'; }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const links = db.prepare(query).all(...params);
  res.json(links.map(l => ({ ...l, tags: JSON.parse(l.tags || '[]') })));
});

// Mark as read / unread
app.patch('/api/links/:id', (req, res) => {
  const db = getDB();
  const updates = [];
  const params = [];
  if (req.body.read !== undefined) { updates.push('read = ?'); params.push(req.body.read ? 1 : 0); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE links SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Delete a link
app.delete('/api/links/:id', (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Get distinct categories with counts
app.get('/api/categories', (req, res) => {
  const db = getDB();
  const cats = db.prepare(`
    SELECT category, COUNT(*) as count, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread
    FROM links WHERE category IS NOT NULL AND status = 'done'
    GROUP BY category ORDER BY count DESC
  `).all();
  res.json(cats);
});

// Stats for the header badge
app.get('/api/stats', (req, res) => {
  const db = getDB();
  const today = req.query.date || new Date().toISOString().split('T')[0];
  const expr = tzDateExpr(req.query.tz);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN read = 0 AND status = 'done' THEN 1 ELSE 0 END) as unread,
      SUM(CASE WHEN date(${expr}) = ? AND status = 'done' THEN 1 ELSE 0 END) as today
    FROM links
  `).get(today);
  res.json(stats);
});

// Test LLM connectivity — visit /api/test-llm in browser to diagnose.
// Probes llama.cpp llama-server: lists models (GET ${LLM_BASE_URL}/models) and,
// when LLM_MODEL is set, runs a tiny completion as a smoke check.
app.get('/api/test-llm', async (req, res) => {
  const base = process.env.LLM_BASE_URL;
  if (!base) {
    return res.json({ ok: false, error: 'LLM_BASE_URL is not set — cannot reach llama.cpp llama-server' });
  }
  try {
    const modelsUrl = base.replace(/\/$/, '') + '/models';
    const modelsResp = await fetch(modelsUrl, {
      headers: { Authorization: process.env.LLM_API_KEY ? `Bearer ${process.env.LLM_API_KEY}` : undefined }
    });
    const modelsText = String(await modelsResp.text().catch(() => ''));
    if (!modelsResp.ok) {
      return res.json({ ok: false, error: `LLM server /models failed: ${modelsResp.status} ${modelsText.slice(0, 200)}` });
    }
    let modelIds = [];
    try {
      const modelsData = JSON.parse(modelsText);
      modelIds = (modelsData.data || []).map(m => m.id);
    } catch {
      return res.json({ ok: false, error: 'LLM server /models returned non-JSON' });
    }
    const expected = process.env.LLM_MODEL || null;

    let smoke = expected ? 'not set' : 'skipped (set LLM_MODEL to test)';
    if (expected) {
      const endpoint = base.replace(/\/$/, '') + '/chat/completions';
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;
      const smokeResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: expected, max_tokens: 32, messages: [{ role: 'user', content: 'Say "ok"' }] })
      });
      if (smokeResp.ok) {
        const d = JSON.parse(String(await smokeResp.text().catch(() => '')));
        const msg = d.choices?.[0]?.message;
        const smokeText = (msg?.content || msg?.reasoning_content || '').trim();
        smoke = 'OK: ' + smokeText.slice(0, 80);
      } else {
        smoke = `ERROR: ${smokeResp.status} ${String(await smokeResp.text().catch(() => '')).slice(0, 120)}`;
      }
    }

    res.json({
      ok: modelIds.length > 0 && (!expected || modelIds.includes(expected)),
      base,
      model: expected,
      modelMatch: expected ? modelIds.includes(expected) : true,
      available: modelIds,
      smoke
    });
  } catch (e) {
    res.json({ ok: false, error: String(e.message) });
  }
});

// Reprocess a failed or stuck-pending link
app.post('/api/links/:id/reprocess', async (req, res) => {
  const db = getDB();
  const link = db.prepare(`SELECT id, url FROM links WHERE id = ? AND status IN ('error','pending')`).get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Link not found or already done' });
  db.prepare(`UPDATE links SET status = 'pending', error_msg = NULL WHERE id = ?`).run(link.id);
  processLink(link.id, link.url).catch(console.error);
  res.json({ ok: true });
});

// Email webhook (Mailgun / SendGrid inbound)
app.post('/api/email-webhook', async (req, res) => {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Support Mailgun (body-plain) and SendGrid (text) and plain JSON (body)
  const body = req.body['body-plain'] || req.body.text || req.body.body || '';
  const subject = req.body.subject || req.body.Subject || '';
  const combined = body + ' ' + subject;

  const urls = extractURLsFromEmail(combined);
  if (urls.length === 0) return res.json({ saved: 0, message: 'No URLs found' });

  const db = getDB();
  let saved = 0;
  for (const url of urls.slice(0, 10)) {
    try {
      const result = db.prepare(
        `INSERT INTO links (url, source, status) VALUES (?, 'email', 'pending')`
      ).run(url);
      processLink(result.lastInsertRowid, url).catch(console.error);
      saved++;
    } catch (err) {
      console.error('Email link save error:', err);
    }
  }

  res.json({ saved, urls });
});

// Listen only when run directly (so the app can be imported by tests).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n LinkCurator running at http://localhost:${PORT}`);
    if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
      console.log(' Warning: LLM_BASE_URL or LLM_MODEL not set — AI curation disabled');
    }
    console.log('');
  });
}

module.exports = app;
