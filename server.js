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
  const link = db.prepare('SELECT id, status, title, category, tags, summary, note FROM links WHERE id = ?').get(req.params.id);
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

// Test Claude connectivity — visit /api/test-claude in browser to diagnose
app.get('/api/test-claude', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY is not set' });
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const models = ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'];
    const results = {};
    for (const model of models) {
      try {
        const r = await client.messages.create({
          model, max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }]
        });
        results[model] = 'OK: ' + r.content[0].text.trim();
      } catch (e) {
        results[model] = 'ERROR: ' + String(e.message).slice(0, 120);
      }
    }
    res.json({ ok: true, key_prefix: process.env.ANTHROPIC_API_KEY.slice(0, 10) + '…', models: results });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n LinkCurator running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(' Warning: ANTHROPIC_API_KEY not set — AI tagging disabled');
  }
  console.log('');
});
