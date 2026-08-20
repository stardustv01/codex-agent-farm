import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdapterQuarantinedError,
  AppServerClient,
  BridgeProtocolError,
  InMemoryStdioTransport,
  OutboundMethodDeniedError,
  canonicalObservationKey,
  collectPages,
  compactChatTitle,
  evaluateAdapterGate,
  generateStableSchemaBundle,
  minimizeFinalSummary,
  minimizeItem,
  minimizeThread,
  minimizeThreadRead,
  normalizeNotification,
  reconcileSnapshot,
  ObservationLedger,
  PHASE_A_SCHEMA_HASHES,
  type NormalizedEvent,
} from '../src/index.js';

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    version: 1,
    kind: 'turn.completed',
    sourceThreadId: 'thread-1',
    sourceTurnId: 'turn-1',
    status: 'completed',
    ...overrides,
  };
}

test('denies every mutation/control method before serialization', async () => {
  const transport = new InMemoryStdioTransport();
  const client = new AppServerClient(transport);
  const denied = [
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/archive',
    'thread/delete',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'command/exec',
    'process/spawn',
    'fs/write',
    'config/write',
    'account/mutate',
    'remote/control',
  ];
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const method of denied) {
    await assert.rejects(() => client.call(method, cyclic), (error: unknown) => error instanceof OutboundMethodDeniedError);
  }
  assert.deepEqual(transport.sentLines, []);
  await client.close();
});

test('allowed calls serialize only after param validation and resolve correlated response', async () => {
  const transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id: number; method: string };
      await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [], method: request.method } }));
    },
  });
  const client = new AppServerClient(transport);
  const response = await client.call<{ data: readonly unknown[] }>('thread/list', { useStateDbOnly: true, limit: 10 });
  assert.deepEqual(response.data, []);
  assert.equal('jsonrpc' in JSON.parse(transport.sentLines[0] ?? '{}'), false);
  assert.match(transport.sentLines[0] ?? '', /"method":"thread\/list"/);
  await assert.rejects(() => client.call('thread/list', { path: '/Users/private' }), /Outbound params/);
  await assert.rejects(() => client.call('thread/read', { threadId: 'thread-1', cursor: 'cursor' }), /Outbound params/);
  await assert.rejects(() => client.call('thread/read', { threadId: 'thread-1', limit: 2 }), /Outbound params/);
  await client.close();
});

test('thread/list accepts only the bounded official sourceKinds enum', async () => {
  const transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id: number };
      await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [] } }));
    },
  });
  const client = new AppServerClient(transport);
  const sourceKinds = [
    'cli',
    'vscode',
    'exec',
    'appServer',
    'subAgent',
    'subAgentReview',
    'subAgentCompact',
    'subAgentThreadSpawn',
    'subAgentOther',
    'unknown',
  ];
  await client.call('thread/list', { useStateDbOnly: false, sourceKinds });
  assert.match(transport.sentLines[0] ?? '', /"sourceKinds":\["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"\]/);
  await assert.rejects(() => client.call('thread/list', { sourceKinds: ['futureKind'] }), /Outbound params/);
  await assert.rejects(() => client.call('thread/list', { sourceKinds: ['cli', 'cli'] }), /Outbound params/);
  await assert.rejects(() => client.call('thread/list', { sourceKinds: new Array(11).fill('cli') }), /Outbound params/);
  await assert.rejects(() => client.call('thread/list', { archived: 'yes' }), /Outbound params/);
  await client.close();
});

test('thread/list rejects unsupported sort fields before serialization', async () => {
  const transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id: number };
      await transport.pushLine(JSON.stringify({ id: request.id, result: { data: [] } }));
    },
  });
  const client = new AppServerClient(transport);
  await assert.rejects(() => client.call('thread/list', { sortKey: 'recency_at' }), /Outbound params/);
  await assert.rejects(() => client.call('thread/list', { sortDirection: 'desc' }), /Outbound params/);
  assert.equal(transport.sentLines.length, 0);
  await client.close();
});

test('minimizer exports allowed thread fields and drops prompts, commands, paths, and unknowns', () => {
  const thread = minimizeThread({
    id: 'thread-1',
    sessionId: 'session-1',
    parentThreadId: 'parent-1',
    modelProvider: 'openai',
    status: 'active',
    cliVersion: '0.145.0',
    agentNickname: 'Builder',
    agentRole: 'worker',
    title: 'Improve hierarchy UI',
    cwd: '/Users/navin/private',
    prompt: 'do not export',
    reasoning: 'do not export',
    command: 'rm -rf /',
    unknown: { secret: 'nope' },
  });
  assert.deepEqual(thread, {
    sourceThreadId: 'thread-1',
    sessionId: 'session-1',
    parentThreadId: 'parent-1',
    modelProvider: 'openai',
    status: 'active',
    cliVersion: '0.145.0',
    agentNickname: 'Builder',
    agentRole: 'worker',
    chatTitle: 'Improve hierarchy UI',
    workspaceName: 'private',
  });
  const read = minimizeThreadRead({
    thread: { ...thread, turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'item-1', type: 'reasoning', text: 'private' }] }] },
  });
  assert.equal(read?.turns[0]?.items?.[0]?.kind, 'unknown');
  assert.equal('text' in (read?.turns[0]?.items?.[0] ?? {}), false);
});

test('minimizer falls through a nullable app-server title to the public name', () => {
  assert.deepEqual(minimizeThread({
    id: 'thread-current-title-shape',
    title: null,
    name: 'Investigate Codex review API costs',
    cwd: null,
    workingDirectory: '/Users/navin/Agent-farm V1',
    source: 'vscode',
    status: { type: 'idle' },
  }), {
    sourceThreadId: 'thread-current-title-shape',
    status: 'idle',
    chatTitle: 'Investigate Codex review API costs',
    workspaceName: 'Agent-farm V1',
    sourceKind: 'ide',
  });
});

test('minimizer compacts long Codex-generated titles to a bounded first-line label', () => {
  const title = `Review Chai Studio release readiness ${'with evidence '.repeat(20)}\nfull first-message body`;
  const compact = compactChatTitle(title);
  assert.ok((compact?.length ?? 0) <= 96);
  assert.ok((compact?.length ?? 0) >= 90);
  assert.match(compact ?? '', /^Review Chai Studio release readiness/);
  assert.match(compact ?? '', /\.\.\.$/);
  assert.equal(compactChatTitle('api_key=secret'), undefined);
  assert.equal(minimizeThread({ id: 'thread-long-title', title })?.chatTitle, compact);
});

test('minimizer skips a private session-path line before the human title', () => {
  const title = '/Users/navin/.codex/sessions/2026\nplease provide the total token cost';
  assert.equal(compactChatTitle(title), 'please provide the total token cost');
  assert.equal(minimizeThread({ id: 'thread-path-prefixed-title', title })?.chatTitle, 'please provide the total token cost');
});

test('minimizer classifies nested source markers even when sourceKind is null', () => {
  assert.equal(minimizeThread({
    id: 'thread-guardian-null-kind',
    sourceKind: null,
    source: { subAgent: { other: 'guardian' } },
  })?.sourceKind, 'subagent');
});

test('minimizer normalizes bounded Unix seconds, milliseconds, and date strings', () => {
  assert.deepEqual(minimizeThread({
    id: 'thread-time',
    createdAt: 1_767_323_045,
    updatedAt: 1_770_091_506_000,
    recencyAt: '2026-03-04T05:06:07.000Z',
  }), {
    sourceThreadId: 'thread-time',
    status: 'unknown',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-02-03T04:05:06.000Z',
    recencyAt: '2026-03-04T05:06:07.000Z',
  });
  assert.deepEqual(minimizeThread({
    id: 'thread-invalid-time',
    createdAt: 0,
    updatedAt: -1,
    recencyAt: '1999-12-31T23:59:59.000Z',
  }), {
    sourceThreadId: 'thread-invalid-time',
    status: 'unknown',
  });
});

test('minimizer maps official object-shaped thread statuses without inventing completion', () => {
  assert.equal(minimizeThread({ id: 'thread-idle', status: { type: 'idle' } })?.status, 'idle');
  assert.equal(minimizeThread({ id: 'thread-active', status: { type: 'active' } })?.status, 'active');
  assert.equal(minimizeThread({ id: 'thread-error', status: { type: 'systemError', message: 'private' } })?.status, 'failed');
  assert.equal(minimizeThread({ id: 'thread-not-loaded', status: { type: 'notLoaded' } })?.status, 'unknown');
  assert.equal(minimizeThread({ id: 'thread-complete-object', status: { type: 'completed' } })?.status, 'unknown');
  assert.equal(minimizeThread({ id: 'thread-complete-string', status: 'completed' })?.status, 'completed');
});

test('minimizer accepts official nullable lineage fields while rejecting a null source id', () => {
  const root = minimizeThread({
    id: 'thread-root',
    parentThreadId: null,
    forkedFromId: null,
    status: { type: 'notLoaded' },
    source: { subAgent: { thread_spawn: { parent_thread_id: null, agent_path: null } } },
  });
  assert.deepEqual(root, {
    sourceThreadId: 'thread-root',
    status: 'unknown',
    sourceKind: 'subagent',
  });

  assert.deepEqual(minimizeThread({
    id: 'thread-guardian',
    parentThreadId: null,
    source: { subAgent: { other: 'guardian' } },
  }), {
    sourceThreadId: 'thread-guardian',
    status: 'unknown',
    sourceKind: 'subagent',
  });

  const child = minimizeThread({
    id: 'thread-child',
    parentThreadId: null,
    forkedFromId: null,
    status: { type: 'active' },
    source: { subAgent: { thread_spawn: {
      parent_thread_id: 'thread-root',
      agent_path: '/root/child',
    } } },
  });
  assert.deepEqual(child, {
    sourceThreadId: 'thread-child',
    parentThreadId: 'thread-root',
    status: 'active',
    sourceKind: 'subagent',
    agentPath: '/root/child',
    agentTaskName: 'child',
  });

  assert.equal(minimizeThread({ id: null, parentThreadId: null, forkedFromId: null }), undefined);
  assert.equal(minimizeThread({ id: 'thread-bad', parentThreadId: {}, forkedFromId: null }), undefined);
});

test('minimizer projects real nested thread_spawn lineage and structural task names', () => {
  const dirac = minimizeThread({
    id: 'thread-dirac',
    status: 'active',
    name: 'untrusted raw task label',
    title: 'untrusted title',
    source: {
      subagent: {
        thread_spawn: {
          agent_path: '/root/dirac',
          agent_nickname: 'Dirac',
          agent_role: 'worker',
        },
      },
    },
  });
  assert.deepEqual(dirac, {
    sourceThreadId: 'thread-dirac',
    status: 'active',
    sourceKind: 'subagent',
    agentNickname: 'Dirac',
    agentRole: 'worker',
    agentPath: '/root/dirac',
    agentTaskName: 'dirac',
  });

  const rhea = minimizeThread({
    id: 'thread-rhea',
    status: 'active',
    name: 'this must not become the task name',
    title: 'this must not become the task name',
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: 'thread-dirac',
          agent_path: '/root/dirac/rhea',
          agent_nickname: 'Rhea',
          agent_role: 'planner',
        },
      },
    },
  });
  assert.deepEqual(rhea, {
    sourceThreadId: 'thread-rhea',
    parentThreadId: 'thread-dirac',
    status: 'active',
    sourceKind: 'subagent',
    agentNickname: 'Rhea',
    agentRole: 'planner',
    agentPath: '/root/dirac/rhea',
    agentTaskName: 'rhea',
  });
  assert.equal('name' in (rhea ?? {}), false);
  assert.equal('title' in (rhea ?? {}), false);
});

test('minimizer fails closed for conflicting or malformed nested lineage metadata', () => {
  assert.equal(minimizeThread({
    id: 'thread-rhea',
    parentThreadId: 'thread-dirac',
    source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-other', agent_path: '/root/dirac/rhea' } } },
  }), undefined);
  assert.equal(minimizeThread({
    id: 'thread-rhea',
    source: { subagent: { thread_spawn: { parent_thread_id: 'thread-dirac', agent_path: '/root/../rhea' } } },
  }), undefined);
  assert.equal(minimizeThread({
    id: 'thread-rhea',
    source: { subagent: { thread_spawn: { parent_thread_id: { leaked: true }, agent_path: '/root/dirac/rhea' } } },
  }), undefined);
  assert.equal(minimizeThread({
    id: 'thread-rhea',
    source: { subagent: { thread_spawn: { parent_thread_id: 'thread-dirac', agent_path: '/root/dirac//rhea' } } },
  }), undefined);
});

test('minimizer projects official collaboration and subagent activity fields without content', () => {
  const collaboration = minimizeItem({
    id: 'item-collab',
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    senderThreadId: 'thread-dirac',
    receiverThreadIds: ['thread-rhea', 'thread-kuhn'],
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    status: 'inProgress',
    prompt: 'must not leave the bridge',
    text: 'must not leave the bridge',
  });
  assert.deepEqual(collaboration, {
    sourceItemId: 'item-collab',
    kind: 'collaboration',
    status: 'in_progress',
    collaboration: {
      operation: 'spawnAgent',
      senderId: 'thread-dirac',
      receiverIds: ['thread-rhea', 'thread-kuhn'],
      requestedModel: 'gpt-5.6-luna',
      requestedReasoningEffort: 'max',
      status: 'in_progress',
    },
  });
  assert.equal('prompt' in (collaboration ?? {}), false);
  assert.equal('text' in (collaboration ?? {}), false);

  const activity = minimizeItem({
    id: 'item-activity',
    type: 'subAgentActivity',
    agentThreadId: 'thread-rhea',
    agentPath: '/root/dirac/rhea',
    kind: 'started',
    prompt: 'must not leave the bridge',
    text: 'must not leave the bridge',
  });
  assert.deepEqual(activity, {
    sourceItemId: 'item-activity',
    kind: 'subagent_activity',
    subagentActivity: {
      sourceThreadId: 'thread-rhea',
      agentPath: '/root/dirac/rhea',
      agentTaskName: 'rhea',
      status: 'started',
    },
  });
  assert.equal('prompt' in (activity ?? {}), false);
  assert.equal('text' in (activity ?? {}), false);

  const unrelated = minimizeItem({
    type: 'unrelatedItem',
    agentThreadId: 'thread-rhea',
    agentPath: '/root/dirac/rhea',
    kind: 'started',
  });
  assert.equal(unrelated?.subagentActivity, undefined);
});

test('minimizer fails closed for conflicting or malformed official activity identity', () => {
  assert.equal(minimizeItem({
    type: 'subAgentActivity',
    sourceThreadId: 'thread-rhea',
    agentThreadId: 'thread-kuhn',
    agentPath: '/root/dirac/rhea',
    kind: 'started',
  }), undefined);
  assert.equal(minimizeItem({
    type: 'subAgentActivity',
    agentThreadId: 'thread-rhea',
    agentPath: '/root/dirac/../rhea',
    kind: 'started',
  }), undefined);
  assert.equal(minimizeItem({
    type: 'subAgentActivity',
    agentThreadId: { leaked: true },
    agentPath: '/root/dirac/rhea',
    kind: 'started',
  }), undefined);
});

test('notification normalization accepts versioned lifecycle and rejects unsafe/unknown notifications', () => {
  const normalized = normalizeNotification({
    jsonrpc: '2.0',
    method: 'collabAgentToolCall',
    params: {
      version: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      operation: 'spawn_agent',
      senderId: 'thread-1',
      receiverIds: ['thread-2'],
      requestedModel: 'gpt-5',
      requestedReasoningEffort: 'high',
      prompt: 'never retained',
    },
  });
  assert.equal(normalized.accepted, true);
  if (normalized.accepted) {
    assert.equal(normalized.event.collaboration?.operation, 'spawn_agent');
    assert.equal('prompt' in normalized.event, false);
  }
  assert.deepEqual(normalizeNotification({ method: 'turn/start', params: { threadId: 'thread-1' }}), { accepted: false, reason: 'unsupported-notification' });
  assert.deepEqual(normalizeNotification({ method: 'turn/started', params: { version: 2, threadId: 'thread-1' }}), { accepted: false, reason: 'unsupported-version' });
});

test('notification normalization accepts current nested app-server lifecycle shapes', () => {
  const status = normalizeNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'active', activeFlags: [] } },
  });
  assert.equal(status.accepted, true);
  if (status.accepted) assert.equal(status.event.status, 'active');

  const started = normalizeNotification({
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', startedAt: 1_700_000_000 } },
  });
  assert.equal(started.accepted, true);
  if (started.accepted) {
    assert.equal(started.event.sourceTurnId, 'turn-1');
    assert.equal(started.event.startedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(started.event.status, 'started');
  }

  const completed = normalizeNotification({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', completedAt: 1_700_000_010 } },
  });
  assert.equal(completed.accepted, true);
  if (completed.accepted) {
    assert.equal(completed.event.sourceTurnId, 'turn-1');
    assert.equal(completed.event.completedAt, '2023-11-14T22:13:30.000Z');
    assert.equal(completed.event.status, 'completed');
  }
});

test('observation ledger is idempotent, conflict-quarantining, and accepts out-of-order arrival', () => {
  const ledger = new ObservationLedger();
  const first = ledger.accept({ connectionEpoch: 'epoch-a', ingestOrdinal: 20, event: event() });
  assert.equal(first.kind, 'accepted');
  const duplicate = ledger.accept({ connectionEpoch: 'epoch-b', ingestOrdinal: 2, event: event() });
  assert.equal(duplicate.kind, 'duplicate');
  const conflict = ledger.accept({ connectionEpoch: 'epoch-b', ingestOrdinal: 1, event: event({ collaboration: { operation: 'different' } }) });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(ledger.size, 1);
  assert.equal(ledger.quarantined().length, 1);
  assert.equal(canonicalObservationKey(event()), canonicalObservationKey(event()));
});

test('pagination collects all pages and reconciliation emits corrections only after a complete snapshot', async () => {
  const pages = new Map<string | undefined, { items: readonly { id: string; value: number }[]; nextCursor?: string }>([
    [undefined, { items: [{ id: 'a', value: 1 }], nextCursor: 'next' }],
    ['next', { items: [{ id: 'b', value: 2 }] }],
  ]);
  const all = await collectPages(async (cursor) => pages.get(cursor) ?? { items: [] });
  assert.deepEqual(all, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
  const result = reconcileSnapshot({
    current: new Map([['a', { id: 'a', value: 0 }], ['old', { id: 'old', value: 3 }]]),
    snapshot: all,
    keyOf: (item) => item.id,
    watermark: 'w-2',
  });
  assert.equal(result.watermark, 'w-2');
  assert.equal(result.corrections.length, 3);
});

test('adapter gate accepts explicitly tested fingerprint and quarantines incompatible schema', () => {
  const schema = generateStableSchemaBundle();
  const fingerprint = {
    binaryPath: '/Users/navin/.local/bin/codex',
    binarySha256: 'binary-hash',
    reportedUserAgent: 'Codex Desktop/0.145.0 (fixture)',
    schemaBundleSha256: schema.sha256,
    connectionTime: new Date(0).toISOString(),
  };
  const accepted = evaluateAdapterGate({
    fingerprint,
    schema,
    testedAdapters: [{ adapterVersion: 'phase-b-v1', binarySha256: 'binary-hash', schemaBundleSha256: schema.sha256, userAgentPrefix: 'Codex Desktop/0.145.0' }],
  });
  assert.equal(accepted.status, 'accepted');
  const incompatible = evaluateAdapterGate({ fingerprint, schema: { ...schema, methods: schema.methods.slice(1) }, testedAdapters: [] });
  assert.equal(incompatible.status, 'quarantined');
  assert.equal(incompatible.reason, 'schema-invalid');
});

test('adapter gate enforces exact declared schema-file hash evidence while preserving legacy fixtures', () => {
  const schema = generateStableSchemaBundle();
  const baseFingerprint = {
    binarySha256: 'binary-hash',
    reportedUserAgent: 'Codex Desktop/0.145.0 (fixture)',
    schemaBundleSha256: schema.sha256,
    connectionTime: new Date(0).toISOString(),
  };
  const adapter = {
    adapterVersion: 'phase-a-with-schema-files',
    binarySha256: 'binary-hash',
    schemaBundleSha256: schema.sha256,
    schemaHashes: PHASE_A_SCHEMA_HASHES,
    userAgentPrefix: 'Codex Desktop/0.145.0',
  };

  const accepted = evaluateAdapterGate({
    fingerprint: { ...baseFingerprint, schemaHashes: PHASE_A_SCHEMA_HASHES },
    schema,
    testedAdapters: [adapter],
  });
  assert.equal(accepted.status, 'accepted');

  const missing = evaluateAdapterGate({ fingerprint: baseFingerprint, schema, testedAdapters: [adapter] });
  assert.equal(missing.status, 'quarantined');
  assert.equal(missing.reason, 'schema-hashes-missing');

  const mismatch = evaluateAdapterGate({
    fingerprint: {
      ...baseFingerprint,
      schemaHashes: { ...PHASE_A_SCHEMA_HASHES, stable: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    },
    schema,
    testedAdapters: [adapter],
  });
  assert.equal(mismatch.status, 'quarantined');
  assert.equal(mismatch.reason, 'schema-hashes-mismatch');

  const legacy = evaluateAdapterGate({ fingerprint: baseFingerprint, schema, testedAdapters: [{ ...adapter, schemaHashes: undefined }] });
  assert.equal(legacy.status, 'accepted');
});

test('final result summaries are disabled by default and locally redacted when opted in', () => {
  assert.equal(minimizeFinalSummary({ sourceThreadId: 'thread-1', text: 'hello' }), undefined);
  const summary = minimizeFinalSummary(
    { sourceThreadId: 'thread-1', sourceTurnId: 'turn-1', text: 'Done. See /Users/navin/project and Bearer secret-value.\ncommand: rm -rf /' },
    { enabled: true },
  );
  assert.equal(summary?.text, 'Done. See [redacted-path] and [redacted-token].');
  assert.equal(summary?.provenance, 'final_agent_message');
});

test('connect gates before initialized and closes incompatible connections', async () => {
  let transport: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const request = JSON.parse(line) as { id: number; method: string };
      await transport.pushLine(JSON.stringify({ id: request.id, result: request.method === 'initialize' ? { userAgent: 'Codex Desktop/0.145.0' } : {} }));
    },
  });
  const client = new AppServerClient(transport);
  const schema = generateStableSchemaBundle();
  await assert.rejects(
    () => client.connect({ initializeParams: { clientInfo: { name: 'fixture', version: '1.0.0' } }, schema, testedAdapters: [] }),
    (error: unknown) => error instanceof AdapterQuarantinedError,
  );
  assert.equal(transport.sentLines.length, 1);
});

test('accepted connect emits Codex initialized as an id-less notification', async () => {
  const schema = generateStableSchemaBundle();
  let transport: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.method === 'initialize') {
        await transport.pushLine(JSON.stringify({ id: message.id, result: { userAgent: 'Codex Desktop/0.145.0 (fixture)' } }));
      }
    },
  });
  const client = new AppServerClient(transport);
  await client.connect({
    initializeParams: {
      clientInfo: { name: 'agent-farm', title: 'Agent Farm', version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] },
    },
    schema,
    binarySha256: 'binary-hash',
    testedAdapters: [{
      adapterVersion: 'phase-b-v1',
      binarySha256: 'binary-hash',
      schemaBundleSha256: schema.sha256,
      userAgentPrefix: 'Codex Desktop/0.145.0',
    }],
  });
  assert.equal(transport.sentLines.length, 2);
  assert.deepEqual(JSON.parse(transport.sentLines[1] ?? '{}'), { method: 'initialized' });
  await client.close();
});

test('transport failure rejects pending work and permanently closes the client', async () => {
  const transport = new InMemoryStdioTransport();
  const client = new AppServerClient(transport);
  const pending = client.listModels();
  await transport.fail(new Error('fixture transport ended'));
  await assert.rejects(pending, (error: unknown) =>
    error instanceof BridgeProtocolError && error.code === 'TRANSPORT_ERROR');
  await assert.rejects(client.listModels(), (error: unknown) =>
    error instanceof BridgeProtocolError && error.code === 'CLOSED');
});
