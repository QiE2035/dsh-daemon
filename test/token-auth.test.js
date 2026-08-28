'use strict';
// Unit tests for the dsh web token-auth bootstrap (v0.1.19):
// - version gate: dsh >= 0.1.2-alpha.1 prints a per-process launch-token URL
//   (`dsh web: http://127.0.0.1:<port>/?token=...`); older dsh has no token
//   auth and must keep the current behaviour (no browser popup).
// - extractTokenUrl: the watchdog extracts that line from dsh-web.log.
// - template wiring: the generated watchdog embeds the gate, anchors the scan
//   to the current run (dsh-web.log is append-only on POSIX), never opens a
//   browser for pre-token dsh, persists the URL for manual access, and keeps
//   windowsHide: true on every child-process spawn.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

process.env.DSH_DAEMON_TEST_HOOK = '1';
const root = path.join(__dirname, '..');
delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
const plugin = require(path.join(root, 'lib', 'index.js'));
const gate = plugin.__test;

assert.ok(gate, 'test hook not exported (DSH_DAEMON_TEST_HOOK=1 must be set)');
assert.strictEqual(gate.DSH_TOKEN_AUTH_MIN, '0.1.2-alpha.1');

// ---- version gate: token auth exists from 0.1.2-alpha.1 -------------------
const MIN = gate.DSH_TOKEN_AUTH_MIN;
const cases = [
  ['0.1.1-rc.2', false],   // last pre-token release family
  ['0.1.2-alpha.0', false], // before the token commit
  ['0.1.2-alpha.1', true],  // first token-auth version
  ['0.1.2-alpha.2', true],
  ['0.1.2-rc.1', true],     // rc > alpha
  ['0.1.2', true],          // release beats any prerelease
  ['0.1.3', true],
  ['0.2.0-rc.1', true],
  ['1.0.0', true],
  [null, false],
  [undefined, false],
  ['junk', false],
  ['', false],
];
for (const [v, want] of cases) {
  assert.strictEqual(gate.versionGte(v, MIN), want,
    `versionGte(${JSON.stringify(v)}, ${MIN})`);
  assert.strictEqual(gate.dshTokenAuthSupported(v), want,
    `dshTokenAuthSupported(${JSON.stringify(v)})`);
}

// ---- extractTokenUrl ------------------------------------------------------
const tok = 'Qr_3ivtzDM61xc6X1wXEJ2J3L3TGFz8q2yfChiKc33g'; // real format: 43 chars, base64url
assert.strictEqual(
  gate.extractTokenUrl(`dsh web: http://127.0.0.1:3080/?token=${tok}`, 3080),
  `http://127.0.0.1:3080/?token=${tok}`);
// token containing dashes/underscores parses to the full token
assert.strictEqual(
  gate.extractTokenUrl('dsh web: http://127.0.0.1:8080/?token=abc-12_34DEF-', 8080),
  'http://127.0.0.1:8080/?token=abc-12_34DEF-');
// port mismatch: a URL line for another port must not be treated as ours
assert.strictEqual(gate.extractTokenUrl(`dsh web: http://127.0.0.1:9999/?token=${tok}`, 3080), null);
// old dsh prints a bare URL (no token): no match
assert.strictEqual(gate.extractTokenUrl('dsh web: http://127.0.0.1:3080/', 3080), null);
// trailing content after the token still yields the full token
assert.strictEqual(
  gate.extractTokenUrl(`dsh web: http://127.0.0.1:3080/?token=${tok} more`, 3080),
  `http://127.0.0.1:3080/?token=${tok}`);
// non-string / junk
assert.strictEqual(gate.extractTokenUrl(null, 3080), null);
assert.strictEqual(gate.extractTokenUrl(undefined, 3080), null);
assert.strictEqual(gate.extractTokenUrl('', 3080), null);
assert.strictEqual(gate.extractTokenUrl(42, 3080), null);

// ---- template wiring (raw source assertions) ------------------------------
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
const tplStart = src.indexOf('function watchdogScript');
const tplEnd = src.indexOf('function plistContent');
assert.ok(tplStart > 0 && tplEnd > tplStart, 'template region not found in lib/index.js');
const tpl = src.slice(tplStart, tplEnd);

// gate constants + functions are inlined into the generated watchdog
assert.ok(tpl.includes("'const DSH_TOKEN_AUTH_MIN = ' + j(DSH_TOKEN_AUTH_MIN)"),
  'template should embed DSH_TOKEN_AUTH_MIN');
assert.ok(tpl.includes('dshTokenAuthSupported.toString()'),
  'template should inline dshTokenAuthSupported');
assert.ok(tpl.includes('extractTokenUrl.toString()'),
  'template should inline extractTokenUrl');
// launch() anchors the scan before spawning and starts it after
assert.ok(tpl.includes('FS.statSync(WEB_LOG).size'),
  'launch should record the log size before spawning (run anchor)');
assert.ok(tpl.includes('seedWebAuth(ver, webLogBase);'),
  'launch should call seedWebAuth after spawning');
// seedWebAuth must skip pre-token dsh entirely (compat: old dsh never pops)
assert.ok(tpl.includes('!dshTokenAuthSupported(ver)'),
  'seedWebAuth must early-return for pre-token dsh');
// win32 truncation fallback (Start-Process overwrites the log)
assert.ok(tpl.includes('st.size < base ? 0 : base'),
  'poll must fall back to the whole file when the log was truncated (win32)');
// the token URL is persisted for headless/manual access, gated by OPEN_BROWSER
assert.ok(tpl.includes('WEB_AUTH_URL_FILE'),
  'template should persist the token URL to .web-auth-url');
assert.ok(tpl.includes('OPEN_BROWSER'),
  'template should gate browser opening on DSH_DAEMON_OPEN_BROWSER');
// openBrowser is wired for all three platforms (template strings escape \')
assert.ok(tpl.includes("\\'open\\'"), 'posix opener should be `open` on darwin');
assert.ok(tpl.includes("\\'xdg-open\\'"), 'posix opener should be `xdg-open` on linux');
assert.ok(tpl.includes("\\'Start-Process \\' + psq(url)"), 'win32 opener should use Start-Process');
// status surfaces the last token URL
assert.ok(src.includes('Web auth URL:'),
  'printStatus should surface the persisted auth URL');
// install/reinstall captures the DSH_DAEMON_OPEN_BROWSER switch
assert.ok(src.includes("envVal('DSH_DAEMON_OPEN_BROWSER', overrides)"),
  'updateConfig should capture DSH_DAEMON_OPEN_BROWSER');

// windowsHide on every spawn (shared invariant with version-gate.test.js):
const spawnCalls = tpl.match(/CP\.(?:spawn|execFileSync)\([^;]*?\)/g) || [];
assert.ok(spawnCalls.length >= 9, 'expected >=9 spawn/execFileSync calls in the template, got ' + spawnCalls.length);
for (const call of spawnCalls) {
  assert.ok(call.includes('windowsHide: true'),
    'spawn/execFileSync call must set windowsHide: true (black console boxes on Windows): ' + call);
}

console.log(`token-auth tests passed (${cases.length} version cases + extractTokenUrl + template wiring)`);
