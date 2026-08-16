import { sha256Text, stableStringify } from './gate.js';
import type { ObservationDecision, ObservationEnvelope, NormalizedEvent, ProjectionCorrection } from './types.js';

function eventKey(event: NormalizedEvent): string {
  const payload = Object.fromEntries(Object.entries({
    method: event.kind,
    sourceThreadId: event.sourceThreadId,
    sourceTurnId: event.sourceTurnId,
    sourceItemId: event.sourceItemId,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    observedAt: event.observedAt,
  }).filter(([, value]) => value !== undefined));
  return stableStringify(payload);
}

function eventHash(event: NormalizedEvent): string {
  return sha256Text(stableStringify(event));
}

/** Idempotency ledger for already-minimized events. */
export class ObservationLedger {
  private readonly entries = new Map<string, ObservationEnvelope>();
  private readonly conflicts: Array<{ readonly key: string; readonly existingHash: string; readonly incomingHash: string; readonly connectionEpoch: string; readonly ingestOrdinal: number }> = [];

  accept(input: { readonly connectionEpoch: string; readonly ingestOrdinal: number; readonly event: NormalizedEvent }): ObservationDecision {
    if (!Number.isSafeInteger(input.ingestOrdinal) || input.ingestOrdinal < 0) {
      throw new RangeError('invalid ingest ordinal');
    }
    const key = eventKey(input.event);
    const sanitizedPayloadHash = eventHash(input.event);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.sanitizedPayloadHash === sanitizedPayloadHash) return { kind: 'duplicate', key };
      this.conflicts.push({ key, existingHash: previous.sanitizedPayloadHash, incomingHash: sanitizedPayloadHash, connectionEpoch: input.connectionEpoch, ingestOrdinal: input.ingestOrdinal });
      return { kind: 'conflict', key, existingHash: previous.sanitizedPayloadHash, incomingHash: sanitizedPayloadHash };
    }
    const envelope: ObservationEnvelope = {
      connectionEpoch: input.connectionEpoch,
      ingestOrdinal: input.ingestOrdinal,
      key,
      sanitizedPayloadHash,
      event: input.event,
    };
    this.entries.set(key, envelope);
    return { kind: 'accepted', envelope };
  }

  get size(): number {
    return this.entries.size;
  }

  values(): readonly ObservationEnvelope[] {
    return [...this.entries.values()];
  }

  quarantined(): readonly (typeof this.conflicts)[number][] {
    return [...this.conflicts];
  }
}

export interface SnapshotPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface PaginationOptions {
  readonly maxPages?: number;
  readonly maxItems?: number;
}

export class PaginationError extends Error {
  readonly code: 'PAGE_LIMIT' | 'ITEM_LIMIT' | 'CURSOR_LOOP' | 'INVALID_PAGE';

  constructor(code: PaginationError['code']) {
    super(code);
    this.name = 'PaginationError';
    this.code = code;
  }
}

/** Fetch every page into memory; no watermark is committed until this passes. */
export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<SnapshotPage<T>>,
  options: PaginationOptions = {},
): Promise<readonly T[]> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 1_000, 10_000));
  const maxItems = Math.max(1, Math.min(options.maxItems ?? 100_000, 1_000_000));
  const result: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    if (!page || !Array.isArray(page.items)) throw new PaginationError('INVALID_PAGE');
    result.push(...page.items);
    if (result.length > maxItems) throw new PaginationError('ITEM_LIMIT');
    const next = page.nextCursor;
    if (next === undefined) return result;
    if (typeof next !== 'string' || next.length === 0 || next.length > 512) throw new PaginationError('INVALID_PAGE');
    if (seenCursors.has(next)) throw new PaginationError('CURSOR_LOOP');
    seenCursors.add(next);
    cursor = next;
  }
  throw new PaginationError('PAGE_LIMIT');
}

export interface SnapshotReconciliation<T> {
  readonly snapshot: readonly T[];
  readonly watermark: string;
  readonly corrections: readonly ProjectionCorrection<T>[];
}

/**
 * Compare a fully validated snapshot with the current projection.  Caller
 * commits the returned snapshot/watermark atomically; a failed page fetch never
 * changes either value.
 */
export function reconcileSnapshot<T>(options: {
  readonly current: ReadonlyMap<string, T>;
  readonly snapshot: readonly T[];
  readonly keyOf: (value: T) => string;
  readonly watermark: string;
  readonly source?: string;
  readonly equals?: (left: T, right: T) => boolean;
}): SnapshotReconciliation<T> {
  const source = options.source ?? 'thread/list+thread/read';
  const equals = options.equals ?? ((left, right) => stableStringify(left) === stableStringify(right));
  const incoming = new Map<string, T>();
  const corrections: ProjectionCorrection<T>[] = [];
  for (const item of options.snapshot) {
    const key = options.keyOf(item);
    if (incoming.has(key)) throw new Error('duplicate snapshot key');
    incoming.set(key, item);
    const previous = options.current.get(key);
    if (previous !== undefined && !equals(previous, item)) {
      corrections.push({ type: 'projection.corrected', authority: 'reconciliation', source, key, previous, current: item });
    } else if (previous === undefined) {
      corrections.push({ type: 'projection.corrected', authority: 'reconciliation', source, key, current: item });
    }
  }
  for (const [key, previous] of options.current) {
    if (!incoming.has(key)) corrections.push({ type: 'projection.corrected', authority: 'reconciliation', source, key, previous });
  }
  return { snapshot: [...incoming.values()], watermark: options.watermark, corrections };
}

export { eventKey as canonicalObservationKey, eventHash as sanitizedEventHash };
