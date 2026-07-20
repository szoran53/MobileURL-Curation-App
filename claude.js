const Anthropic = require('@anthropic-ai/sdk');
const { getDB } = require('./db');

const CATEGORIES = [
  'Claude & Anthropic',
  'AI Research & Papers',
  'AI Tools & Products',
  'Community Discussions',
  'AI Safety & Ethics',
  'AI in Industry',
  'Tutorials & How-tos',
  'Miscellaneous'
];

function extractMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }
  return '';
}

function extractTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

async function fetchPageMetadata(url) {
  try {
    // X.com/Twitter always blocks scrapers — skip the fetch entirely, use URL only
    if (url.includes('x.com') || url.includes('twitter.com')) {
      return { title: '', description: '', source: 'x' };
    }

    if (url.includes('reddit.com/r/') && url.includes('/comments/')) {
      const jsonUrl = url.split('?')[0].replace(/\/?$/, '.json');
      const resp = await fetch(jsonUrl, {
        headers: { 'User-Agent': 'LinkCurator/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const post = data[0]?.data?.children[0]?.data;
        if (post) {
          return {
            title: post.title || '',
            description: (post.selftext || '').slice(0, 600),
            source: 'reddit'
          };
        }
      }
    }

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LinkCurator/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!resp.ok) return { title: '', description: '', source: 'web' };
    const html = await resp.text();

    const title = extractMeta(html, 'og:title') || extractTag(html, 'title') || '';
    const description = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
    const siteName = extractMeta(html, 'og:site_name') || '';

    let source = 'web';
    if (url.includes('twitter.com') || url.includes('x.com')) source = 'x';
    else if (url.includes('reddit.com')) source = 'reddit';
    else if (url.includes('youtube.com') || url.includes('youtu.be')) source = 'youtube';
    else if (siteName) source = siteName.toLowerCase().replace(/\s+/g, '-');

    return { title: title.slice(0, 200), description: description.slice(0, 600), source };
  } catch (err) {
    console.error('fetchPageMetadata error:', url, err.message);
    return { title: '', description: '', source: 'web' };
  }
}

const MODELS = [
  'claude-haiku-4-5-20251001',
];

async function callClaude(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let lastErr;
  for (const model of MODELS) {
    try {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Claude API timeout')), 25000);
      });
      // Pre-fill the assistant turn with '{' to force a raw JSON response
      const response = await Promise.race([
        client.messages.create({
          model,
          max_tokens: 512,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: '{' }
          ]
        }),
        timeout
      ]);
      clearTimeout(timeoutId);
      return '{' + response.content[0].text.trim();
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      const status = err.status || err.statusCode || 0;
      const isModelError = status === 404 || msg.includes('model') || msg.includes('not found') || msg.includes('404');
      if (!isModelError) throw err;
      console.warn(`Model ${model} unavailable, trying next...`);
    }
  }
  throw lastErr;
}

async function processLink(id, url) {
  const db = getDB();

  if (!process.env.ANTHROPIC_API_KEY) {
    const meta = await fetchPageMetadata(url);
    db.prepare(`UPDATE links SET title = ?, status = 'done', category = 'Miscellaneous' WHERE id = ?`)
      .run(meta.title || url, id);
    return;
  }

  try {
    const meta = await fetchPageMetadata(url);

    const prompt = `You are a curator of AI and technology content. Analyze this link and return structured metadata.

URL: ${url}
Page Title: ${meta.title || '(not available)'}
Page Description: ${meta.description || '(not available)'}
Source: ${meta.source}

Respond with ONLY a valid JSON object (no markdown, no code fences, no extra text):
{
  "title": "clear descriptive title — use the page title if good, otherwise write a better one",
  "summary": "2-3 sentences: what this content is about and why it is interesting or significant",
  "category": "exactly one of: ${CATEGORIES.join(' | ')}",
  "tags": ["tag1", "tag2", "tag3"]
}

Tags should be specific (e.g. "Claude 4", "prompt engineering", "AI safety", "open source", "benchmark"). 3-5 tags max.`;

    const text = await callClaude(prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');

    const result = JSON.parse(jsonMatch[0]);

    db.prepare(`
      UPDATE links SET title = ?, summary = ?, category = ?, tags = ?, status = 'done', error_msg = NULL
      WHERE id = ?
    `).run(
      result.title || meta.title || url,
      result.summary || '',
      CATEGORIES.includes(result.category) ? result.category : 'Miscellaneous',
      JSON.stringify(Array.isArray(result.tags) ? result.tags.slice(0, 5) : []),
      id
    );
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    console.error('processLink error:', msg);
    db.prepare(`UPDATE links SET status = 'error', title = ?, error_msg = ? WHERE id = ?`).run(url, msg, id);
  }
}

module.exports = { processLink };
