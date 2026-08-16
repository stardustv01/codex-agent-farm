import { randomUUID } from 'node:crypto';
import {
  assertAllowedOutboundMethod,
  validateOutboundParams,
} from './allowlist.js';
import { evaluateAdapterGate, type AdapterGateInput } from './gate.js';
import { normalizeNotification } from './events.js';
import { minimizeModelCatalog, minimizeThreadPage, minimizeThreadRead } from './minimizer.js';
import { readRolloutIdentityEvidence, readRolloutLocalDetail, type LocalRolloutDetail, type RolloutIdentityEvidence, type RolloutIdentityReaderOptions } from './rollout-evidence.js';
import type {
  AdapterGateResult,
  AllowedOutboundMethod,
  ConnectionFingerprint,
  JsonObject,
  JsonRpcResponse,
  JsonValue,
  NormalizedEvent,
  SanitizedModelCatalog,
  SanitizedThreadPage,
  SanitizedThreadRead,
} from './types.js';
import type { LineTransport } from './transport.js';

export class BridgeProtocolError extends Error {
  readonly code: 'MALFORMED_RESPONSE' | 'TRANSPORT_ERROR' | 'LINE_TOO_LARGE' | 'CLOSED';

  constructor(code: BridgeProtocolError['code']) {
    super(code.toLowerCase().replaceAll('_', ' '));
    this.name = 'BridgeProtocolError';
    this.code = code;
  }
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly safeCode: 'method_not_found' | 'invalid_request' | 'not_initialized' | 'permission_denied' | 'internal' | 'unknown';

  constructor(code: number) {
    super('Codex app-server request failed');
    this.name = 'AppServerRpcError';
    this.code = Number.isSafeInteger(code) ? code : -1;
    this.safeCode = code === -32601 ? 'method_not_found' : code === -32602 ? 'invalid_request' : code === -32002 ? 'not_initialized' : code === -32001 ? 'permission_denied' : code >= -32099 && code <= -32000 ? 'internal' : 'unknown';
  }
}

export class AdapterQuarantinedError extends Error {
  readonly gate: Extract<AdapterGateResult, { status: 'quarantined' }>;

  constructor(gate: Extract<AdapterGateResult, { status: 'quarantined' }>) {
    super(`Codex app-server adapter quarantined: ${gate.reason}`);
    this.name = 'AdapterQuarantinedError';
    this.gate = gate;
  }
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

export interface ConnectionInfo {
  readonly connectionEpoch: string;
  readonly gate: Extract<AdapterGateResult, { status: 'accepted' }>;
}

export interface ConnectOptions extends Omit<AdapterGateInput, 'fingerprint'> {
  readonly binaryPath?: string;
  readonly binarySha256?: string;
  readonly schemaHashes?: Readonly<Record<string, string>>;
  readonly initializeParams: JsonObject;
  readonly now?: () => Date;
}

export interface AppServerClientOptions {
  readonly connectionEpoch?: string;
  readonly maxLineBytes?: number;
  readonly rolloutIdentity?: RolloutIdentityReaderOptions;
  readonly onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  readonly onRejectedNotification?: (reason: string) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') ||
      typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) return false;
  if ('result' in value) return value.result !== undefined;
  if (!isRecord(value.error) || typeof value.error.code !== 'number') return false;
  return true;
}

/**
 * A read-only JSON-RPC app-server client.  `call` checks the method before
 * touching params or JSON.stringify, which is the mutation fail-closed gate.
 */
export class AppServerClient {
  readonly connectionEpoch: string;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly unsubscribe: () => void;
  private nextRequestId = 1;
  private closed = false;
  private readonly maxLineBytes: number;
  private readonly rolloutIdentityOptions: RolloutIdentityReaderOptions | undefined;
  private gateResult?: AdapterGateResult;

  constructor(private readonly transport: LineTransport, options: AppServerClientOptions = {}) {
    this.connectionEpoch = options.connectionEpoch ?? randomUUID();
    this.maxLineBytes = Math.max(1_024, Math.min(options.maxLineBytes ?? 1_048_576, 8 * 1_048_576));
    this.rolloutIdentityOptions = options.rolloutIdentity;
    this.unsubscribe = transport.subscribe(
      (line) => this.handleLine(line, options),
      (error) => this.handleTransportError(error),
    );
  }

  get gate(): AdapterGateResult | undefined {
    return this.gateResult;
  }

  async call<T extends JsonValue = JsonValue>(method: string, params?: unknown): Promise<T> {
    // This must remain the first operation: denied methods never inspect or
    // serialize their payload, even if the value is cyclic or sensitive.
    assertAllowedOutboundMethod(method);
    if (this.closed) throw new BridgeProtocolError('CLOSED');
    const safeParams = validateOutboundParams(method, params);
    const id = this.nextRequestId++;
    const request = { id, method, ...(safeParams === undefined ? {} : { params: safeParams }) };
    const line = JSON.stringify(request);
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) throw new BridgeProtocolError('LINE_TOO_LARGE');
    const result = new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.transport.send(line);
    } catch {
      this.pending.delete(id);
      throw new BridgeProtocolError('TRANSPORT_ERROR');
    }
    return (await result) as T;
  }

  async connect(options: ConnectOptions): Promise<ConnectionInfo> {
    const initResult = await this.call<JsonValue>('initialize', options.initializeParams);
    const reportedUserAgent = isRecord(initResult) && typeof initResult.userAgent === 'string' ? initResult.userAgent : '';
    const now = options.now ?? (() => new Date());
    const fingerprint: ConnectionFingerprint = {
      ...(options.binaryPath === undefined ? {} : { binaryPath: options.binaryPath }),
      ...(options.binarySha256 === undefined ? {} : { binarySha256: options.binarySha256 }),
      reportedUserAgent,
      schemaBundleSha256: options.schema.sha256,
      ...(options.schemaHashes === undefined ? {} : { schemaHashes: options.schemaHashes }),
      connectionTime: now().toISOString(),
    };
    const gateInput: AdapterGateInput = { fingerprint, schema: options.schema, testedAdapters: options.testedAdapters };
    const gate = evaluateAdapterGate(gateInput);
    this.gateResult = gate;
    if (gate.status !== 'accepted') {
      await this.close();
      throw new AdapterQuarantinedError(gate);
    }
    await this.sendInitializedNotification();
    return { connectionEpoch: this.connectionEpoch, gate };
  }

  private async sendInitializedNotification(): Promise<void> {
    // Codex app-server's initialized message is a notification: no id, params,
    // or response. Keep it behind the same outbound allowlist and size gate.
    assertAllowedOutboundMethod('initialized');
    if (this.closed) throw new BridgeProtocolError('CLOSED');
    validateOutboundParams('initialized', undefined);
    const line = JSON.stringify({ method: 'initialized' });
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) throw new BridgeProtocolError('LINE_TOO_LARGE');
    try {
      await this.transport.send(line);
    } catch {
      throw new BridgeProtocolError('TRANSPORT_ERROR');
    }
  }

  /** Read-only convenience methods that minimize before returning. */
  async listThreads(params: JsonObject = { useStateDbOnly: true }): Promise<SanitizedThreadPage> {
    const response = await this.call<JsonValue>('thread/list', params);
    const page = minimizeThreadPage(response);
    if (!page) throw new BridgeProtocolError('MALFORMED_RESPONSE');
    return page;
  }

  async readThread(params: JsonObject): Promise<SanitizedThreadRead> {
    const response = await this.call<JsonValue>('thread/read', params);
    const read = minimizeThreadRead(response);
    if (!read) throw new BridgeProtocolError('MALFORMED_RESPONSE');
    return read;
  }

  /**
   * Optionally derive bounded model/lineage evidence from a trusted rollout
   * file referenced by a raw thread/read response. This remains unavailable
   * until the adapter gate accepts the connection, and all failures collapse
   * to an identity-unavailable result.
   */
  async readRolloutIdentity(threadId: string): Promise<RolloutIdentityEvidence | undefined> {
    if (this.gateResult?.status !== 'accepted' || this.rolloutIdentityOptions === undefined || !/^[A-Za-z0-9._:-]{1,256}$/u.test(threadId)) {
      return undefined;
    }
    try {
      const response = await this.call<JsonValue>('thread/read', { threadId, includeTurns: true });
      return await readRolloutIdentityEvidence(response, threadId, this.rolloutIdentityOptions);
    } catch {
      return undefined;
    }
  }

  async readRolloutLocalDetail(threadId: string): Promise<LocalRolloutDetail | undefined> {
    if (this.gateResult?.status !== 'accepted' || this.rolloutIdentityOptions === undefined || !/^[A-Za-z0-9._:-]{1,256}$/u.test(threadId)) return undefined;
    try {
      const response = await this.call<JsonValue>('thread/read', { threadId, includeTurns: true });
      return await readRolloutLocalDetail(response, threadId, this.rolloutIdentityOptions);
    } catch { return undefined; }
  }

  async listModels(params: JsonObject = {}): Promise<SanitizedModelCatalog> {
    const response = await this.call<JsonValue>('model/list', params);
    const catalog = minimizeModelCatalog(response);
    if (!catalog) throw new BridgeProtocolError('MALFORMED_RESPONSE');
    return catalog;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const error = new BridgeProtocolError('CLOSED');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    await this.transport.close();
  }

  private handleLine(line: string, options: AppServerClientOptions): void {
    if (this.closed || Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      this.handleTransportError(new BridgeProtocolError('LINE_TOO_LARGE'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handleTransportError(new BridgeProtocolError('MALFORMED_RESPONSE'));
      return;
    }
    if (isResponse(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if ('error' in parsed) pending.reject(new AppServerRpcError(parsed.error.code));
      else pending.resolve(parsed.result);
      return;
    }
    const normalized = normalizeNotification(parsed);
    if (normalized.accepted) {
      void options.onEvent?.(normalized.event);
    } else {
      void options.onRejectedNotification?.(normalized.reason);
    }
  }

  private handleTransportError(_error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const safeError = _error instanceof BridgeProtocolError ? _error : new BridgeProtocolError('TRANSPORT_ERROR');
    for (const pending of this.pending.values()) pending.reject(safeError);
    this.pending.clear();
    void this.transport.close();
  }
}
