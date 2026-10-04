// HTTP/session boundaries are exercised with isolated ephemeral servers in
// server-v2.test.mjs. The old SIWC-gated JSON store was intentionally retired.
import test from 'node:test';import assert from 'node:assert/strict';import {ChatGPTProvider} from '../src/server/provider.mjs';
test('optional provider is unavailable without vendor/native assets; no import or key required',async()=>{const p=new ChatGPTProvider('/nonexistent-fixture-root','/nonexistent-fixture-data');assert.equal(p.available,false);assert.deepEqual(await p.status(),{available:false,connected:false,sharing:false});await assert.rejects(p.respond({}),{code:'provider_unavailable'});});
