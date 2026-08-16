import {
  type NormalizedEvent,
  type SanitizedCollaboration,
  type SanitizedItem,
  type SanitizedSubagentActivity,
  type SanitizedThreadSettings,
} from './types.js';
import { minimizeItem } from './minimizer.js';

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && OPAQUE_ID.test(value) ? value : undefined;
}

function version(value: unknown): boolean {
  return value === undefined || value === 1;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // App-server timestamps are Unix seconds today, while older adapters
    // supplied milliseconds. Accept both explicit wire representations.
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value) : undefined;
}

function turnStatus(value: unknown): NonNullable<NormalizedEvent['status']> {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'started':
      return 'started';
    case 'active':
    case 'running':
    case 'in_progress':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'interrupted':
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'interrupted';
    case 'idle':
      return 'idle';
    default:
      return 'unknown';
  }
}

function lifecycleStatus(value: unknown): NonNullable<NormalizedEvent['status']> {
  if (isRecord(value)) return lifecycleStatus(value.type);
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'idle':
    case 'ready':
      return 'idle';
    case 'active':
    case 'running':
    case 'working':
      return 'active';
    case 'completed':
    case 'complete':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'interrupted':
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

function collaboration(params: Record<string, unknown>): SanitizedCollaboration | undefined {
  return minimizeItem({ type: 'collabAgentToolCall', ...params })?.collaboration;
}

function activity(params: Record<string, unknown>): SanitizedSubagentActivity | undefined {
  return minimizeItem({ type: 'subagentActivity', ...params })?.subagentActivity;
}

function settings(params: Record<string, unknown>): SanitizedThreadSettings | undefined {
  return minimizeItem({ type: 'threadSettings', ...params })?.effectiveSettings;
}

function reroute(params: Record<string, unknown>): NormalizedEvent['modelRerouted'] {
  return minimizeItem({ type: 'modelRerouted', ...params })?.modelRerouted;
}

export type NotificationNormalization =
  | { readonly accepted: true; readonly event: NormalizedEvent }
  | {
      readonly accepted: false;
      readonly reason: 'invalid-notification' | 'unsupported-notification' | 'unsupported-version' | 'missing-source-thread';
    };

/**
 * Normalize only version-1 lifecycle notifications. Unknown methods, fields,
 * and values are discarded before an event leaves this process.
 */
export function normalizeNotification(raw: unknown): NotificationNormalization {
  const notification = object(raw);
  if (!notification || typeof notification.method !== 'string' || !notification.method || !version(notification.version)) {
    return { accepted: false, reason: notification && notification.version !== undefined ? 'unsupported-version' : 'invalid-notification' };
  }
  const params = object(notification.params);
  if (!params) return { accepted: false, reason: 'invalid-notification' };
  if (!version(params.version)) return { accepted: false, reason: 'unsupported-version' };
  const turn = object(params.turn);
  const sourceThreadId = id(params.threadId ?? params.sourceThreadId);
  if (!sourceThreadId) return { accepted: false, reason: 'missing-source-thread' };
  const sourceTurnId = id(params.turnId ?? params.sourceTurnId ?? turn?.id);
  const sourceItemId = id(params.itemId ?? params.sourceItemId);
  const observedAt = timestamp(params.observedAt ?? params.timestamp ?? params.changedAt);
  const startedAt = timestamp(params.startedAt ?? params.startTime ?? turn?.startedAt);
  const completedAt = timestamp(params.completedAt ?? params.endTime ?? turn?.completedAt);
  const durationMs = duration(params.durationMs ?? params.duration ?? turn?.durationMs);
  let event: NormalizedEvent | undefined;
  switch (notification.method) {
    case 'turn/started':
      event = {
        version: 1,
        kind: 'turn.started',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        status: 'started',
      };
      break;
    case 'turn/completed':
      event = {
        version: 1,
        kind: 'turn.completed',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        status: turnStatus(params.status ?? params.state ?? turn?.status),
      };
      break;
    case 'item/started':
    case 'item/completed': {
      const item = minimizeItem(params.item ?? params);
      event = {
        version: 1,
        kind: notification.method === 'item/started' ? 'item.started' : 'item.completed',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(item === undefined ? {} : { item }),
        ...(params.status === undefined ? {} : { status: turnStatus(params.status) }),
      };
      break;
    }
    case 'thread/status/changed':
      event = {
        version: 1,
        kind: 'thread.status.changed',
        sourceThreadId,
        ...(observedAt === undefined ? {} : { observedAt }),
        status: lifecycleStatus(params.status ?? params.state),
      };
      break;
    case 'collabAgentToolCall':
    case 'collab/agent-tool-call': {
      const safe = collaboration(params);
      if (!safe) return { accepted: false, reason: 'invalid-notification' };
      event = {
        version: 1,
        kind: 'collaboration.observed',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(safe.status === undefined ? {} : { status: safe.status }),
        collaboration: safe,
      };
      break;
    }
    case 'subagent/activity':
    case 'subagent/started':
    case 'subagent/completed': {
      const safe = activity(params);
      if (!safe) return { accepted: false, reason: 'invalid-notification' };
      event = {
        version: 1,
        kind: 'subagent.activity',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(sourceItemId === undefined ? {} : { sourceItemId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(safe.status === undefined ? {} : { status: safe.status }),
        subagentActivity: safe,
      };
      break;
    }
    case 'thread/settings/changed':
    case 'thread/settings': {
      const safe = settings(params);
      if (!safe) return { accepted: false, reason: 'invalid-notification' };
      event = {
        version: 1,
        kind: 'thread.settings.changed',
        sourceThreadId,
        ...(observedAt === undefined ? {} : { observedAt }),
        effectiveSettings: safe,
      };
      break;
    }
    case 'model/rerouted': {
      const safe = reroute(params);
      if (!safe) return { accepted: false, reason: 'invalid-notification' };
      event = {
        version: 1,
        kind: 'model.rerouted',
        sourceThreadId,
        ...(sourceTurnId === undefined ? {} : { sourceTurnId }),
        ...(observedAt === undefined ? {} : { observedAt }),
        modelRerouted: safe,
      };
      break;
    }
    default:
      return { accepted: false, reason: 'unsupported-notification' };
  }
  return event === undefined ? { accepted: false, reason: 'invalid-notification' } : { accepted: true, event };
}
