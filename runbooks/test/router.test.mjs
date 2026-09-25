import test from 'node:test';
import assert from 'node:assert';
import { selftest } from '../scripts/router.mjs';

// The selftest's own assertions are the regression net. This only runs it under node:test.
test('router selftest', async () => {
  assert.ok(await selftest());
});
