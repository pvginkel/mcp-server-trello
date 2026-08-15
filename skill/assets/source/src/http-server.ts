import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { TrelloClient } from './trello-client.js';
import type { TrelloHealthEndpoints } from './health/health-endpoints.js';
import { createMcpServer } from './index.js';

/**
 * Resolved transport configuration. `transport` decides stdio vs HTTP; the
 * remaining fields only matter when `transport === 'http'`.
 */
export interface HttpConfig {
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Host header values accepted for DNS-rebinding protection. */
  allowedHosts: string[];
  /** Milliseconds a session may sit idle before it is closed; 0 disables reaping. */
  sessionIdleTimeoutMs: number;
  /**
   * Whether board/workspace selection may be held across calls. Off by default
   * under HTTP: one `TrelloClient` is shared by every session, so an active
   * board set by one client silently retargets another's unqualified calls.
   */
  ambientSelection: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Read transport config from the environment. Pure and side-effect free so it
 * can be unit tested with an injected env. Only `TRELLO_MCP_TRANSPORT=http`
 * opts into HTTP; anything else (including unset) keeps the stdio default.
 */
export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const transport = env.TRELLO_MCP_TRANSPORT?.trim().toLowerCase() === 'http' ? 'http' : 'stdio';
  const host = env.TRELLO_MCP_HTTP_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(env.TRELLO_MCP_HTTP_PORT);
  const token = env.TRELLO_MCP_HTTP_TOKEN?.trim() || undefined;
  const allowedHosts = env.TRELLO_MCP_HTTP_ALLOWED_HOSTS
    ? env.TRELLO_MCP_HTTP_ALLOWED_HOSTS.split(',')
        .map(h => h.trim())
        .filter(h => h.length > 0)
    : deriveAllowedHosts(host, port);

  const sessionIdleTimeoutMs = parseIdleTimeoutMs(env.TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT);
  const ambientSelection = parseAmbientSelection(
    env.TRELLO_MCP_AMBIENT_SELECTION,
    transport === 'stdio'
  );

  return { transport, host, port, token, allowedHosts, sessionIdleTimeoutMs, ambientSelection };
}

/**
 * Parse the ambient-selection override. Unset follows the transport, which is
 * the safe default in both directions; the override exists for the single-user
 * HTTP deployment, where sharing one board across sessions is the point.
 */
function parseAmbientSelection(raw: string | undefined, fallback: boolean): boolean {
  if (!raw || raw.trim().length === 0) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`Invalid TRELLO_MCP_AMBIENT_SELECTION: "${raw}" (expected "on" or "off")`);
}

function parsePort(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TRELLO_MCP_HTTP_PORT: "${raw}" (expected 1-65535)`);
  }
  return port;
}

/** Parse the idle timeout, given in seconds; 0 turns session reaping off. */
function parseIdleTimeoutMs(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const seconds = Number.parseFloat(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `Invalid TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: "${raw}" ` +
        `(expected a number of seconds >= 0, where 0 disables reaping)`
    );
  }
  return Math.round(seconds * 1000);
}

/**
 * Derive the Host header allow-list from the bind address. Loopback binds also
 * accept the `localhost` alias for convenience. When binding to a wildcard/
 * external address, operators should set `TRELLO_MCP_HTTP_ALLOWED_HOSTS`
 * explicitly to the public host:port.
 */
function deriveAllowedHosts(host: string, port: number): string[] {
  const hosts = new Set<string>([`${host}:${port}`]);
  if (host === DEFAULT_HOST || host === '0.0.0.0' || host === 'localhost' || host === '::1') {
    hosts.add(`localhost:${port}`);
    hosts.add(`127.0.0.1:${port}`);
  }
  return [...hosts];
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

/**
 * Express middleware enforcing the optional bearer token. When no token is
 * configured (localhost default) it is a pass-through; otherwise requests
 * without an exact `Authorization: Bearer <token>` match are rejected with 401.
 */
export function createAuthMiddleware(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json(jsonRpcError(-32001, 'Unauthorized'));
      return;
    }
    next();
  };
}

/**
 * The live sessions, and the idle sweep that bounds them.
 *
 * The SDK hands out one transport — and, here, one MCP server — per session, and
 * releases it only when the client sends `DELETE /mcp`. The clients that actually
 * reach a deployed server (claude.ai's connector, Claude Code) never send it; they
 * just drop the socket. So a plain map is an unbounded leak: every session the
 * process has ever served stays resident, measured at ~1.15 MB each. Sweeping on
 * an idle deadline is what makes the table bounded.
 *
 * The clock is injectable so the sweep can be tested without waiting on real time.
 */
export class SessionRegistry {
  private readonly sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; lastSeen: number; holds: number }
  >();

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /** Look up a session, counting the lookup as activity. */
  get(id: string): StreamableHTTPServerTransport | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.lastSeen = this.now();
    return session.transport;
  }

  set(id: string, transport: StreamableHTTPServerTransport): void {
    this.sessions.set(id, { transport, lastSeen: this.now(), holds: 0 });
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Mark a session busy while a response of its own is open, and return the
   * release. A client parked on a long-lived SSE stream sends no requests for as
   * long as it is listening, so without this the sweep would cut it off mid-stream
   * precisely because it was working normally.
   */
  hold(id: string): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => {};
    session.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.holds--;
      session.lastSeen = this.now();
    };
  }

  /**
   * Close and forget every session idle past the timeout, returning how many went.
   * A zero timeout disables reaping and keeps the pre-sweep behaviour.
   */
  sweep(): number {
    if (this.idleTimeoutMs <= 0) return 0;
    const cutoff = this.now() - this.idleTimeoutMs;
    let closed = 0;
    for (const [id, session] of this.sessions) {
      if (session.holds > 0 || session.lastSeen > cutoff) continue;
      this.sessions.delete(id);
      closed++;
      void this.closeQuietly(session.transport);
    }
    return closed;
  }

  /** Close every session, for shutdown. */
  closeAll(): void {
    for (const { transport } of this.sessions.values()) void this.closeQuietly(transport);
    this.sessions.clear();
  }

  /**
   * `close()` fires the transport's `onclose`, which the SDK chains into the
   * per-session MCP server's teardown — so this releases both. A transport whose
   * peer has already vanished can reject; that is the case we are cleaning up
   * after, so it must not take the sweep down with it.
   */
  private async closeQuietly(transport: StreamableHTTPServerTransport): Promise<void> {
    try {
      await transport.close();
    } catch (error) {
      console.error('Error closing idle MCP session:', error);
    }
  }
}

/** Handle returned by {@link startHttpServer} for lifecycle management. */
export interface HttpServerHandle {
  server: Server;
  url: string;
  /** Number of sessions currently held open. */
  sessionCount: () => number;
  close: () => Promise<void>;
}

/**
 * How often the idle sweep runs. Capped so a short configured timeout is still
 * enforced promptly, and floored so it never becomes a busy loop.
 */
function sweepIntervalFor(idleTimeoutMs: number): number {
  return Math.max(100, Math.min(60_000, Math.floor(idleTimeoutMs / 2)));
}

/**
 * Start the Streamable HTTP server. Uses the canonical stateful SDK pattern:
 * one {@link StreamableHTTPServerTransport} (and one MCP server) per session,
 * keyed by the `Mcp-Session-Id` header, all sharing the single passed-in
 * {@link TrelloClient} so board/workspace selection persists across requests.
 *
 * Sessions are held in a {@link SessionRegistry}, which reaps them once idle —
 * without that the table only ever grows, since clients close the socket rather
 * than sending the `DELETE /mcp` that would release one.
 */
export function startHttpServer(
  client: TrelloClient,
  health: TrelloHealthEndpoints,
  config: HttpConfig
): Promise<HttpServerHandle> {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware(config.token));

  const transports = new SessionRegistry(config.sessionIdleTimeoutMs);

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId) {
          // Client referenced a session we don't know (expired/never existed).
          res.status(404).json(jsonRpcError(-32001, 'Session not found'));
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res
            .status(400)
            .json(jsonRpcError(-32000, 'Bad Request: no session and not an initialize request'));
          return;
        }

        // New session: fresh transport + fresh MCP server on the shared client.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: config.allowedHosts,
          onsessioninitialized: id => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          const id = transport!.sessionId;
          if (id) transports.delete(id);
        };

        // Ambient selection is read off the shared client, which `main` built
        // from this same config; passing it again here would only create a
        // second copy to drift.
        await createMcpServer(client, health).connect(transport);
      }

      // An established session stays busy for as long as this response is open;
      // a POST may be answered with an SSE stream that runs well past the request.
      if (sessionId) res.on('close', transports.hold(sessionId));

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP POST request:', error);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  });

  // GET resumes the session's SSE stream; DELETE terminates the session.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport || !sessionId) {
      res.status(404).json(jsonRpcError(-32001, 'Session not found'));
      return;
    }
    // The GET is the server->client stream; it is open, and the session active,
    // for as long as the client listens on it.
    res.on('close', transports.hold(sessionId));
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  // `unref` so an idle sweep never holds the process open on its own.
  const sweepTimer =
    config.sessionIdleTimeoutMs > 0
      ? setInterval(() => {
          const closed = transports.sweep();
          if (closed > 0) {
            console.error(`Reaped ${closed} idle MCP session(s); ${transports.size} still open`);
          }
        }, sweepIntervalFor(config.sessionIdleTimeoutMs))
      : undefined;
  sweepTimer?.unref();

  return new Promise<HttpServerHandle>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      const url = `http://${config.host}:${config.port}/mcp`;
      // stderr only: stdout is reserved for the stdio JSON-RPC stream.
      console.error(
        `Trello MCP server listening on ${url} (Streamable HTTP)` +
          (config.token ? ' [bearer auth enabled]' : '') +
          (config.sessionIdleTimeoutMs > 0
            ? ` [sessions reaped after ${config.sessionIdleTimeoutMs / 1000}s idle]`
            : ' [session reaping disabled]')
      );
      resolve({
        server,
        url,
        sessionCount: () => transports.size,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            if (sweepTimer) clearInterval(sweepTimer);
            transports.closeAll();
            server.close(err => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
    server.on('error', reject);
  });
}
