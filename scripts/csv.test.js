const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const {
  csvField,
  renderCsv,
  csvFilename,
  contentDispositionAttachment,
  sendCsv,
} = require('../src/csv');

const day = new Date('2026-10-11T23:30:00Z');

assert.strictEqual(csvField('Control'), 'Control');
assert.strictEqual(csvField('v_abc'), 'v_abc');
assert.strictEqual(csvField(12), '12');
assert.strictEqual(csvField(null), '');
assert.strictEqual(csvField(undefined), '');
assert.strictEqual(csvField(''), '');

assert.strictEqual(csvField('=1+1'), "'=1+1");
assert.strictEqual(csvField('+1'), "'+1");
assert.strictEqual(csvField('-2'), "'-2");
assert.strictEqual(csvField(-2), "'-2");
assert.strictEqual(csvField('@SUM(A1)'), "'@SUM(A1)");
assert.strictEqual(csvField('\t=cmd'), "'\t=cmd");
assert.strictEqual(csvField('\r=cmd'), '"\'\r=cmd"');
assert.strictEqual(csvField('=1,2'), '"\'=1,2"');
assert.strictEqual(csvField('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
assert.strictEqual(csvField('hello, world'), '"hello, world"');
assert.strictEqual(csvField('say "hi"'), '"say ""hi"""');

const rendered = renderCsv([
  ['variant_name', 'visitors'],
  ['=cmd|calc', -2],
  ['ok, fine', 3],
]);
assert.strictEqual(rendered.charCodeAt(0), 0xFEFF);
const body = rendered.slice(1);
assert.ok(body.startsWith('variant_name,visitors'));
assert.ok(body.includes("'=cmd|calc,'-2"));
assert.ok(body.includes('"ok, fine",3'));
assert.ok(!/(^|\n|,)=/.test(body));
assert.ok(!/(^|\n|,)\+/.test(body));
assert.ok(!/(^|\n|,)-/.test(body));
assert.ok(!/(^|\n|,)@/.test(body));

const plain = csvFilename('Homepage hero', 'results', day);
assert.deepStrictEqual(plain, {
  ascii: 'homepage-hero-results-2026-10-11.csv',
  utf8: 'homepage-hero-results-2026-10-11.csv',
});
assert.deepStrictEqual(csvFilename('Home - Winter Sale', 'progress', day), {
  ascii: 'home-winter-sale-progress-2026-10-11.csv',
  utf8: 'home-winter-sale-progress-2026-10-11.csv',
});
assert.deepStrictEqual(csvFilename('Blind sale', 'test-traffic', day), {
  ascii: 'blind-sale-test-traffic-2026-10-11.csv',
  utf8: 'blind-sale-test-traffic-2026-10-11.csv',
});

const cafe = csvFilename('Café Hero', 'results', day);
assert.strictEqual(cafe.ascii, 'cafe-hero-results-2026-10-11.csv');
assert.strictEqual(cafe.utf8, 'café-hero-results-2026-10-11.csv');
assert.ok(/^[\x20-\x7e]+$/.test(cafe.ascii));

const jp = csvFilename('日本語テスト', 'results', day);
assert.strictEqual(jp.ascii, 'experiment-results-2026-10-11.csv');
assert.strictEqual(jp.utf8, '日本語テスト-results-2026-10-11.csv');

const hostile = csvFilename('a\r\nX-Evil: 1/../../"quote"', 'results', day);
assert.ok(!hostile.ascii.includes('\n'));
assert.ok(!hostile.ascii.includes('\r'));
assert.ok(!hostile.utf8.includes('\n'));
assert.ok(!hostile.ascii.includes('"'));
assert.ok(!hostile.ascii.includes('/'));
assert.strictEqual(csvFilename('', 'results', day).ascii, 'experiment-results-2026-10-11.csv');
assert.strictEqual(csvFilename('..', 'nope', day).ascii, 'experiment-results-2026-10-11.csv');

const disposition = contentDispositionAttachment(cafe);
assert.ok(disposition.startsWith('attachment; '));
assert.ok(disposition.includes('filename="cafe-hero-results-2026-10-11.csv"'));
assert.ok(disposition.includes("filename*=UTF-8''caf%C3%A9-hero-results-2026-10-11.csv"));
assert.ok(!disposition.includes('\n'));
assert.ok(!disposition.includes('\r'));

const asciiDisposition = contentDispositionAttachment(plain);
assert.ok(asciiDisposition.includes('filename="homepage-hero-results-2026-10-11.csv"'));
assert.ok(asciiDisposition.includes("filename*=UTF-8''homepage-hero-results-2026-10-11.csv"));

const injected = contentDispositionAttachment({ ascii: 'ok.csv"; evil="x', utf8: 'ok\r\n.csv' });
assert.strictEqual(injected, 'attachment; filename="ok.csv-evil-x"; filename*=UTF-8\'\'ok.csv');
assert.ok(!injected.includes('\n'));
assert.ok(!injected.includes('evil='));

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(adminHtml.includes('function startCsvDownload(path)'));
assert.ok(adminHtml.includes('startCsvDownload(`/api/results/${expId}/export?test_only=1`)'));
assert.ok(adminHtml.includes('startCsvDownload(withTestQuery(`/api/results/${expId}/export`))'));
assert.ok(!adminHtml.includes('createObjectURL'));
assert.ok(!adminHtml.includes('revokeObjectURL'));
assert.ok(!adminHtml.includes('res.blob()'));
assert.ok(!adminHtml.includes('new Blob'));
assert.ok(!adminHtml.includes('data:text/csv'));
assert.ok(!/a\.download\s*=/.test(adminHtml));

const clientHtml = fs.readFileSync(path.join(__dirname, '../public/client.html'), 'utf8');
const clientRoute = fs.readFileSync(path.join(__dirname, '../src/routes/client.js'), 'utf8');
assert.ok(!clientHtml.includes('createObjectURL'));
assert.ok(!clientHtml.includes('text/csv'));
assert.ok(!clientRoute.includes('text/csv'));
assert.ok(!clientRoute.includes('sendCsv'));

function request(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

async function main() {
  const app = express();
  app.get('/file', (req, res) => {
    sendCsv(res, csvFilename('Café Hero', 'results', day), [
      ['variant_name', 'note'],
      ['=cmd|calc', 'ok'],
      ['plain', '+1+1'],
    ]);
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const res = await request(server, '/file');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    const header = res.headers['content-disposition'];
    assert.ok(header.includes('filename="cafe-hero-results-2026-10-11.csv"'));
    assert.ok(header.includes("filename*=UTF-8''caf%C3%A9-hero-results-2026-10-11.csv"));
    assert.strictEqual(res.body[0], 0xEF);
    assert.strictEqual(res.body[1], 0xBB);
    assert.strictEqual(res.body[2], 0xBF);
    const text = res.body.toString('utf8').slice(1);
    assert.ok(text.startsWith('variant_name,note'));
    assert.ok(text.includes("'=cmd|calc"));
    assert.ok(text.includes("'+1+1"));
    assert.ok(!text.includes(',=cmd'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('csv tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
