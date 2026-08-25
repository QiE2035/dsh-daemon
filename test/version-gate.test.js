'use strict';
// Unit tests for the dsh --no-open version gate in lib/index.js, plus a
// source-level check that the generated watchdog template builds its launch
// args with the runtime gate instead of a hardcoded --no-open.
//
// The gate functions are module-scope so the watchdog inlines the exact same
// code via Function.prototype.toString(); testing them here therefore tests
// exactly what the generated watchdog embeds.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

process.env.DSH_DAEMON_TEST_HOOK = '1';
const root = path.join(__dirname, '..');
delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
const plugin = require(path.join(root, 'lib', 'index.js'));
const gate = plugin.__test;

assert.ok(gate, 'test hook not exported (DSH_DAEMON_TEST_HOOK=1 must be set)');
assert.strictEqual(gate.DSH_NO_OPEN_MIN, '0.1.0-rc.8');

// ---- versionGte: dsh --no-open is supported from 0.1.0-rc.8 --------------
const cases = [
  // [version, min, expected]
  ['0.1.0-rc.7', '0.1.0-rc.8', false], // the broken installed pair
  ['0.1.0-rc.8', '0.1.0-rc.8', true],
  ['0.1.0-rc.8', '0.1.0-rc.7', true],
  ['0.1.0-rc.9', '0.1.0-rc.8', true],
  ['0.1.1-rc.1', '0.1.0-rc.8', true],
  ['0.1.1-rc.2', '0.1.0-rc.8', true],
  ['0.1.0', '0.1.0-rc.8', true],       // release beats any prerelease
  ['0.1.0-rc.8', '0.1.0', false],      // prerelease < release
  ['0.1.1', '0.1.0-rc.8', true],
  ['0.2.0-rc.1', '0.1.0-rc.8', true],
  ['1.0.0', '0.1.0-rc.8', true],
  [null, '0.1.0-rc.8', false],         // unknown version → conservative: skip the flag
  ['junk', '0.1.0-rc.8', false],
  ['', '0.1.0-rc.8', false],
];
for (const [v, min, want] of cases) {
  assert.strictEqual(gate.versionGte(v, min), want,
    `versionGte(${JSON.stringify(v)}, ${JSON.stringify(min)})`);
}

// ---- dshNoOpenSupported: the same comparison against the embedded minimum --
assert.strictEqual(gate.dshNoOpenSupported('0.1.0-rc.7'), false);
assert.strictEqual(gate.dshNoOpenSupported('0.1.0-rc.8'), true);
assert.strictEqual(gate.dshNoOpenSupported('0.1.1-rc.2'), true);
assert.strictEqual(gate.dshNoOpenSupported(null), false);
assert.strictEqual(gate.dshNoOpenSupported(undefined), false);

// ---- watchdog template wiring (raw source assertions) ----------------------
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
assert.ok(src.includes("const args = [DSH_BIN, \\'web\\', \\'--port\\', String(PORT)];"),
  'template should build the launch args without --no-open');
assert.ok(src.includes("args.push(\\'--no-open\\')"),
  'template should append --no-open via a conditional push');
assert.ok(!src.includes("[DSH_BIN, \\'web\\', \\'--port\\', String(PORT), \\'--no-open\\']"),
  'template must not hardcode --no-open in the args array');
assert.ok(src.includes('versionGte.toString()'),
  'template should inline the gate functions from the module-scope originals');

console.log(`version-gate tests passed (${cases.length} versionGte cases + template wiring)`);
