import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AppServerClient,
  createTrustedLocalRolloutResolver,
  InMemoryStdioTransport,
  generateStableSchemaBundle,
  readRolloutIdentityEvidence,
  readRolloutLocalDetail,
} from '../src/index.js';
import { LocalRolloutDetailSchema } from '@agent-farm/contracts';

const THREAD_ID = 'thread-dirac';
const TURN_ID = 'turn-dirac';
const CREATED_AT = 1_767_323_045;

function jsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function validRecords(): readonly unknown[] {
  return [
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high', summary: 'secret context' } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'rhea', model: 'gpt-5.6-luna', reasoning_effort: 'max', message: 'secret prompt' }),
    } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-luna', effort: 'max' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model_provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'rhea', model: 'gpt-5.6-luna', reasoning_effort: 'max', message: 'duplicate secret prompt' }),
    } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'other_tool',
      arguments: JSON.stringify({ task_name: 'ignored' }),
    } },
  ];
}

async function setupRoot(): Promise<{ root: string; rollout: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'thread-dirac.jsonl');
  await writeFile(rollout, jsonl(validRecords()), 'utf8');
  return { root, rollout };
}

async function acceptedClient(root: string, rollout: string, requests: string[]): Promise<{ client: AppServerClient; transport: InMemoryStdioTransport }> {
  let transport: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({
    onSend: async (line) => {
      requests.push(line);
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.method === 'initialize' && request.id !== undefined) {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { userAgent: 'Codex Desktop/0.145.0 (fixture)' } }));
      }
      if (request.method === 'thread/read' && request.id !== undefined) {
        await transport.pushLine(JSON.stringify({ id: request.id, result: { thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] }, turns: [] } }));
      }
    },
  });
  const client = new AppServerClient(transport, { rolloutIdentity: { sessionsRoot: root } });
  const schema = generateStableSchemaBundle();
  await client.connect({
    initializeParams: { clientInfo: { name: 'rollout-evidence-test', version: '1.0.0' } },
    schema,
    binarySha256: 'binary-hash',
    testedAdapters: [{ adapterVersion: 'fixture', binarySha256: 'binary-hash', schemaBundleSha256: schema.sha256, userAgentPrefix: 'Codex Desktop/0.145.0' }],
  });
  return { client, transport };
}

test('readRolloutIdentity extracts bounded model drift and spawn intent without raw content', async () => {
  const { root, rollout } = await setupRoot();
  const requests: string[] = [];
  const { client } = await acceptedClient(root, rollout, requests);
  try {
    const evidence = await client.readRolloutIdentity(THREAD_ID);
    assert.deepEqual(evidence, {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [
        { model: 'gpt-5.6-sol', effort: 'high' },
        { model: 'gpt-5.6-luna', effort: 'max' },
        { model: 'gpt-5.6-sol', effort: 'high' },
      ],
      requestedSpawns: [
        { taskName: 'rhea', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
        { taskName: 'rhea', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
      ],
    });
    const serialized = JSON.stringify(evidence);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes('message'), false);
    assert.equal(serialized.includes('thread-dirac.jsonl'), false);
    const readRequests = requests.filter((line) => JSON.parse(line).method === 'thread/read').map((line) => JSON.parse(line));
    assert.deepEqual(readRequests, [{ id: 2, method: 'thread/read', params: { threadId: THREAD_ID, includeTurns: true } }]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout identity retains the latest explicit lifecycle event for its exact session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-lifecycle-'));
  const rollout = join(root, `rollout-${THREAD_ID}.jsonl`);
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root });
    assert.equal(evidence?.lifecycle, 'active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout identity treats the current turn_aborted event as interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-aborted-'));
  const rollout = join(root, `rollout-${THREAD_ID}.jsonl`);
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root });
    assert.equal(evidence?.lifecycle, 'interrupted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout lifecycle ignores completed statuses from non-lifecycle tool events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-operation-status-'));
  const rollout = join(root, `rollout-${THREAD_ID}.jsonl`);
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', status: 'completed' } },
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', status: 'completed' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root });
    assert.equal(evidence?.lifecycle, 'active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted local resolver enriches exact identity/detail without app-server and rejects ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-resolver-'));
  const rollout = join(root, `rollout-2026-08-12-${THREAD_ID}.jsonl`);
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model_provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'allowed local summary' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'authorization: Bearer secret-value' } },
  ]), 'utf8');
  try {
    const resolver = createTrustedLocalRolloutResolver({ sessionsRoot: root });
    assert.deepEqual(await resolver.readIdentity(THREAD_ID), {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [{ model: 'gpt-5.6-sol', effort: 'high' }],
      requestedSpawns: [],
    });
    const detail = await resolver.readDetail(THREAD_ID);
    assert.deepEqual(detail?.messages.map((message) => message.text), ['allowed local summary']);
    assert.equal(JSON.stringify(detail).includes('secret-value'), false);
    await writeFile(join(root, `duplicate-${THREAD_ID}.jsonl`), jsonl(validRecords()), 'utf8');
    assert.equal(await resolver.readIdentity(THREAD_ID), undefined);
    assert.equal(await resolver.readDetail(THREAD_ID), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted local topology admits an exact three-child chain and ignores unrelated roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-'));
  const writeTopology = async (id: string, parent: string | undefined, path: string) => {
    await writeFile(join(root, `rollout-${id}.jsonl`), jsonl([
      { type: 'session_meta', payload: {
        id,
        status: id.endsWith('three') ? 'completed' : 'active',
        model_provider: 'openai',
        ...(parent === undefined ? {} : { parent_thread_id: parent }),
        source: { subagent: { thread_spawn: { ...(parent === undefined ? {} : { parent_thread_id: parent }), agent_path: path } } },
      } },
      { type: 'turn_context', payload: { turn_id: `turn-${id}`, model: 'gpt-5.6-luna', effort: 'low' } },
      { type: 'event_msg', payload: { type: id.endsWith('three') ? 'task_complete' : 'task_started' } },
      { type: 'event_msg', payload: { type: 'patch_apply_end', status: 'completed' } },
    ]), 'utf8');
  };
  try {
    await writeTopology('topology-root', undefined, '/root');
    await writeTopology('topology-one', 'topology-root', '/root/one');
    await writeTopology('topology-two', 'topology-one', '/root/one/two');
    await writeTopology('topology-three', 'topology-two', '/root/one/two/three');
    await writeTopology('unrelated-root', undefined, '/root');
    await writeTopology('unrelated-child', 'unrelated-root', '/root/unrelated');
    const resolver = createTrustedLocalRolloutResolver({ sessionsRoot: root });
    const topology = await resolver.discoverTopology('topology-root');
    assert.deepEqual(topology?.map((node) => [node.sourceThreadId, node.parentThreadId, node.agentTaskName]), [
      ['topology-one', 'topology-root', 'one'],
      ['topology-two', 'topology-one', 'two'],
      ['topology-three', 'topology-two', 'three'],
    ]);
    assert.equal(JSON.stringify(topology).includes('unrelated'), false);
    assert.equal(topology?.at(-1)?.status, 'completed');
    assert.deepEqual(await resolver.discoverTopology('missing-root'), []);
    assert.equal(await createTrustedLocalRolloutResolver({ sessionsRoot: root, maxTopologyNodes: 2 }).discoverTopology('topology-root'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted local topology fails closed on duplicate identity, symlink, and aggregate limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-bounds-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-outside-'));
  const record = (id: string, parent?: string) => jsonl([{ type: 'session_meta', payload: { id, ...(parent === undefined ? {} : { parent_thread_id: parent }), source: { subagent: { thread_spawn: { ...(parent === undefined ? {} : { parent_thread_id: parent }), agent_path: parent === undefined ? '/root' : '/root/child' } } } } }]);
  try {
    await writeFile(join(root, 'rollout-topology-root.jsonl'), record('topology-root'), 'utf8');
    await writeFile(join(root, 'rollout-topology-child.jsonl'), record('topology-child', 'topology-root'), 'utf8');
    const resolver = createTrustedLocalRolloutResolver({ sessionsRoot: root, maxTopologyFiles: 2, maxTopologyRecords: 2, maxTopologyBytes: 16_384 });
    assert.equal((await resolver.discoverTopology('topology-root'))?.length, 1);
    assert.equal(await createTrustedLocalRolloutResolver({ sessionsRoot: root, maxTopologyFiles: 1 }).discoverTopology('topology-root'), undefined);
    assert.equal(await createTrustedLocalRolloutResolver({ sessionsRoot: root, maxTopologyRecords: 1 }).discoverTopology('topology-root'), undefined);
    await writeFile(join(root, 'duplicate-topology-child.jsonl'), record('topology-child', 'topology-root'), 'utf8');
    assert.equal(await createTrustedLocalRolloutResolver({ sessionsRoot: root }).discoverTopology('topology-root'), undefined);
    await rm(join(root, 'duplicate-topology-child.jsonl'));
    const external = join(outside, 'rollout-escape.jsonl');
    await writeFile(external, record('escape'), 'utf8');
    await symlink(external, join(root, 'rollout-escape.jsonl'));
    assert.equal(await createTrustedLocalRolloutResolver({ sessionsRoot: root }).discoverTopology('topology-root'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('trusted local topology rejects generic forks and conflicting lineage aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-lineage-'));
  try {
    await writeFile(join(root, 'rollout-generic-fork.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'generic-fork', parent_thread_id: 'selected-root' } },
    ]), 'utf8');
    await writeFile(join(root, 'rollout-conflicting-parent.jsonl'), jsonl([
      { type: 'session_meta', payload: {
        id: 'conflicting-parent',
        parent_thread_id: 'selected-root',
        forked_from_id: 'other-root',
        source: { subagent: { thread_spawn: { parent_thread_id: 'selected-root', agent_path: '/root/conflict' } } },
      } },
    ]), 'utf8');
    await writeFile(join(root, 'rollout-conflicting-spawn.jsonl'), jsonl([
      { type: 'session_meta', payload: {
        id: 'conflicting-spawn',
        parent_thread_id: 'selected-root',
        source: { subagent: { thread_spawn: { parent_thread_id: 'selected-root', parentThreadId: 'other-root', agent_path: '/root/conflict' } } },
      } },
    ]), 'utf8');
    const resolver = createTrustedLocalRolloutResolver({ sessionsRoot: root });
    assert.deepEqual(await resolver.discoverTopology('selected-root'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted local topology ignores secret-shaped irrelevant content and reads live collaboration settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-live-'));
  try {
    await writeFile(join(root, 'rollout-live-root.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'live-root', source: { subagent: { thread_spawn: { agent_path: '/root' } } }, authorization: 'ignored-secret-field' } },
      { type: 'response_item', payload: { type: 'message', text: 'password: irrelevant' } },
    ]), 'utf8');
    await writeFile(join(root, 'rollout-live-child.jsonl'), jsonl([
      { type: 'session_meta', payload: { id: 'live-child', parent_thread_id: 'live-root', source: { subAgent: { thread_spawn: { parent_thread_id: 'live-root', agent_path: '/root/live_child' } } } } },
      { type: 'turn_context', payload: { turn_id: 'turn-live', collaboration_mode: { settings: { model: 'gpt-live', reasoning_effort: 'high', model_provider: 'openai' } } } },
      { type: 'event_msg', payload: { type: 'task_completed' } },
    ]), 'utf8');
    assert.deepEqual(await createTrustedLocalRolloutResolver({ sessionsRoot: root }).discoverTopology('live-root'), [
      { sourceThreadId: 'live-child', parentThreadId: 'live-root', agentPath: '/root/live_child', agentTaskName: 'live_child', status: 'completed', modelProvider: 'openai', model: 'gpt-live', effort: 'high' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted local topology scales past 512 unrelated files and never reads the authoritative oversized root in full', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-local-topology-scale-'));
  const structural = (id: string, parent: string, path: string) => jsonl([{ type: 'session_meta', payload: {
    id,
    parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: path } } },
  } }]);
  try {
    const rootFile = join(root, 'rollout-scale-root.jsonl');
    await writeFile(rootFile, jsonl([{ type: 'session_meta', payload: { id: 'scale-root' } }]), 'utf8');
    await truncate(rootFile, 16 * 1024 * 1024);
    await Promise.all(Array.from({ length: 520 }, (_, index) => writeFile(
      join(root, `rollout-unrelated-${index}.jsonl`),
      jsonl([{ type: 'session_meta', payload: { id: `unrelated-${index}` } }]),
      'utf8',
    )));
    await writeFile(join(root, 'rollout-scale-one.jsonl'), structural('scale-one', 'scale-root', '/root/one'), 'utf8');
    await writeFile(join(root, 'rollout-scale-two.jsonl'), structural('scale-two', 'scale-one', '/root/one/two'), 'utf8');
    await writeFile(join(root, 'rollout-scale-three.jsonl'), structural('scale-three', 'scale-two', '/root/one/two/three'), 'utf8');
    const topology = await createTrustedLocalRolloutResolver({ sessionsRoot: root }).discoverTopology('scale-root');
    assert.deepEqual(topology?.map((node) => node.sourceThreadId), ['scale-one', 'scale-two', 'scale-three']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted resolver resumes exact child turns after inherited parent prefix and reads bounded structured messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-live-schema-'));
  const rollout = join(root, `rollout-live-${THREAD_ID}.jsonl`);
  await writeFile(rollout, jsonl([
    { type: 'session_meta', timestamp: '2026-08-12T10:00:00.000Z', payload: { id: THREAD_ID, parent_thread_id: 'parent-thread', forked_from_id: 'parent-thread', model_provider: 'openai' } },
    { type: 'session_meta', timestamp: '2026-08-12T10:00:00.000Z', payload: { id: 'parent-thread', model_provider: 'openai' } },
    { type: 'turn_context', timestamp: '2026-08-12T10:00:00.000Z', payload: { turn_id: 'parent-turn', model: 'gpt-parent', effort: 'medium' } },
    { type: 'turn_context', timestamp: '2026-08-12T10:00:01.000Z', payload: { turn_id: TURN_ID, collaboration_mode: { mode: 'default', settings: { model: 'gpt-5.6-luna', reasoning_effort: 'max' } } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'structured allowed' }, { type: 'output_text', text: 'password: hidden' }] } },
  ]), 'utf8');
  try {
    const resolver = createTrustedLocalRolloutResolver({ sessionsRoot: root });
    assert.deepEqual(await resolver.readIdentity(THREAD_ID), {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [{ model: 'gpt-5.6-luna', effort: 'max' }],
      requestedSpawns: [],
    });
    const detail = await resolver.readDetail(THREAD_ID);
    assert.deepEqual(detail?.messages.map((message) => message.text), ['structured allowed']);
    assert.equal(JSON.stringify(detail).includes('hidden'), false);
    assert.equal(LocalRolloutDetailSchema.safeParse(detail).success, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout usage ignores null token heartbeats and keeps the latest cumulative total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'usage.jsonl');
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-08-12T07:50:00.000Z', payload: { type: 'token_count', info: null } },
    { type: 'event_msg', timestamp: '2026-08-12T07:50:01.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 } } } },
    { type: 'event_msg', timestamp: '2026-08-12T07:50:02.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 } } } },
  ]), 'utf8');
  try {
    assert.deepEqual(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [] } }, THREAD_ID, { sessionsRoot: root }), {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [],
      requestedSpawns: [],
      usage: { inputTokens: 200, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 220, observedAt: '2026-08-12T07:50:02.000Z' },
      usageSegmentsComplete: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout usage segments require exact active context and cumulative delta agreement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'usage-segments.jsonl');
  const first = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 };
  const second = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 7, total_tokens: 70 };
  const cumulative = { input_tokens: 150, cached_input_tokens: 30, cache_write_input_tokens: 5, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 180 };
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model_provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-08-12T08:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: first, last_token_usage: first, model_context_window: 999_999_999 } } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model_provider: 'openai', model: 'gpt-5.6-luna', effort: 'low' } },
    { type: 'event_msg', timestamp: '2026-08-12T08:01:00.000Z', payload: { type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: second, model_context_window: 1 } } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root });
    assert.deepEqual(evidence?.usageSegments, [
      {
        turnId: TURN_ID,
        provider: 'openai',
        model: 'gpt-5.6-sol',
        effort: 'high',
        usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 110, observedAt: '2026-08-12T08:00:00.000Z' },
      },
      {
        turnId: TURN_ID,
        provider: 'openai',
        model: 'gpt-5.6-luna',
        effort: 'low',
        usage: { inputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 7, totalTokens: 70, observedAt: '2026-08-12T08:01:00.000Z' },
      },
    ]);
    assert.equal(evidence?.usageSegmentsComplete, true);
    assert.equal(evidence?.usage?.totalTokens, 180);
    assert.equal(JSON.stringify(evidence).includes('model_context_window'), false);
    assert.equal(JSON.stringify(evidence).includes('999999999'), false);
    const bounded = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root, maxUsageSegments: 1 });
    assert.equal(bounded?.usageSegments?.length, 1);
    assert.equal(bounded?.usageSegmentsComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout usage retains valid segments across duplicate heartbeats and later malformed telemetry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'usage-segments-partial.jsonl');
  const first = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 };
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-08-12T08:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: first, last_token_usage: first } } },
    { type: 'event_msg', timestamp: '2026-08-12T08:00:01.000Z', payload: { type: 'token_count', info: { total_token_usage: first, last_token_usage: first } } },
    { type: 'event_msg', timestamp: '2026-08-12T08:00:02.000Z', payload: { type: 'token_count', info: { total_token_usage: { ...first, input_tokens: 'malformed' } } } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root });
    assert.equal(evidence?.usageSegmentsComplete, false);
    assert.equal(evidence?.usageSegments?.length, 1);
    assert.equal(evidence?.usageSegments?.[0]?.provider, 'openai');
    assert.equal(evidence?.usageSegments?.[0]?.usage.totalTokens, 110);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout usage segments remain incomplete on context gaps or delta mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'usage-segment-gap.jsonl');
  const first = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 };
  const cumulative = { input_tokens: 200, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 6, total_tokens: 220 };
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-08-12T08:00:00.000Z', payload: { type: 'token_count', info: { total_token_usage: first, last_token_usage: first } } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-08-12T08:01:00.000Z', payload: { type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: { ...first, input_tokens: 99, total_tokens: 109 } } } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
    }, THREAD_ID, { sessionsRoot: root });
    assert.equal(evidence?.usage?.totalTokens, 220);
    assert.equal(evidence?.usageSegmentsComplete, false);
    assert.equal(evidence?.usageSegments, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local rollout detail exposes messages, files, and read-only non-control tool evidence without credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-detail-'));
  const rollout = join(root, 'detail.jsonl');
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', timestamp: '2026-08-12T09:00:00.000Z', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', timestamp: '2026-08-12T09:00:01.000Z', payload: { type: 'message', role: 'user', text: 'Please inspect the local project.' } },
    { type: 'response_item', timestamp: '2026-08-12T09:00:02.000Z', payload: { type: 'message', role: 'assistant', text: 'Inspection is complete.', summary: 'Completed local inspection.', changed_files: [{ path: '/private/tmp/project/a.ts', additions: 4, deletions: 1 }] } },
    { type: 'event_msg', timestamp: '2026-08-12T09:00:03.000Z', payload: { type: 'task_complete', summary: 'Final verified result.' } },
    { type: 'response_item', timestamp: '2026-08-12T09:00:04.000Z', payload: { type: 'function_call', name: 'read_file', call_id: 'call-1', arguments: JSON.stringify({ path: '/private/tmp/project/a.ts', api_token: 'must-not-expose-token' }) } },
    { type: 'response_item', timestamp: '2026-08-12T09:00:05.000Z', payload: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ text: 'allowed tool result', password: 'must-not-expose-password' }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: 'must-not-expose-control' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'must-not-expose-secret', authorization: 'Bearer abc' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'must-not-expose-camel-secret', privateKey: 'abc' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', text: 'Bearer abcdefghi' } },
    { type: 'turn_context', payload: { turn_id: 'turn-inherited', model: 'gpt-5.6-luna', effort: 'low' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', text: 'must-not-cross-turn' } },
  ]), 'utf8');
  try {
    const detail = await readRolloutLocalDetail({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root });
    assert.deepEqual(detail, {
      schemaVersion: 'agent-farm.local-rollout-detail.v2',
      sourceThreadId: THREAD_ID,
      messages: [
        { role: 'user', text: 'Please inspect the local project.', occurredAt: '2026-08-12T09:00:01.000Z' },
        { role: 'assistant', text: 'Inspection is complete.', occurredAt: '2026-08-12T09:00:02.000Z' },
      ],
      activity: [
        { kind: 'thread_settings', status: 'active', startedAt: '2026-08-12T09:00:00.000Z' },
        { kind: 'lifecycle', status: 'task_complete', startedAt: '2026-08-12T09:00:03.000Z' },
      ],
      tools: [{ name: 'read_file', status: 'completed', arguments: '{"path":"/private/tmp/project/a.ts"}', result: '{"text":"allowed tool result"}', startedAt: '2026-08-12T09:00:04.000Z', completedAt: '2026-08-12T09:00:05.000Z', durationMs: 1_000 }],
      changedFiles: [{ path: '/private/tmp/project/a.ts', additions: 4, deletions: 1 }],
      finalSummary: 'Final verified result.',
    });
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes('must-not'), false);
    assert.equal(serialized.includes('Bearer'), false);
    assert.equal(serialized.includes('spawn_agent'), false);
    assert.equal(serialized.includes('allowed tool result'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local rollout detail retains trusted-path bounds and exact session identity', async () => {
  const { root, rollout } = await setupRoot();
  try {
    assert.equal(await readRolloutLocalDetail({ thread: { id: 'other', path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), undefined);
    assert.equal(await readRolloutLocalDetail({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root, maxRecords: 1 }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollout identity selects only the requested session segment and rejects repeated matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'segmented.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'session_meta', payload: { id: 'thread-parent', model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: 'turn-parent', model: 'gpt-5.6-luna', effort: 'max' } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'noether', model: 'gpt-5.6-sol', reasoning_effort: 'high', message: 'must not cross session boundary' }),
    } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'rhea', model: 'gpt-5.6-luna', reasoning_effort: 'max', message: 'private rhea prompt' }),
    } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-luna', effort: 'max' } },
    { type: 'response_item', payload: {
      type: 'function_call',
      name: 'spawn_agent',
      arguments: JSON.stringify({ task_name: 'kuhn', model: 'gpt-5.6-luna', reasoning_effort: 'max', message: 'private kuhn prompt' }),
    } },
  ] as const;
  try {
    await writeFile(rollout, jsonl(records), 'utf8');
    assert.deepEqual(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: 'turn-parent', startedAt: CREATED_AT - 1 }, { id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [
        { model: 'gpt-5.6-sol', effort: 'high' },
        { model: 'gpt-5.6-luna', effort: 'max' },
      ],
      requestedSpawns: [
        { taskName: 'rhea', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
        { taskName: 'kuhn', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
      ],
    });
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID }] } }, THREAD_ID, { sessionsRoot: root }), undefined);
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT * 1_000, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), undefined);

    await writeFile(rollout, jsonl([...records, { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } }]), 'utf8');
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: 'turn-parent', startedAt: CREATED_AT - 1 }, { id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('equal-second inherited turn ids are excluded when they are absent from the child thread turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'equal-second-inherited.jsonl');
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: 'turn-inherited', model: 'gpt-5.6-luna', effort: 'max' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
  ]), 'utf8');
  try {
    const evidence = await readRolloutIdentityEvidence({
      // The top-level read shape contains an inherited turn at the exact
      // creation second, but only TURN_ID belongs to this child thread's own
      // `thread.turns` allowlist.
      thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] },
      turns: [{ id: 'turn-inherited', startedAt: CREATED_AT }],
    }, THREAD_ID, { sessionsRoot: root });
    assert.deepEqual(evidence, {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [{ model: 'gpt-5.6-sol', effort: 'high' }],
      requestedSpawns: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nonmatching rollout thread with a colliding turn id is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'session-collision.jsonl');
  await writeFile(rollout, jsonl([
    // A reused turn id cannot establish ownership when the rollout belongs to
    // another thread: matching requires `thread.id` == requested thread id ==
    // `session_meta.payload.id`, followed by the exact own-turn allowlist.
    { type: 'session_meta', payload: { id: 'thread-other', session_id: 'shared-top-level', model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-luna', effort: 'max' } },
  ]), 'utf8');
  try {
    assert.equal(await readRolloutIdentityEvidence({
      thread: {
        id: THREAD_ID,
        path: rollout,
        createdAt: CREATED_AT,
        turns: [{ id: TURN_ID, startedAt: CREATED_AT }],
      },
    }, THREAD_ID, { sessionsRoot: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reads a valid rollout over the legacy 4 MiB bound but rejects a configured smaller cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'long-rollout.jsonl');
  const legacyBound = 4 * 1024 * 1024;
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    // Keep the fixture valid JSONL while forcing the file beyond the former
    // 4 MiB default; this payload is ignored and never appears in evidence.
    { type: 'padding', payload: { text: 'x'.repeat(legacyBound + 1_024) } },
  ]), 'utf8');
  try {
    const rawThreadRead = { thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } };
    assert.deepEqual(await readRolloutIdentityEvidence(rawThreadRead, THREAD_ID, { sessionsRoot: root }), {
      sourceThreadId: THREAD_ID,
      modelProvider: 'openai',
      observedHistory: [{ model: 'gpt-5.6-sol', effort: 'high' }],
      requestedSpawns: [],
    });
    assert.equal(await readRolloutIdentityEvidence(rawThreadRead, THREAD_ID, { sessionsRoot: root, maxFileBytes: legacyBound }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('streams past oversized compacted/tool-output lines without losing identity or detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'thread-dirac.jsonl');
  const maxLineBytes = 64 * 1024;
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    // A long-running chat can emit multi-megabyte `compacted` records. They
    // carry no identity/detail evidence and must be skipped, never poison the
    // model/effort extraction or fail the whole read.
    { type: 'compacted', payload: { message: 'z'.repeat(maxLineBytes + 1_024) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept message' }] } },
  ]), 'utf8');
  try {
    const rawThreadRead = { thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } };
    const identity = await readRolloutIdentityEvidence(rawThreadRead, THREAD_ID, { sessionsRoot: root, maxLineBytes });
    assert.deepEqual(identity?.observedHistory, [{ model: 'gpt-5.6-sol', effort: 'high' }]);
    const detail = await readRolloutLocalDetail(rawThreadRead, THREAD_ID, { sessionsRoot: root, maxLineBytes });
    assert.ok(detail?.messages.some((message) => message.text === 'kept message'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRolloutIdentity is disabled until the adapter gate accepts and makes no call', async () => {
  const requests: string[] = [];
  let transport: InMemoryStdioTransport;
  transport = new InMemoryStdioTransport({ onSend: async (line) => requests.push(line) });
  const client = new AppServerClient(transport, { rolloutIdentity: { sessionsRoot: '/private/tmp/trusted' } });
  try {
    assert.equal(await client.readRolloutIdentity(THREAD_ID), undefined);
    assert.deepEqual(requests, []);
  } finally {
    await client.close();
  }
});

test('rollout identity returns generic unavailable for traversal, symlink, oversize, malformed, and session mismatch', async () => {
  const { root, rollout } = await setupRoot();
  const outside = join(root, '..', 'outside-rollout.jsonl');
  const malformed = join(root, 'malformed.jsonl');
  const mismatch = join(root, 'mismatch.jsonl');
  const oversized = join(root, 'oversized.jsonl');
  const link = join(root, 'link.jsonl');
  try {
    await writeFile(malformed, '{not-json}\n', 'utf8');
    await writeFile(mismatch, jsonl([{ type: 'session_meta', payload: { id: 'thread-other', model_provider: 'openai' } }]), 'utf8');
    await writeFile(oversized, 'x'.repeat(200), 'utf8');
    await symlink(rollout, link);
    const options = { sessionsRoot: root, maxFileBytes: 64 * 1024 };
    const unavailable = async (path: string, customOptions = options) => readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path } }, THREAD_ID, customOptions);
    assert.equal(await unavailable(outside), undefined);
    assert.equal(await unavailable(link), undefined);
    assert.equal(await unavailable(oversized, { sessionsRoot: root, maxFileBytes: 32 }), undefined);
    assert.equal(await unavailable(malformed), undefined);
    assert.equal(await unavailable(mismatch), undefined);
    assert.equal(await unavailable(rollout, { sessionsRoot: 'relative-root' }), undefined);
    assert.equal(await readRolloutIdentityEvidence({ thread: { path: rollout } }, THREAD_ID, options), undefined);
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout } }, THREAD_ID, { sessionsRoot: root, maxRecords: 1 }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed spawn arguments are unavailable rather than exposing partial identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'malformed-spawn.jsonl');
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: '{not-json}' } },
  ]), 'utf8');
  try {
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('spawn task labels use the bounded lowercase tool grammar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-farm-rollout-'));
  const rollout = join(root, 'invalid-task.jsonl');
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: THREAD_ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: TURN_ID, model: 'gpt-5.6-sol', effort: 'high' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'Rhea', model: 'gpt-5.6-luna' }) } },
  ]), 'utf8');
  try {
    assert.equal(await readRolloutIdentityEvidence({ thread: { id: THREAD_ID, path: rollout, createdAt: CREATED_AT, turns: [{ id: TURN_ID, startedAt: CREATED_AT }] } }, THREAD_ID, { sessionsRoot: root }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
