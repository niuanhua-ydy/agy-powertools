import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  antigravityToolsDir,
  buildCredentialPayload,
  loadAntigravityToolsEntries,
  scanAntigravityTools
} from '../lib/account-import.mjs';
import { createCredentialVault, extractCredentialEmail, GO_KEYRING_BASE64_PREFIX } from '../lib/credential-vault.mjs';
import { createAccountsStore } from '../lib/accounts.mjs';

const jwt = claims => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

function toolsRecord(id, email, extra = {}) {
  const { token = {}, ...rest } = extra;
  return {
    id,
    email,
    name: `Name ${id}`,
    token: {
      access_token: `ACCESS-${id}`,
      refresh_token: `REFRESH-${id}`,
      expires_in: 3599,
      expiry_timestamp: 1_800_000_000,
      token_type: 'Bearer',
      email,
      is_gcp_tos: false,
      ...token
    },
    quota: { subscription_tier: 'PRO', raw_tier: 'g1-pro-tier', is_forbidden: false },
    disabled: false,
    banned: false,
    validation_blocked: false,
    last_used: 1_795_000_000,
    ...rest
  };
}

function makeToolsDir(records, { order } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-tools-import-'));
  mkdirSync(join(dir, 'accounts'));
  for (const record of records) writeFileSync(join(dir, 'accounts', `${record.id}.json`), JSON.stringify(record));
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
    version: '2.0',
    accounts: (order || records.map(r => r.id)).map(id => ({ id }))
  }));
  return dir;
}

function createFakeVault({ liveEmail = '', failFor = '' } = {}) {
  const slots = new Map();
  const info = key => {
    if (!slots.has(key)) return { exists: false, hash: '' };
    const value = slots.get(key);
    const email = extractCredentialEmail(value);
    return { exists: true, hash: `H${value.length}`, ...(email ? { email } : {}) };
  };
  if (liveEmail) slots.set('active', JSON.stringify({ token: { refresh_token: 'live' }, id_token_email: liveEmail }));
  return {
    supported: true,
    slots,
    saveActiveTo(id) { slots.set(id, slots.get('active')); return { ok: true, ...info(id) }; },
    restoreToActive(id) { slots.set('active', slots.get(id)); return { ok: true, ...info('active') }; },
    hasSaved: id => slots.has(id),
    inspectSaved: id => info(id),
    inspectActive: () => info('active'),
    removeSaved(id) { slots.delete(id); return { ok: true }; },
    importSaved(id, payload) {
      if (failFor && payload.includes(failFor)) return { ok: false, error: 'keychain locked' };
      slots.set(id, payload);
      return { ok: true, ...info(id) };
    }
  };
}

test('Antigravity Tools scan lists accounts in index order and never exposes token material', () => {
  const dir = makeToolsDir([
    toolsRecord('a', 'alpha@example.com', { token: { id_token: jwt({ email: 'Alpha@Example.com' }) } }),
    toolsRecord('b', 'beta@example.com', { banned: true }),
    toolsRecord('c', 'gamma@example.com', { token: { refresh_token: '' } }),
    toolsRecord('d', 'delta@example.com', { token: { id_token: jwt({ email: 'someone-else@example.com' }) } }),
    toolsRecord('e', 'epsilon@example.com', { token: { email: 'other@example.com' } })
  ], { order: ['b', 'a', 'c', 'd', 'e'] });
  try {
    // A symlinked record and a non-object file must both be ignored.
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify(toolsRecord('z', 'linked@example.com')));
    symlinkSync(outside, join(dir, 'accounts', 'z.json'));
    writeFileSync(join(dir, 'accounts', 'junk.json'), '["not","an","account"]');
    writeFileSync(join(dir, 'accounts', 'broken.json'), '{not json');

    const scan = scanAntigravityTools(dir);
    assert.equal(scan.source, 'antigravity-tools');
    assert.equal(scan.found, true);
    assert.deepEqual(scan.accounts.map(a => a.email), ['beta@example.com', 'alpha@example.com', 'gamma@example.com', 'delta@example.com', 'epsilon@example.com']);
    const byEmail = Object.fromEntries(scan.accounts.map(a => [a.email, a]));
    assert.equal(byEmail['beta@example.com'].banned, true);
    assert.equal(byEmail['alpha@example.com'].emailMismatch, false);
    assert.equal(byEmail['gamma@example.com'].hasCredential, false);
    assert.equal(byEmail['delta@example.com'].emailMismatch, true);
    assert.equal(byEmail['epsilon@example.com'].emailMismatch, true);
    assert.deepEqual(byEmail['alpha@example.com'].tier, { id: 'g1-pro-tier', name: 'Google AI Pro' });
    assert.doesNotMatch(JSON.stringify(scan), /ACCESS-|REFRESH-|\.sig/);

    // Only selected, complete and consistent records become import entries.
    const entries = loadAntigravityToolsEntries(dir, ['ALPHA@example.com', 'gamma@example.com', 'delta@example.com', 'epsilon@example.com', 'linked@example.com'], { now: 1_795_000_000_000 });
    assert.deepEqual(entries.map(e => e.email), ['alpha@example.com']);
    const payload = JSON.parse(entries[0].payload);
    assert.deepEqual(payload, {
      token: {
        access_token: 'ACCESS-a',
        token_type: 'Bearer',
        refresh_token: 'REFRESH-a',
        expiry: '2027-01-15T08:00:00.000Z',
        expires_in: 3599
      },
      auth_method: 'consumer',
      id_token_email: 'alpha@example.com'
    });
    // Reading never alters the source directory.
    assert.deepEqual(readdirSync(join(dir, 'accounts')).sort(), ['a.json', 'b.json', 'broken.json', 'c.json', 'd.json', 'e.json', 'junk.json', 'z.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const missing = scanAntigravityTools(join(tmpdir(), 'agy-tools-import-does-not-exist'));
  assert.deepEqual(missing, { source: 'antigravity-tools', found: false, accounts: [] });
  // The source directory is fixed: environment overrides must not redirect the importer.
  assert.equal(antigravityToolsDir({ home: '/home/u', env: { ABV_DATA_DIR: '/tmp/evil' } }), join('/home/u', '.antigravity_tools'));
});

test('buildCredentialPayload validates input and marks tokens without expiry as already expired', () => {
  assert.throws(() => buildCredentialPayload({ email: 'not-an-email', refreshToken: 'r' }));
  assert.throws(() => buildCredentialPayload({ email: 'a@example.com', refreshToken: '' }));
  const payload = JSON.parse(buildCredentialPayload({ email: 'A@Example.com', refreshToken: 'r' }, { now: 1_795_000_000_000 }));
  assert.equal(payload.id_token_email, 'a@example.com');
  assert.equal(payload.token.access_token, '');
  assert.equal(Date.parse(payload.token.expiry), 1_795_000_000_000 - 60_000);
});

test('credential email extraction understands the macOS go-keyring envelope', () => {
  const payload = JSON.stringify({ token: { refresh_token: 'r' }, auth_method: 'consumer', id_token_email: 'Mac@Example.com' });
  const wrapped = `${GO_KEYRING_BASE64_PREFIX}${Buffer.from(payload).toString('base64')}`;
  assert.equal(extractCredentialEmail(wrapped), 'mac@example.com');
  assert.equal(extractCredentialEmail(Buffer.from(`${wrapped}\n`)), 'mac@example.com');
  assert.equal(extractCredentialEmail(`${GO_KEYRING_BASE64_PREFIX}not-json`), '');

  // With the envelope decoded, a mismatched backup is refused instead of silently overwriting another slot.
  const ops = [];
  const vault = createCredentialVault({
    platform: 'darwin',
    runSpawn(_cmd, args) {
      ops.push(args[0]);
      if (args.includes('-w')) return { status: 0, stdout: Buffer.from(`${wrapped}\n`) };
      return { status: 0, stdout: '' };
    }
  });
  assert.equal(vault.inspectActive().email, 'mac@example.com');
  const blocked = vault.saveActiveTo('acct-other', { expectedEmail: 'other@example.com' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.mismatch, true);
  assert.equal(ops.includes('-i'), false);
});

test('vault.importSaved stores payloads per platform without leaking secrets into argv', () => {
  const payload = JSON.stringify({ token: { access_token: 'AT-SECRET', refresh_token: 'RT-SECRET' }, auth_method: 'consumer', id_token_email: 'imp@example.com' });
  const expectedMacSecret = `${GO_KEYRING_BASE64_PREFIX}${Buffer.from(payload).toString('base64')}`;

  const macCalls = [];
  const mac = createCredentialVault({
    platform: 'darwin',
    runSpawn(cmd, args, opts) { macCalls.push({ cmd, args, input: String(opts?.input || '') }); return { status: 0, stdout: '' }; }
  });
  const macRes = mac.importSaved('acct-imp', payload);
  assert.equal(macRes.ok, true);
  assert.equal(macRes.email, 'imp@example.com');
  assert.match(macRes.hash, /^[0-9A-F]{12}$/);
  assert.equal(macCalls.length, 1);
  assert.deepEqual([macCalls[0].cmd, macCalls[0].args], ['/usr/bin/security', ['-i']]);
  const hex = macCalls[0].input.match(/^add-generic-password -U -s "agy-powertools-account" -a "acct-imp" -X ([0-9a-f]+)\n$/);
  assert.ok(hex, 'secret must be piped as hex over stdin');
  assert.equal(Buffer.from(hex[1], 'hex').toString('utf8'), expectedMacSecret);

  const linuxCalls = [];
  const linux = createCredentialVault({
    platform: 'linux',
    wsl: false,
    runSpawn(cmd, args, opts) { linuxCalls.push({ cmd, args, input: Buffer.from(opts?.input || '').toString('utf8') }); return { status: 0, stdout: '' }; }
  });
  assert.equal(linux.importSaved('acct-imp', payload).ok, true);
  assert.deepEqual(linuxCalls[0].args, ['store', '--label=Agy Powertools', 'service', 'agy-powertools-account', 'username', 'acct-imp']);
  assert.equal(linuxCalls[0].input, payload);

  const winCalls = [];
  const win = createCredentialVault({
    platform: 'win32',
    env: {},
    runSpawn(cmd, args, opts) {
      winCalls.push({ cmd, args, env: opts.env, input: opts.input });
      return { status: 0, stdout: '{"ok":true,"bytes":99,"hash":"AABBCCDDEEFF"}\n', stderr: '' };
    }
  });
  const winRes = win.importSaved('acct-imp', payload);
  assert.deepEqual(winRes, { ok: true, bytes: 99, hash: 'AABBCCDDEEFF', email: 'imp@example.com' });
  assert.equal(winCalls[0].env.AGY_CRED_OP, 'write');
  assert.equal(winCalls[0].env.AGY_CRED_DST, 'agy-powertools:account:acct-imp');
  assert.equal(Buffer.from(winCalls[0].input, 'base64').toString('utf8'), payload);

  for (const call of [...macCalls, ...linuxCalls, ...winCalls]) {
    assert.doesNotMatch(JSON.stringify(call.args), /SECRET/);
    assert.doesNotMatch(JSON.stringify(call.env || {}), /SECRET/);
  }

  // Refused: WSL (different on-disk envelope), payloads without an owner email, and invalid account ids.
  const wsl = createCredentialVault({ platform: 'linux', wsl: true, wslDistro: 'Ubuntu', runSpawn() { throw new Error('must not spawn'); } });
  assert.equal(wsl.importSaved('acct-imp', payload).ok, false);
  const spawned = [];
  const strict = createCredentialVault({ platform: 'darwin', runSpawn(...a) { spawned.push(a); return { status: 0, stdout: '' }; } });
  assert.equal(strict.importSaved('acct-imp', 'opaque-token').ok, false);
  assert.equal(strict.importSaved('acct-imp', JSON.stringify({ token: { refresh_token: 'r' } })).ok, false);
  assert.throws(() => strict.importSaved('bad id;rm', payload));
  assert.equal(spawned.length, 0);
});

test('accounts.importAccounts only fills empty slots and reports per-account outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-accounts-import-'));
  const payloadFor = email => buildCredentialPayload({ email, accessToken: `at-${email}`, refreshToken: `rt-${email}` }, { now: 1_795_000_000_000 });
  try {
    const vault = createFakeVault({ liveEmail: 'live@example.com' });
    const store = createAccountsStore(dir, { now: () => 1_795_000_000_000, vault, appStoragePath: '' });

    // Nothing may be imported before the active account is known.
    assert.throws(() => store.importAccounts([{ email: 'new@example.com', payload: payloadFor('new@example.com') }]), /同步完成/);
    assert.equal(store.importStatus([{ email: 'new@example.com', hasCredential: true }]).ready, false);

    store.syncActive({ email: 'live@example.com', name: 'Live' });
    const activeId = store.list().activeId;
    const liveSecret = vault.slots.get(activeId);

    const status = store.importStatus([
      { email: 'Live@Example.com', hasCredential: true },
      { email: 'new@example.com', hasCredential: true },
      { email: 'new@example.com', hasCredential: true },
      { email: 'empty@example.com', hasCredential: false },
      { email: 'odd@example.com', hasCredential: true, emailMismatch: true },
      { email: 'not-an-email' }
    ]);
    assert.equal(status.ready, true);
    assert.deepEqual(status.accounts.map(a => [a.email, a.status]), [
      ['live@example.com', 'active'],
      ['new@example.com', 'new'],
      ['empty@example.com', 'no-credential'],
      ['odd@example.com', 'mismatch']
    ]);

    const res = store.importAccounts([
      { email: 'live@example.com', payload: payloadFor('live@example.com') },
      { email: 'new@example.com', name: 'New Person', tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, isGcpTos: true, payload: payloadFor('new@example.com') },
      { email: 'second@example.com', payload: payloadFor('second@example.com') },
      { email: 'nopayload@example.com' },
      { email: 'bad' }
    ]);
    assert.deepEqual(res.skipped, [{ email: 'live@example.com', reason: 'active' }]);
    assert.deepEqual(res.failed, [{ email: 'nopayload@example.com', error: '缺少可用凭据' }]);
    assert.deepEqual(res.imported.map(i => i.email), ['new@example.com', 'second@example.com']);
    assert.equal(res.activeId, activeId);
    assert.doesNotMatch(JSON.stringify(res), /rt-|at-/, 'replies must never carry token material');

    // The live credential and its backup are untouched.
    assert.equal(vault.slots.get(activeId), liveSecret);
    assert.equal(JSON.parse(vault.slots.get('active')).id_token_email, 'live@example.com');

    const saved = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(saved), /rt-|at-/, 'accounts.json must never carry token material');
    const added = saved.accounts.find(a => a.email === 'new@example.com');
    assert.equal(added.name, 'New Person');
    assert.equal(added.hasCredential, true);
    assert.equal(added.onboardingAccepted, false);
    assert.equal(added.isGcpTos, true);
    assert.deepEqual(added.tier, { id: 'g1-pro-tier', name: 'Google AI Pro' });
    assert.ok(added.credHash);
    assert.equal(JSON.parse(vault.slots.get(added.id)).token.refresh_token, 'rt-new@example.com');
    assert.equal(saved.activeId, activeId);

    // A second run skips accounts that already hold a credential instead of overwriting them.
    const before = vault.slots.get(added.id);
    const again = store.importAccounts([{ email: 'new@example.com', payload: payloadFor('new@example.com').replace('rt-new', 'rt-REPLACED') }]);
    assert.deepEqual(again.skipped, [{ email: 'new@example.com', reason: 'exists' }]);
    assert.deepEqual(again.imported, []);
    assert.equal(vault.slots.get(added.id), before);
    assert.equal(store.importStatus([{ email: 'new@example.com', hasCredential: true }]).accounts[0].status, 'exists');

    // An imported account can be switched to through the normal, guarded switch path.
    const switched = store.switchAccount(added.id, { triggerRelaunch: false });
    assert.equal(switched.ok, true);
    assert.equal(JSON.parse(vault.slots.get('active')).id_token_email, 'new@example.com');
    assert.equal(vault.slots.get(activeId), liveSecret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accounts.importAccounts fails closed when the vault write fails or stores the wrong owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-accounts-import-'));
  const payloadFor = email => buildCredentialPayload({ email, refreshToken: `rt-${email}` }, { now: 1_795_000_000_000 });
  try {
    const vault = createFakeVault({ liveEmail: 'live@example.com', failFor: 'locked@example.com' });
    const store = createAccountsStore(dir, { now: () => 1_795_000_000_000, vault, appStoragePath: '' });
    store.syncActive({ email: 'live@example.com' });

    // The stored payload belongs to someone else than the entry claims: slot is removed, account not added.
    const res = store.importAccounts([
      { email: 'locked@example.com', payload: payloadFor('locked@example.com') },
      { email: 'claimed@example.com', payload: payloadFor('actual@example.com') }
    ]);
    assert.deepEqual(res.imported, []);
    assert.deepEqual(res.failed.map(f => f.email), ['locked@example.com', 'claimed@example.com']);
    assert.equal(res.failed[0].error, 'keychain locked');
    assert.deepEqual(res.accounts.map(a => a.email), ['live@example.com']);
    assert.deepEqual([...vault.slots.keys()].sort(), ['active', store.list().activeId].sort());

    const noImport = createAccountsStore(dir, { vault: { ...vault, importSaved: undefined }, appStoragePath: '' });
    assert.throws(() => noImport.importAccounts([{ email: 'x@example.com', payload: payloadFor('x@example.com') }]), /不支持导入/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
