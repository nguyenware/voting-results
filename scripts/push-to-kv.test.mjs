import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { stripJsonComments, parseWranglerConfig, pushToKv } from './push-to-kv.mjs';
import { startMockApi } from './mock-api.mjs';

let close;
let apiBase;
let censusCounties;

beforeAll(async () => {
  const mock = await startMockApi();
  close = mock.close;
  apiBase = `http://127.0.0.1:${mock.port}/results/public/api`;
  censusCounties = JSON.parse(await readFile('public/data/geo/wa-county-index.json', 'utf8'));
});

afterAll(async () => {
  await close?.();
});

/** Stands in for the Cloudflare KV REST API. */
function fakeCloudflare() {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });

    if (url.includes('/bulk')) {
      for (const entry of JSON.parse(init.body)) store.set(entry.key, entry.value);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    const key = decodeURIComponent(url.split('/values/')[1]);
    if (!store.has(key)) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, text: async () => store.get(key) };
  };
  return { store, calls, fetchImpl };
}

const base = (cf) => ({
  accountId: 'acct',
  apiToken: 'token',
  namespaceId: 'ns',
  electionId: '20260804',
  censusCounties,
  apiBase,
  fetchImpl: cf.fetchImpl,
  log: () => {},
});

describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(JSON.parse(stripJsonComments('{ // hi\n "a": 1 /* there */ }'))).toEqual({ a: 1 });
  });

  it('leaves comment-like sequences inside strings alone', () => {
    const parsed = JSON.parse(stripJsonComments('{"url": "https://x.dev/a", "b": 2}'));
    expect(parsed.url).toBe('https://x.dev/a');
  });

  it('handles escaped quotes', () => {
    expect(JSON.parse(stripJsonComments('{"a": "say \\"hi\\" // no"}')).a).toBe('say "hi" // no');
  });
});

describe('parseWranglerConfig', () => {
  it('reads the real wrangler.jsonc in this repo', async () => {
    const config = parseWranglerConfig(await readFile('wrangler.jsonc', 'utf8'));
    expect(config.electionId).toMatch(/^\d{8}$/);
    expect(config.namespaceId).toBeTruthy();
    expect(config.namespaceId).not.toMatch(/^REPLACE_/);
  });

  it('rejects the placeholder namespace id with a clear message', () => {
    const text = `{"kv_namespaces":[{"binding":"RESULTS","id":"REPLACE_WITH_YOUR_KV_NAMESPACE_ID"}],"vars":{"ELECTION_ID":"20260804"}}`;
    expect(() => parseWranglerConfig(text)).toThrow(/placeholder/);
  });

  it('rejects a config with no RESULTS binding', () => {
    expect(() => parseWranglerConfig('{"vars":{"ELECTION_ID":"1"}}')).toThrow(/RESULTS/);
  });
});

describe('pushToKv', () => {
  it('ingests and writes snapshot, index, and asOf in one bulk call', async () => {
    const cf = fakeCloudflare();
    const outcome = await pushToKv(base(cf));

    expect(outcome).toMatchObject({ ok: true, skipped: false, counties: 14, races: 8 });
    expect([...cf.store.keys()].sort()).toEqual([
      'results:asof:20260804',
      'results:index',
      'results:snapshot:20260804',
    ]);
    expect(cf.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    const snapshot = JSON.parse(cf.store.get('results:snapshot:20260804'));
    expect(snapshot.races).toHaveLength(8);
    expect(snapshot.isSample).toBe(false);
  });

  it('skips writing entirely when asOf has not moved', async () => {
    const cf = fakeCloudflare();
    await pushToKv(base(cf));
    const writesAfterFirst = cf.calls.filter((c) => c.method === 'PUT').length;

    const second = await pushToKv(base(cf));
    expect(second).toMatchObject({ skipped: true });
    // No extra write: this is what keeps it inside the free KV allowance.
    expect(cf.calls.filter((c) => c.method === 'PUT')).toHaveLength(writesAfterFirst);
  });

  it('re-writes when forced', async () => {
    const cf = fakeCloudflare();
    await pushToKv(base(cf));
    const forced = await pushToKv({ ...base(cf), force: true });
    expect(forced.skipped).toBe(false);
    expect(cf.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('refuses to overwrite good data with an empty snapshot', async () => {
    const cf = fakeCloudflare();
    await pushToKv(base(cf));
    const good = cf.store.get('results:snapshot:20260804');

    await expect(
      pushToKv({ ...base(cf), force: true, censusCounties: [] }),
    ).rejects.toThrow(/no matchable counties/);
    expect(cf.store.get('results:snapshot:20260804')).toBe(good);
  });

  it('fails clearly when credentials are missing', async () => {
    const cf = fakeCloudflare();
    await expect(pushToKv({ ...base(cf), accountId: '' })).rejects.toThrow(/ACCOUNT_ID/);
    await expect(pushToKv({ ...base(cf), apiToken: '' })).rejects.toThrow(/API_TOKEN/);
  });

  it('surfaces a KV write failure rather than reporting success', async () => {
    const cf = fakeCloudflare();
    const failing = {
      ...base(cf),
      fetchImpl: async (url, init) =>
        url.includes('/bulk')
          ? { ok: false, status: 403, text: async () => 'Authentication error' }
          : cf.fetchImpl(url, init),
    };
    await expect(pushToKv(failing)).rejects.toThrow(/KV write failed: HTTP 403/);
  });
});
