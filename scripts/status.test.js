const assert = require('assert');
const { normaliseStatusChange } = require('../src/experiment-status');

const paused = normaliseStatusChange('running', { status: 'paused' });
assert.strictEqual(paused.ok, true);
assert.strictEqual(paused.status, 'paused');
assert.strictEqual(paused.unchanged, false);

const started = normaliseStatusChange('paused', { status: 'running' });
assert.strictEqual(started.ok, true);
assert.strictEqual(started.status, 'running');

const same = normaliseStatusChange('running', { status: 'running' });
assert.strictEqual(same.ok, true);
assert.strictEqual(same.unchanged, true);

const slipped = normaliseStatusChange('running', { status: 'archived' });
assert.strictEqual(slipped.ok, false);
assert.strictEqual(slipped.statusCode, 400);

const flagged = normaliseStatusChange('running', { status: 'archived', archive: 'true' });
assert.strictEqual(flagged.ok, false);

const explicit = normaliseStatusChange('paused', { status: 'archived', archive: true });
assert.strictEqual(explicit.ok, true);
assert.strictEqual(explicit.status, 'archived');

const pauseWithFlag = normaliseStatusChange('running', { status: 'paused', archive: true });
assert.strictEqual(pauseWithFlag.ok, true);
assert.strictEqual(pauseWithFlag.status, 'paused');

const missing = normaliseStatusChange('draft', {});
assert.strictEqual(missing.ok, false);

const junk = normaliseStatusChange('draft', { status: 'live' });
assert.strictEqual(junk.ok, false);

console.log('status tests passed');
