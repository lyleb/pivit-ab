const assert = require('assert');
const { getSessionSecret, clearSessionSecretCache, DEV_FALLBACK, MIN_SECRET_LENGTH } = require('../src/session-secret');

function quiet() {
  return { error() {}, warn() {} };
}

function boot(env) {
  clearSessionSecretCache();
  const logs = [];
  let exited = null;
  let secret = null;
  try {
    secret = getSessionSecret({
      env,
      exit(code) {
        exited = code;
        throw new Error('exit');
      },
      log: {
        error(msg) { logs.push(['error', msg]); },
        warn(msg) { logs.push(['warn', msg]); },
      },
    });
  } catch (err) {
    if (err.message !== 'exit') throw err;
  }
  clearSessionSecretCache();
  return { secret, exited, logs };
}

assert.ok(DEV_FALLBACK.length >= MIN_SECRET_LENGTH);
assert.strictEqual(MIN_SECRET_LENGTH, 32);

const mixed = 'Ab3$!' + 'n'.repeat(27);
assert.strictEqual(mixed.length, 32);
assert.ok(/[^0-9a-fA-F]/.test(mixed));

const productionOk = boot({ NODE_ENV: 'production', SESSION_SECRET: mixed });
assert.strictEqual(productionOk.exited, null);
assert.strictEqual(productionOk.secret, mixed);
assert.strictEqual(productionOk.logs.length, 0);

const padded = boot({ NODE_ENV: 'production', SESSION_SECRET: `  ${mixed}\n` });
assert.strictEqual(padded.exited, null);
assert.strictEqual(padded.secret, mixed);

const missing = boot({ NODE_ENV: 'production' });
assert.strictEqual(missing.exited, 1);
assert.strictEqual(missing.secret, null);
assert.ok(missing.logs.some(([level, msg]) => level === 'error' && msg.includes('Refusing to start')));
assert.ok(missing.logs.every(([, msg]) => !msg.includes(mixed)));

const empty = boot({ NODE_ENV: 'production', SESSION_SECRET: '   ' });
assert.strictEqual(empty.exited, 1);

const short = boot({ NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(31) });
assert.strictEqual(short.exited, 1);
assert.ok(short.logs.some(([, msg]) => msg.includes('32')));

const hexNotRequired = boot({ NODE_ENV: 'production', SESSION_SECRET: '!'.repeat(32) });
assert.strictEqual(hexNotRequired.exited, null);
assert.strictEqual(hexNotRequired.secret, '!'.repeat(32));

const dev = boot({ NODE_ENV: 'development' });
assert.strictEqual(dev.exited, null);
assert.strictEqual(dev.secret, DEV_FALLBACK);
assert.ok(dev.logs.some(([level, msg]) => level === 'warn' && msg.includes('dev-only')));

const unset = boot({});
assert.strictEqual(unset.exited, null);
assert.strictEqual(unset.secret, DEV_FALLBACK);

console.log('session-secret tests passed');
