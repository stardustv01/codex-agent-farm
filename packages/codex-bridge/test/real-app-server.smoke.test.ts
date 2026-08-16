import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AppServerClient,
  PHASE_A_BINARY_SHA256,
  PHASE_A_SCHEMA_HASHES,
  PHASE_A_USER_AGENT_PREFIX,
  generateStableSchemaBundle,
  spawnStdioAppServer,
} from '../src/index.js';

const enabled = process.env.AGENT_FARM_REAL_CODEX_SMOKE === '1';
const binaryPath = process.env.AGENT_FARM_CODEX_BIN ?? '/Users/praveengupta/.local/bin/codex';

test('real Codex app-server accepts the read-only Agent Farm adapter', {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const binarySha256 = createHash('sha256').update(await readFile(binaryPath)).digest('hex');
  assert.equal(binarySha256, PHASE_A_BINARY_SHA256, 'local Codex binary differs from retained Phase A evidence');

  const schema = generateStableSchemaBundle();
  const spawned = spawnStdioAppServer({ executable: binaryPath, args: ['app-server', '--stdio'] });
  const rejectedNotifications: string[] = [];
  const client = new AppServerClient(spawned.transport, {
    // Match the reviewed production transport bound. The live initialize
    // response can legitimately exceed the small fixture default as Codex's
    // registered tool and capability catalog evolves.
    maxLineBytes: 8 * 1_048_576,
    onRejectedNotification: (reason) => {
      if (rejectedNotifications.length < 20) rejectedNotifications.push(reason);
    },
  });

  try {
    const connection = await client.connect({
      binaryPath,
      binarySha256,
      schema,
      schemaHashes: PHASE_A_SCHEMA_HASHES,
      testedAdapters: [{
        adapterVersion: 'phase-a-codex-0.145.0-read-only-v1',
        binarySha256: PHASE_A_BINARY_SHA256,
        schemaBundleSha256: schema.sha256,
        schemaHashes: PHASE_A_SCHEMA_HASHES,
        userAgentPrefix: PHASE_A_USER_AGENT_PREFIX,
      }],
      initializeParams: {
        clientInfo: {
          name: 'agent-farm-real-smoke',
          title: 'Agent Farm Real Smoke',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      },
    });
    assert.equal(connection.gate.status, 'accepted');
    assert.match(connection.gate.fingerprint.reportedUserAgent, /^Codex Desktop\/0\.145\.0/);

    const threads = await client.listThreads({ limit: 2, useStateDbOnly: true });
    assert.ok(Array.isArray(threads.threads));
    const models = await client.listModels({ limit: 2 });
    assert.ok(Array.isArray(models.models));
    const firstThread = threads.threads[0];
    if (firstThread) {
      const read = await client.readThread({ threadId: firstThread.sourceThreadId, includeTurns: true });
      assert.equal(read.thread.sourceThreadId, firstThread.sourceThreadId);
    }
  } finally {
    await client.close();
    spawned.process.kill('SIGTERM');
  }
});
