#!/usr/bin/env node
/**
 * Generates the checked-in sample dataset.
 *
 * It boots the mock VoteWA API in-process and runs the *real* ingest against
 * it, so the sample snapshot is produced by exactly the code path that runs in
 * production. That means the fixture cannot drift away from the ingest logic —
 * if normalization changes, the sample changes with it.
 *
 * The output is marked isSample:true and the app renders a prominent banner
 * for it. The numbers are invented; see scripts/mock-api.mjs.
 */
import { startMockApi } from './mock-api.mjs';
import { ingest } from './fetch-results.mjs';

const { port, close } = await startMockApi();
try {
  await ingest({
    electionId: '20260804',
    apiBase: `http://127.0.0.1:${port}/results/public/api`,
    isSample: true,
  });
  console.log('\nSample data generated. Run "npm run data:results" to replace it with live results.');
} finally {
  await close();
}
