import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { refresh } from './index.js';
import { startMockApi } from '../scripts/mock-api.mjs';

/** Minimal stand-in for a KV namespace binding. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => void store.set(key, value),
  };
}

let close;
let apiBase;

beforeAll(async () => {
  const mock = await startMockApi();
  close = mock.close;
  apiBase = `http://127.0.0.1:${mock.port}/results/public/api`;
});

afterAll(async () => {
  await close?.();
});

function env(kv = fakeKv()) {
  return { RESULTS: kv, ELECTION_ID: '20260804', VOTEWA_API_BASE: apiBase };
}

describe('refresh', () => {
  it('ingests an election into KV', async () => {
    const kv = fakeKv();
    const outcome = await refresh(env(kv));

    expect(outcome).toMatchObject({ ok: true, skipped: false, electionId: '20260804' });
    expect(outcome.races).toBe(8);
    expect(outcome.counties).toBe(14);

    const snapshot = JSON.parse(kv.store.get('results:snapshot:20260804'));
    expect(snapshot.races).toHaveLength(8);
    expect(Object.keys(snapshot.counties)).toContain('53033');

    const index = JSON.parse(kv.store.get('results:index'));
    expect(index.elections[0].electionId).toBe('20260804');
  });

  it('skips the county fan-out when upstream asOf has not moved', async () => {
    const kv = fakeKv();
    await refresh(env(kv));
    const first = kv.store.get('results:snapshot:20260804');

    const second = await refresh(env(kv));
    expect(second).toMatchObject({ ok: true, skipped: true, reason: 'unchanged' });
    // Untouched, so readers never see a needless rewrite.
    expect(kv.store.get('results:snapshot:20260804')).toBe(first);
  });

  it('re-ingests anyway when forced', async () => {
    const kv = fakeKv();
    await refresh(env(kv));
    const forced = await refresh(env(kv), { force: true });
    expect(forced.skipped).toBe(false);
  });

  it('writes the snapshot before the index that points at it', async () => {
    // A failure between the two writes must not leave the index advertising a
    // snapshot that is not there yet.
    const writes = [];
    const kv = fakeKv();
    const tracked = {
      get: kv.get,
      put: async (key, value) => {
        writes.push(key);
        return kv.put(key, value);
      },
    };
    await refresh(env(tracked));
    expect(writes.indexOf('results:snapshot:20260804')).toBeLessThan(
      writes.indexOf('results:index'),
    );
  });

  it('fails loudly when the election is not configured', async () => {
    await expect(refresh({ RESULTS: fakeKv() })).rejects.toThrow('ELECTION_ID');
  });

  it('reports the election as unofficial when upstream says so', async () => {
    const kv = fakeKv();
    await refresh(env(kv));
    const snapshot = JSON.parse(kv.store.get('results:snapshot:20260804'));
    expect(snapshot.isOfficial).toBe(false);
    expect(snapshot.isSample).toBe(false);
  });
});

describe('guard rails', () => {
  it('refuses to overwrite good results with an empty snapshot', async () => {
    const kv = fakeKv();
    await refresh(env(kv));
    const good = kv.store.get('results:snapshot:20260804');

    // Upstream that answers but matches no counties — a renamed slug field,
    // say. Overwriting with this would blank a working site.
    const emptyApi = {
      RESULTS: kv,
      ELECTION_ID: '20260804',
      VOTEWA_API_BASE: apiBase,
      VOTEWA_STATE_SLUG: 'nowhere',
    };
    await expect(refresh(emptyApi, { force: true })).rejects.toThrow();
    expect(kv.store.get('results:snapshot:20260804')).toBe(good);
  });

  it('reports ingest progress notes for diagnosis', async () => {
    const outcome = await refresh(env());
    expect(outcome.notes.some((n) => n.includes('participating counties'))).toBe(true);
    expect(outcome.electionName).toBeTruthy();
  });
});
