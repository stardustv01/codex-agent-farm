import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type LineHandler = (line: string) => void | Promise<void>;
export type ErrorHandler = (error: Error) => void | Promise<void>;

/** A newline-delimited JSON transport. It contains no Codex method surface. */
export interface LineTransport {
  send(line: string): Promise<void>;
  subscribe(handler: LineHandler, onError?: ErrorHandler): () => void;
  close(): Promise<void> | void;
}

/**
 * In-memory fixture transport.  It is intentionally exported so unit tests
 * and host adapters can exercise the bridge without starting Codex.
 */
export class InMemoryStdioTransport implements LineTransport {
  readonly sentLines: string[] = [];
  private readonly handlers = new Set<{ handler: LineHandler; onError: ErrorHandler | undefined }>();
  private closed = false;
  private sendHandler: ((line: string) => void | Promise<void>) | undefined;

  constructor(options: { onSend?: (line: string) => void | Promise<void> } = {}) {
    this.sendHandler = options.onSend;
  }

  setOnSend(handler: (line: string) => void | Promise<void>): void {
    this.sendHandler = handler;
  }

  async send(line: string): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    this.sentLines.push(line);
    await this.sendHandler?.(line);
  }

  subscribe(handler: LineHandler, onError?: ErrorHandler): () => void {
    const entry = { handler, onError };
    this.handlers.add(entry);
    return () => this.handlers.delete(entry);
  }

  async pushLine(line: string): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      [...this.handlers].map(async ({ handler, onError }) => {
        try {
          await handler(line);
        } catch (error) {
          const safeError = error instanceof Error ? error : new Error('transport handler failed');
          await onError?.(safeError);
        }
      }),
    );
  }

  async fail(error = new Error('transport failed')): Promise<void> {
    await Promise.all(
      [...this.handlers].map(async ({ onError }) => {
        await onError?.(error);
      }),
    );
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
  }
}

/**
 * Adapter for the supported app-server's stdin/stdout streams.  stderr is
 * deliberately not consumed here; the launcher below drains it without
 * logging so raw diagnostics never enter the bridge event stream.
 */
export class NodeStdioTransport implements LineTransport {
  private readonly reader: Interface;
  private readonly handlers = new Set<{ handler: LineHandler; onError: ErrorHandler | undefined }>();
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', (line: string) => {
      void Promise.all(
        [...this.handlers].map(async ({ handler, onError }) => {
          try {
            await handler(line);
          } catch (error) {
            const safeError = error instanceof Error ? error : new Error('transport handler failed');
            await onError?.(safeError);
          }
        }),
      );
    });
    this.reader.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      const error = new Error('stdio transport closed');
      void Promise.all([...this.handlers].map(async ({ onError }) => onError?.(error)));
    });
  }

  async send(line: string): Promise<void> {
    if (this.closed) throw new Error('transport closed');
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        this.output.off('error', onError);
        reject(new Error('stdio write failed'));
      };
      this.output.once('error', onError);
      this.output.write(`${line}\n`, () => {
        this.output.off('error', onError);
        resolve();
      });
    });
  }

  subscribe(handler: LineHandler, onError?: ErrorHandler): () => void {
    const entry = { handler, onError };
    this.handlers.add(entry);
    return () => this.handlers.delete(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.reader.close();
  }
}

export interface SpawnedStdioAppServer {
  readonly process: ChildProcessWithoutNullStreams;
  readonly transport: NodeStdioTransport;
}

/**
 * Launch a caller-selected supported local app-server over stdio.
 *
 * This helper never sends a request and never exposes process stderr.  The
 * caller remains responsible for selecting the installed supported binary and
 * collecting its local fingerprint for the adapter gate.
 */
export function spawnStdioAppServer(options: {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): SpawnedStdioAppServer {
  if (!options.executable || options.executable.includes('\0')) throw new Error('invalid app-server executable');
  const child = spawn(options.executable, [...(options.args ?? ['app-server'])], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Drain stderr but never print or retain it.  Stderr can contain prompts,
  // paths, command output, or other values excluded by the privacy contract.
  child.stderr.resume();
  const transport = new NodeStdioTransport(child.stdout, child.stdin);
  child.once('exit', () => transport.close());
  child.once('error', () => transport.close());
  return { process: child, transport };
}
