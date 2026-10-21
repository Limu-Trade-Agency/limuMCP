import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerRemoteTools } from '../src/remote-tools.js';

const tools = new Map();
registerRemoteTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } });
const tool = tools.get('limu_update_cargo_status');
assert.ok(tool);
const schema = z.object(tool.definition.inputSchema);
const base = { cargoId: 91, expectedShipmentId: 213, expectedStatus: 'Warehouse Check', status: 'Collected', reason: 'Confirmed collection list' };
assert.equal(schema.parse(base).dryRun, true);
assert.equal(schema.parse(base).confirm, false);
for (const invalid of [{ cargoId: 0 }, { expectedShipmentId: 0 }, { expectedStatus: '' }, { status: 'Unknown' }, { status: 'Created' }, { reason: '' }, { confirm: 'true' }, { dryRun: null }, { previewToken: 'bad' }]) {
  assert.equal(schema.safeParse({ ...base, ...invalid }).success, false);
}
const originalFetch = globalThis.fetch;
const requests = [];
let errorStatus = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://portal.limu.co.mw/Api/v1/cargo/update-status.php');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(options.body);
  requests.push(body);
  if (errorStatus) return Response.json({ message: errorStatus === 403 ? 'Permission denied.' : 'The status preview is stale.' }, { status: errorStatus });
  return Response.json(body.dryRun || !body.confirm
    ? { eligible: true, previewToken: 'a'.repeat(64) }
    : { cargoStatus: 'Collected', idempotentReplay: requests.length === 4 });
};
try {
  const extra = { authInfo: { token: 'test-token' } };
  await assert.rejects(() => tool.handler(base), /OAuth bearer token/);
  await assert.rejects(() => tool.handler({ ...base, dryRun: false, confirm: true }, extra), /previewToken and idempotencyKey/);
  assert.equal(requests.length, 0);
  const preview = JSON.parse((await tool.handler(base, extra)).content[0].text);
  assert.deepEqual(requests[0], { ...base, dryRun: true, confirm: false });
  await tool.handler({ ...base, dryRun: false }, extra);
  assert.equal(requests[1].confirm, false);
  const confirmed = { ...base, dryRun: false, confirm: true, previewToken: preview.previewToken, idempotencyKey: 'status-91-213' };
  assert.equal(JSON.parse((await tool.handler(confirmed, extra)).content[0].text).cargoStatus, 'Collected');
  assert.equal(JSON.parse((await tool.handler(confirmed, extra)).content[0].text).idempotentReplay, true);
  assert.deepEqual(requests[2], requests[3]);
  for (const status of [409, 403]) {
    errorStatus = status;
    await assert.rejects(() => tool.handler(confirmed, extra), status === 409 ? /preview is stale/ : /Permission denied/);
  }
} finally { globalThis.fetch = originalFetch; }
console.log('Cargo status registration, validation, preview defaults, authorization, retries and portal errors passed.');
