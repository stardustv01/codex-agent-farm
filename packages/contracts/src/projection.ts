import {
  AgentEdgeSchema,
  AgentSchema,
  AgentSessionSchema,
  CONTRACT_VERSION,
  ConnectionStateSchema,
  IdentityEvidenceSchema,
  IngestOrdinalSchema,
  QuarantineReasonSchema,
  QuarantinedRecordSchema,
  SanitizedEventSchema,
  SnapshotSchema,
  TimestampSchema,
  TurnGenerationSchema,
  type Agent,
  type AgentEdge,
  type AgentSession,
  type ConnectionState,
  type IdentityEvidence,
  type IngestOrdinal,
  type QuarantinedRecord,
  type SanitizedEvent,
  type Snapshot,
  type Timestamp,
  type TurnGeneration,
  type IdentityValues,
} from "./schemas.js";

export interface ProjectionState {
  schemaVersion: typeof CONTRACT_VERSION;
  session: AgentSession;
  connection: ConnectionState;
  agents: Agent[];
  edges: AgentEdge[];
  identityEvidence: IdentityEvidence[];
  quarantined: QuarantinedRecord[];
  /** The largest backend ordinal incorporated into this projection. */
  lastIngestOrdinal: IngestOrdinal;
  /** The epoch of the most recently accepted observation. */
  lastConnectionEpoch: string;
  /** Event id -> canonical sanitized fingerprint. */
  appliedEventFingerprints: Record<string, string>;
  /** Idempotency key -> canonical sanitized fingerprint. */
  appliedIdempotency: Record<string, string>;
  revision: number;
}

export interface ReductionResult {
  state: ProjectionState;
  accepted: boolean;
  duplicate: boolean;
  quarantined?: QuarantinedRecord;
}

export interface ProjectionOptions {
  agents?: readonly Agent[];
  edges?: readonly AgentEdge[];
  identityEvidence?: readonly IdentityEvidence[];
  quarantined?: readonly QuarantinedRecord[];
  lastIngestOrdinal?: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Stable JSON is used for event idempotency. It intentionally includes only
 * sanitized fields and sorts object keys, so arrival metadata can change on a
 * replay without changing the event's logical payload.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** A short deterministic digest; no raw input is retained or logged. */
export function sanitizedFingerprint(value: unknown): string {
  const serialized = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

const payloadForFingerprint = (event: SanitizedEvent): unknown => {
  const {
    eventId: _eventId,
    connectionEpoch: _connectionEpoch,
    ingestOrdinal: _ingestOrdinal,
    observedAt: _observedAt,
    authority: _authority,
    idempotencyKey: _idempotencyKey,
    sanitizedPayloadHash: _sanitizedPayloadHash,
    ...payload
  } = event;
  return payload;
};

export function eventFingerprint(event: SanitizedEvent): string {
  return sanitizedFingerprint(payloadForFingerprint(event));
}

const now = (value: Timestamp): Timestamp => TimestampSchema.parse(value);

const emptyIdentityEvidenceIds = (): string[] => [];
const emptyTurnGenerations = (): TurnGeneration[] => [];

function deriveVerification(
  requested: IdentityValues | undefined,
  observed: IdentityValues | undefined,
): Agent["verification"] {
  if (requested === undefined || observed === undefined) return "unverified";
  const keys: (keyof IdentityValues)[] = ["provider", "model", "effort"];
  for (const key of keys) {
    if (requested[key] !== undefined && observed[key] !== undefined && requested[key] !== observed[key]) {
      return "mismatch";
    }
  }
  return "verified";
}

function emptyAgent(input: {
  agentId: string;
  agentSessionId: string;
  sourceThreadId: string;
  sourceKind: Agent["sourceKind"];
  role: Agent["role"];
  nickname?: string;
  forkedFromAgentId?: string;
  lifecycle?: Agent["lifecycle"];
  cliVersion?: string;
  observedAt: Timestamp;
}): Agent {
  return AgentSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    agentId: input.agentId,
    agentSessionId: input.agentSessionId,
    sourceThreadId: input.sourceThreadId,
    sourceKind: input.sourceKind,
    role: input.role,
    ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
    ...(input.forkedFromAgentId === undefined ? {} : { forkedFromAgentId: input.forkedFromAgentId }),
    lifecycle: input.lifecycle ?? "pending",
    verification: "unverified",
    identityEvidenceIds: emptyIdentityEvidenceIds(),
    turnGenerations: emptyTurnGenerations(),
    ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });
}

function findAgent(state: ProjectionState, agentId: string): Agent | undefined {
  return state.agents.find((agent) => agent.agentId === agentId);
}

function findEdgeForChild(state: ProjectionState, childAgentId: string): AgentEdge | undefined {
  return state.edges.find((edge) => edge.childAgentId === childAgentId && edge.state === "verified");
}

function wouldCreateCycle(state: ProjectionState, parentAgentId: string, childAgentId: string): boolean {
  if (parentAgentId === childAgentId) return true;
  const seen = new Set<string>();
  let cursor: string | undefined = parentAgentId;
  while (cursor !== undefined) {
    if (cursor === childAgentId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = findAgent(state, cursor)?.parentAgentId;
  }
  return false;
}

function updateAgent(state: ProjectionState, agent: Agent): void {
  const index = state.agents.findIndex((candidate) => candidate.agentId === agent.agentId);
  if (index < 0) state.agents.push(agent);
  else state.agents[index] = agent;
}

function addQuarantine(
  state: ProjectionState,
  event: Partial<Pick<SanitizedEvent, "eventId" | "agentSessionId" | "connectionEpoch" | "ingestOrdinal" | "observedAt">>,
  reason: QuarantinedRecord["reason"],
  detail?: string,
): QuarantinedRecord {
  const record = QuarantinedRecordSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    quarantineId: `q:${event.eventId ?? "unknown"}:${event.ingestOrdinal ?? state.lastIngestOrdinal}`,
    ...(event.eventId === undefined ? {} : { eventId: event.eventId }),
    // Quarantine belongs to the projection that rejected the observation. Do
    // not persist a foreign session identifier into this session's records.
    agentSessionId: state.session.agentSessionId,
    reason: QuarantineReasonSchema.parse(reason),
    ...(detail === undefined ? {} : { detail }),
    connectionEpoch: event.connectionEpoch ?? state.lastConnectionEpoch,
    ingestOrdinal: event.ingestOrdinal ?? state.lastIngestOrdinal,
    observedAt: event.observedAt ?? state.session.updatedAt,
  });
  // A quarantine record is itself idempotent. Keep the first occurrence.
  if (!state.quarantined.some((candidate) => candidate.quarantineId === record.quarantineId)) {
    state.quarantined.push(record);
  }
  return record;
}

function ensureAgentForEvent(
  state: ProjectionState,
  event: Extract<SanitizedEvent, { agentId: string }>,
): Agent | undefined {
  const agent = findAgent(state, event.agentId);
  if (agent === undefined) {
    addQuarantine(state, event, "orphan", "event references an unknown agent");
  }
  return agent;
}

function addIdentityEvidence(
  state: ProjectionState,
  event: Extract<SanitizedEvent, { type: "identity.requested" | "identity.observed" | "model.rerouted" }>,
  kind: IdentityEvidence["kind"],
  source: IdentityEvidence["source"],
  values: IdentityValues,
  previousValues?: IdentityValues,
): void {
  const agent = ensureAgentForEvent(state, event);
  if (agent === undefined) return;
  const evidenceId = `${event.eventId}:identity`;
  if (state.identityEvidence.some((evidence) => evidence.evidenceId === evidenceId)) return;
  const evidence = IdentityEvidenceSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    evidenceId,
    agentSessionId: event.agentSessionId,
    agentId: event.agentId,
    sourceThreadId: event.sourceThreadId,
    kind,
    source,
    trustClass: kind === "requested" ? "requested" : event.authority === "reconciliation" ? "reconciled" : "runtime",
    values,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(previousValues === undefined ? {} : { previousValues }),
    observedAt: event.observedAt,
    connectionEpoch: event.connectionEpoch,
    ingestOrdinal: event.ingestOrdinal,
    evidenceHash: event.sanitizedPayloadHash ?? eventFingerprint(event),
  });
  state.identityEvidence.push(evidence);
  const nextAgent = clone(agent);
  nextAgent.identityEvidenceIds = [...nextAgent.identityEvidenceIds, evidenceId];
  if (kind === "requested") {
    // Requested identity is immutable evidence: a later spawn event does not
    // rewrite it. A conflicting event is still retained as evidence.
    if (nextAgent.requestedIdentity === undefined) nextAgent.requestedIdentity = values;
  } else {
    nextAgent.observedIdentity = values;
  }
  nextAgent.verification = deriveVerification(nextAgent.requestedIdentity, nextAgent.observedIdentity);
  nextAgent.updatedAt = now(event.observedAt);
  updateAgent(state, AgentSchema.parse(nextAgent));
}

function updateConnection(state: ProjectionState, event: Extract<SanitizedEvent, { type: "connection.state" }>): void {
  const capabilities = event.capabilities ?? state.connection.capabilities;
  const disconnected = event.status === "disconnected" || event.status === "revoked";
  state.connection = ConnectionStateSchema.parse({
    ...state.connection,
    schemaVersion: CONTRACT_VERSION,
    status: event.status,
    connectionEpoch: event.connectionEpoch,
    capabilities,
    ...(event.status === "connected" ? { connectedAt: event.observedAt } : {}),
    ...(disconnected ? { disconnectedAt: event.observedAt } : {}),
    lastIngestOrdinal: event.ingestOrdinal,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    verified: event.status === "connected" && capabilities.verified,
    updatedAt: event.observedAt,
  });
  state.session = AgentSessionSchema.parse({
    ...state.session,
    status:
      event.status === "revoked"
        ? "revoked"
        : event.status === "disconnected"
          ? "disconnected"
          : event.status === "unverified" || event.status === "incompatible"
            ? "unverified"
            : "active",
    connection: state.connection,
    capabilities,
    watermark: Math.max(state.session.watermark, event.ingestOrdinal),
    updatedAt: event.observedAt,
  });
}

function applyAgentUpsert(state: ProjectionState, event: Extract<SanitizedEvent, { type: "agent.upsert" }>): void {
  const existing = findAgent(state, event.agentId);
  if (existing !== undefined && existing.sourceThreadId !== event.sourceThreadId) {
    addQuarantine(state, event, "idempotency-conflict", "source thread identity changed");
    return;
  }
  const duplicateSource = state.agents.find(
    (candidate) => candidate.agentId !== event.agentId && candidate.sourceThreadId === event.sourceThreadId,
  );
  if (duplicateSource !== undefined) {
    addQuarantine(state, event, "idempotency-conflict", "source thread identity already belongs to another agent");
    return;
  }
  const agent =
    existing ??
    emptyAgent({
      agentId: event.agentId,
      agentSessionId: event.agentSessionId,
      sourceThreadId: event.sourceThreadId,
      sourceKind: event.sourceKind,
      role: event.role,
      ...(event.nickname === undefined ? {} : { nickname: event.nickname }),
      // Parent linkage is committed only by a validated spawn edge. Keeping a
      // source-provided parent here would make an unresolved/orphan parent
      // look verified before its edge evidence arrives.
      ...(event.forkedFromAgentId === undefined ? {} : { forkedFromAgentId: event.forkedFromAgentId }),
      ...(event.lifecycle === undefined ? {} : { lifecycle: event.lifecycle }),
      ...(event.cliVersion === undefined ? {} : { cliVersion: event.cliVersion }),
      observedAt: event.observedAt,
    });
  const next = clone(agent);
  next.updatedAt = event.observedAt;
  if (event.nickname !== undefined) next.nickname = event.nickname;
  if (event.lifecycle !== undefined) next.lifecycle = event.lifecycle;
  if (event.cliVersion !== undefined) next.cliVersion = event.cliVersion;
  // See the note above: the edge reducer is the sole writer of verified
  // parentAgentId.
  if (event.forkedFromAgentId !== undefined) next.forkedFromAgentId = event.forkedFromAgentId;
  updateAgent(state, AgentSchema.parse(next));
  if (event.sourceKind === "root" && state.session.rootAgentId === undefined) {
    state.session = AgentSessionSchema.parse({
      ...state.session,
      rootAgentId: event.agentId,
      rootSourceThreadId: event.sourceThreadId,
      watermark: Math.max(state.session.watermark, event.ingestOrdinal),
      updatedAt: event.observedAt,
    });
  }
}

function applySpawnEdge(state: ProjectionState, event: Extract<SanitizedEvent, { type: "edge.spawn" }>): void {
  const parent = findAgent(state, event.parentAgentId);
  const child = findAgent(state, event.childAgentId);
  const edgeBase = {
    schemaVersion: CONTRACT_VERSION,
    edgeId: event.edgeId,
    agentSessionId: event.agentSessionId,
    parentAgentId: event.parentAgentId,
    childAgentId: event.childAgentId,
    sourceEventId: event.eventId,
    ...(event.sourceOperationId === undefined ? {} : { sourceOperationId: event.sourceOperationId }),
    connectionEpoch: event.connectionEpoch,
    ingestOrdinal: event.ingestOrdinal,
    observedAt: event.observedAt,
  };
  let stateValue: AgentEdge["state"] = "verified";
  let reason: AgentEdge["reason"];
  if (event.parentSessionId !== undefined && event.parentSessionId !== event.agentSessionId) {
    stateValue = "cross-session";
    reason = "cross-session";
  } else if (event.childSessionId !== undefined && event.childSessionId !== event.agentSessionId) {
    stateValue = "cross-session";
    reason = "cross-session";
  } else if (parent === undefined || child === undefined) {
    stateValue = "orphan";
    reason = "orphan";
  } else if (event.parentAgentId === event.childAgentId || wouldCreateCycle(state, event.parentAgentId, event.childAgentId)) {
    stateValue = "cycle";
    reason = "cycle";
  } else {
    const current = findEdgeForChild(state, event.childAgentId);
    if (current !== undefined && current.parentAgentId !== event.parentAgentId) {
      stateValue = "duplicate-parent";
      reason = "duplicate-parent";
    }
  }
  const edge = AgentEdgeSchema.parse({ ...edgeBase, state: stateValue, ...(reason === undefined ? {} : { reason }) });
  const existing = state.edges.find((candidate) => candidate.edgeId === event.edgeId);
  if (
    existing !== undefined &&
    (existing.parentAgentId !== edge.parentAgentId || existing.childAgentId !== edge.childAgentId)
  ) {
    addQuarantine(state, event, "idempotency-conflict", "edge id reused with a different parent or child");
    return;
  }
  if (existing === undefined) state.edges.push(edge);
  else state.edges[state.edges.indexOf(existing)] = edge;
  if (stateValue === "verified" && child !== undefined) {
    const nextChild = clone(child);
    nextChild.parentAgentId = event.parentAgentId;
    nextChild.updatedAt = event.observedAt;
    updateAgent(state, AgentSchema.parse(nextChild));
  } else if (reason !== undefined) {
    addQuarantine(state, event, reason, `spawn edge ${stateValue}`);
  }
}

function applyTurnStarted(state: ProjectionState, event: Extract<SanitizedEvent, { type: "turn.started" }>): void {
  const agent = ensureAgentForEvent(state, event);
  if (agent === undefined) return;
  const next = clone(agent);
  const previous = next.turnGenerations.filter((turn: TurnGeneration) => turn.turnId === event.turnId);
  const active = previous.find((turn: TurnGeneration) => turn.status === "started" || turn.status === "active");
  if (active !== undefined) {
    addQuarantine(state, event, "idempotency-conflict", "turn started twice without a terminal event");
    return;
  }
  const generation = previous.reduce((maximum: number, turn: TurnGeneration) => Math.max(maximum, turn.generation), 0) + 1;
  const turn = TurnGenerationSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    generation,
    sourceThreadId: event.sourceThreadId,
    turnId: event.turnId,
    status: "started",
    startedAt: event.observedAt,
    connectionEpoch: event.connectionEpoch,
    startIngestOrdinal: event.ingestOrdinal,
  });
  next.turnGenerations.push(turn);
  next.currentTurnId = event.turnId;
  next.currentTurnGeneration = generation;
  next.lifecycle = "active";
  next.updatedAt = event.observedAt;
  next.startedAt ??= event.observedAt;
  updateAgent(state, AgentSchema.parse(next));
}

function applyTurnTerminal(state: ProjectionState, event: Extract<SanitizedEvent, { type: "turn.completed" | "turn.failed" | "turn.interrupted" }>): void {
  const agent = ensureAgentForEvent(state, event);
  if (agent === undefined) return;
  const next = clone(agent);
  const index = next.turnGenerations.findIndex(
    (turn: TurnGeneration) => turn.turnId === event.turnId && (turn.status === "started" || turn.status === "active"),
  );
  if (index < 0) {
    addQuarantine(state, event, "orphan", "terminal turn has no active generation");
    return;
  }
  const status = event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "interrupted";
  next.turnGenerations[index] = TurnGenerationSchema.parse({
    ...next.turnGenerations[index],
    status,
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    endedAt: event.observedAt,
    endIngestOrdinal: event.ingestOrdinal,
  });
  if (next.currentTurnId === event.turnId && next.currentTurnGeneration === next.turnGenerations[index].generation) {
    delete next.currentTurnId;
    delete next.currentTurnGeneration;
  }
  // A terminal turn does not terminate the thread/children. The thread may
  // issue another generation or become active again after reconciliation.
  next.lifecycle = "idle";
  next.updatedAt = event.observedAt;
  updateAgent(state, AgentSchema.parse(next));
}

function applyEventBody(state: ProjectionState, event: SanitizedEvent): void {
  switch (event.type) {
    case "agent.upsert":
      applyAgentUpsert(state, event);
      break;
    case "edge.spawn":
      applySpawnEdge(state, event);
      break;
    case "identity.requested":
      addIdentityEvidence(state, event, "requested", "collab.spawn", event.values);
      break;
    case "identity.observed":
      addIdentityEvidence(state, event, "observed", event.source, event.values);
      break;
    case "model.rerouted":
      addIdentityEvidence(state, event, "observed", "model.rerouted", event.to, event.from);
      break;
    case "turn.started":
      applyTurnStarted(state, event);
      break;
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted":
      applyTurnTerminal(state, event);
      break;
    case "thread.status.changed": {
      const agent = ensureAgentForEvent(state, event);
      if (agent !== undefined) {
        const next = clone(agent);
        next.lifecycle = event.status;
        next.updatedAt = event.observedAt;
        updateAgent(state, AgentSchema.parse(next));
      }
      break;
    }
    case "connection.state":
      updateConnection(state, event);
      break;
    case "snapshot.reconciled":
      state.session = AgentSessionSchema.parse({
        ...state.session,
        watermark: Math.max(state.session.watermark, event.snapshotWatermark, event.ingestOrdinal),
        updatedAt: event.observedAt,
      });
      break;
    default:
      // The discriminated union is closed. This branch protects future code
      // from accidentally persisting an opaque unknown event.
      break;
  }
}

function initialConnection(session: AgentSession): ConnectionState {
  return ConnectionStateSchema.parse(session.connection);
}

export function createProjection(sessionInput: AgentSession, options: ProjectionOptions = {}): ProjectionState {
  const session = AgentSessionSchema.parse(sessionInput);
  const agents = (options.agents ?? []).map((agent) => AgentSchema.parse(agent));
  const edges = (options.edges ?? []).map((edge) => AgentEdgeSchema.parse(edge));
  const identityEvidence = (options.identityEvidence ?? []).map((evidence) => IdentityEvidenceSchema.parse(evidence));
  const quarantined = (options.quarantined ?? []).map((record) => QuarantinedRecordSchema.parse(record));
  const lastIngestOrdinal = IngestOrdinalSchema.parse(options.lastIngestOrdinal ?? session.watermark);
  return {
    schemaVersion: CONTRACT_VERSION,
    session,
    connection: initialConnection(session),
    agents,
    edges,
    identityEvidence,
    quarantined,
    lastIngestOrdinal,
    lastConnectionEpoch: session.connection.connectionEpoch,
    appliedEventFingerprints: {},
    appliedIdempotency: {},
    revision: 0,
  };
}

/** Validate a candidate and discard unknown fields/values at the boundary. */
export function sanitizeEvent(candidate: unknown): SanitizedEvent {
  return SanitizedEventSchema.parse(candidate);
}

export function applyEvent(stateInput: ProjectionState, candidate: unknown): ReductionResult {
  const state = clone(stateInput);
  const parsed = SanitizedEventSchema.safeParse(candidate);
  if (!parsed.success) {
    const fallback: Record<string, unknown> =
      candidate !== null && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
    const fallbackSession =
      typeof fallback.agentSessionId === "string" && fallback.agentSessionId.trim().length > 0
        ? fallback.agentSessionId.trim()
        : state.session.agentSessionId;
    const fallbackEpoch =
      typeof fallback.connectionEpoch === "string" && fallback.connectionEpoch.trim().length > 0
        ? fallback.connectionEpoch.trim()
        : state.lastConnectionEpoch;
    const fallbackOrdinal =
      typeof fallback.ingestOrdinal === "number" && Number.isInteger(fallback.ingestOrdinal) && fallback.ingestOrdinal >= 0
        ? fallback.ingestOrdinal
        : state.lastIngestOrdinal;
    const fallbackObservedAt =
      typeof fallback.observedAt === "string" && TimestampSchema.safeParse(fallback.observedAt).success
        ? fallback.observedAt
        : state.session.updatedAt;
    const event = {
      agentSessionId: fallbackSession,
      connectionEpoch: fallbackEpoch,
      ingestOrdinal: fallbackOrdinal,
      observedAt: fallbackObservedAt,
      ...(typeof fallback.eventId === "string" && fallback.eventId.trim().length > 0 && fallback.eventId.length <= 256
        ? { eventId: fallback.eventId.trim() }
        : {}),
    } as const;
    const quarantined = addQuarantine(state, event, "invalid-schema", "event failed the versioned sanitized schema");
    state.revision += 1;
    return { state, accepted: false, duplicate: false, quarantined };
  }
  const event = parsed.data;
  const fingerprint = eventFingerprint(event);
  const existingById = state.appliedEventFingerprints[event.eventId];
  if (existingById !== undefined) {
    if (existingById === fingerprint) return { state, accepted: false, duplicate: true };
    const quarantined = addQuarantine(state, event, "idempotency-conflict", "event id reused with different payload");
    state.revision += 1;
    return { state, accepted: false, duplicate: false, quarantined };
  }
  const existingByKey = state.appliedIdempotency[event.idempotencyKey];
  if (existingByKey !== undefined) {
    if (existingByKey === fingerprint) return { state, accepted: false, duplicate: true };
    const quarantined = addQuarantine(state, event, "idempotency-conflict", "idempotency key reused with different payload");
    state.revision += 1;
    return { state, accepted: false, duplicate: false, quarantined };
  }
  if (event.agentSessionId !== state.session.agentSessionId) {
    const quarantined = addQuarantine(state, event, "cross-session", "event session does not match projection session");
    state.revision += 1;
    return { state, accepted: false, duplicate: false, quarantined };
  }
  if (event.ingestOrdinal < state.lastIngestOrdinal) {
    const quarantined = addQuarantine(state, event, "out-of-order", "backend ingest ordinal moved backwards");
    state.revision += 1;
    return { state, accepted: false, duplicate: false, quarantined };
  }
  applyEventBody(state, event);
  state.appliedEventFingerprints[event.eventId] = fingerprint;
  state.appliedIdempotency[event.idempotencyKey] = fingerprint;
  state.lastIngestOrdinal = Math.max(state.lastIngestOrdinal, event.ingestOrdinal);
  state.lastConnectionEpoch = event.connectionEpoch;
  state.session = AgentSessionSchema.parse({
    ...state.session,
    watermark: Math.max(state.session.watermark, event.ingestOrdinal),
    updatedAt: event.observedAt,
  });
  state.connection = ConnectionStateSchema.parse({
    ...state.connection,
    lastIngestOrdinal: Math.max(state.connection.lastIngestOrdinal ?? 0, event.ingestOrdinal),
    connectionEpoch: event.connectionEpoch,
    updatedAt: event.observedAt,
  });
  state.revision += 1;
  return { state, accepted: true, duplicate: false };
}

/**
 * Build the same projection regardless of caller order by sorting the
 * backend's observed arrival ordinal (with event id as a deterministic tie
 * breaker). The source app-server cursor is deliberately not inferred.
 */
export function projectEvents(sessionInput: AgentSession, candidates: readonly unknown[]): ProjectionState {
  const parsed = candidates.map((candidate) => sanitizeEvent(candidate));
  const ordered = [...parsed].sort((left, right) => left.ingestOrdinal - right.ingestOrdinal || left.eventId.localeCompare(right.eventId));
  let state = createProjection(sessionInput);
  for (const event of ordered) {
    const result = applyEvent(state, event);
    state = result.state;
  }
  return state;
}

export function projectionToSnapshot(stateInput: ProjectionState, snapshotId = `snapshot:${stateInput.revision}`): Snapshot {
  const state = stateInput;
  return SnapshotSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    snapshotId,
    agentSessionId: state.session.agentSessionId,
    watermark: state.lastIngestOrdinal,
    generatedAt: state.session.updatedAt,
    session: state.session,
    agents: state.agents,
    edges: state.edges,
    identityEvidence: state.identityEvidence,
    connection: state.connection,
    capabilities: state.connection.capabilities,
    quarantined: state.quarantined,
  });
}

export const snapshotFromProjection = projectionToSnapshot;

/** Apply a validated reconciliation snapshot without importing raw payloads. */
export function applySnapshot(stateInput: ProjectionState, snapshotInput: Snapshot): ProjectionState {
  const state = clone(stateInput);
  const snapshot = SnapshotSchema.parse(snapshotInput);
  if (snapshot.agentSessionId !== state.session.agentSessionId || snapshot.session.agentSessionId !== state.session.agentSessionId) {
    addQuarantine(
      state,
      {
        agentSessionId: snapshot.agentSessionId,
        connectionEpoch: snapshot.connection.connectionEpoch,
        ingestOrdinal: snapshot.watermark,
        observedAt: snapshot.generatedAt,
      },
      "cross-session",
      "snapshot session does not match projection session",
    );
    return state;
  }
  state.session = snapshot.session;
  state.connection = snapshot.connection;
  state.agents = snapshot.agents;
  state.edges = snapshot.edges;
  state.identityEvidence = snapshot.identityEvidence;
  state.quarantined = snapshot.quarantined;
  state.lastIngestOrdinal = Math.max(state.lastIngestOrdinal, snapshot.watermark);
  state.lastConnectionEpoch = snapshot.connection.connectionEpoch;
  state.revision += 1;
  return state;
}

export const reconcileSnapshot = applySnapshot;
export const reduceProjection = applyEvent;
export const reduce = applyEvent;
