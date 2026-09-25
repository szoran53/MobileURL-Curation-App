'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// These helpers live in the browser-facing HTML, not in a Node module.
// Extract the named function definitions verbatim from public/index.html and
// evaluate them in this process so we can regression-test them under node.
const HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${name} in ${HTML_PATH}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart === -1) throw new Error(`No body found for ${name}`);
  // Brace-count from the body's opening brace to find its matching close.
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`No matching closing brace for ${name}`);
}

function evalFn(name) {
  const source = fs.readFileSync(HTML_PATH, 'utf8');
  const fnSrc = extractFunction(source, name);
  return new Function(`return (${fnSrc});`)();
}

const truncUrl = evalFn('truncUrl');

test('truncUrl(undefined) returns a string and does not throw (regression: forever spinner)', () => {
  // Before the fix this threw: catch => undefined.slice(0, 50) -> TypeError,
  // which was swallowed by pollLink and left the save-screen proc card stuck.
  const r = truncUrl(undefined);
  assert.ok(typeof r === 'string', 'should return a string, got ' + (r == null ? 'null' : String(r)));
  assert.strictEqual(r, '');
});

test('truncUrl(null) returns a string and does not throw', () => {
  assert.strictEqual(truncUrl(null), '');
});

test('truncUrl("") returns an empty string and does not throw', () => {
  assert.strictEqual(truncUrl(''), '');
});

test('truncUrl returns hostname + path for a normal URL', () => {
  assert.strictEqual(truncUrl('https://www.example.com/short'), 'example.com/short');
  assert.strictEqual(truncUrl('http://example.com'), 'example.com/');
});

test('truncUrl truncates long paths to 32 chars + ellipsis', () => {
  const long = 'https://www.example.com/' + Array(20).fill('a').join('/');
  const r = truncUrl(long);
  assert.ok(r.startsWith('example.com/'), 'should start with hostname');
  assert.strictEqual(r.length, 'example.com'.length + 33, 'hostname (11) + 32 path chars + ellipsis = 44');
  assert.ok(r.includes('…'), 'should end with a truncation marker');
});
