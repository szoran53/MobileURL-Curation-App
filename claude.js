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

// Local Bonsai-2-28B (llama.cpp) inference is much slower than the cloud, so
// the timeout default is raised well above the old 25s. Tune via LLM_TIMEOUT_MS.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 512);

// Calls the llama.cpp llama-server OpenAI-compatible endpoint
//  POST /v1/chat/completions  and reads choices[0].message.content
//  (the llama.cpp/OpenAI shape, vs the old Anthropic content[0].text).
async function callLLM(prompt) {
  const base = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  if (!base) throw new Error('LLM_BASE_URL is not set — cannot reach llama.cpp llama-server');
  if (!model) throw new Error('LLM_MODEL is not set — local curation model not configured');

  const endpoint = base.replace(/\/$/, '') + '/chat/completions';
  const body = JSON.stringify({
    model,
    max_tokens: LLM_MAX_TOKENS,
    // Pre-fill the assistant turn with '{' to force a raw JSON response
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' }
    ]
  });
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LLM_API_KEY) headers.Authorization = `Bearer ${process.env.LLM_API_KEY}`;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM timeout after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS)
  );

  const response = await Promise.race([
    fetch(endpoint, { method: 'POST', headers, body }),
    timeout
  ]);

  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM request failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('No text content in LLM response (expected choices[0].message.content)');
  }

  // Return the raw model text. Because we pre-fill the assistant turn with '{',
  // llama.cpp normally returns the continuation (after the '{'); some servers
  // may return a complete object. Callers normalize to a full object string.
  return content.trim();
}

async function processLink(id, url) {
  const db = getDB();

  // Graceful fallback when the local LLM isn't configured: still save the link
  // using page metadata only (status done, category Miscellaneous).
  const llmReady = process.env.LLM_BASE_URL && process.env.LLM_MODEL;
  if (!llmReady) {
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

    const text = await callLLM(prompt);
    // The '{' pre-fill makes the model emit the continuation, but a complete
    // object may also be returned. Normalize to a full object string, then
    // extract the (first) JSON object.
    const candidate = text.trim().startsWith('{') ? text.trim() : '{' + text.trim();
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in LLM response');

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

module.exports = { processLink, callLLM };