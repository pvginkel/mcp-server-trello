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
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

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

  return { transport, host, port, token, allowedHosts };
}

function parsePort(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TRELLO_MCP_HTTP_PORT: "${raw}" (expected 1-65535)`);
  }
  return port;
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

/** Handle returned by {@link startHttpServer} for lifecycle management. */
export interface HttpServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the Streamable HTTP server. Uses the canonical stateful SDK pattern:
 * one {@link StreamableHTTPServerTransport} (and one MCP server) per session,
 * keyed by the `Mcp-Session-Id` header, all sharing the single passed-in
 * {@link TrelloClient} so board/workspace selection persists across requests.
 */
export function startHttpServer(
  client: TrelloClient,
  health: TrelloHealthEndpoints,
  config: HttpConfig
): Promise<HttpServerHandle> {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware(config.token));

  const transports = new Map<string, StreamableHTTPServerTransport>();

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

        await createMcpServer(client, health).connect(transport);
      }

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
    if (!transport) {
      res.status(404).json(jsonRpcError(-32001, 'Session not found'));
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  return new Promise<HttpServerHandle>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      const url = `http://${config.host}:${config.port}/mcp`;
      // stderr only: stdout is reserved for the stdio JSON-RPC stream.
      console.error(
        `Trello MCP server listening on ${url} (Streamable HTTP)` +
          (config.token ? ' [bearer auth enabled]' : '')
      );
      resolve({
        server,
        url,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const transport of transports.values()) {
              void transport.close();
            }
            transports.clear();
            server.close(err => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
    server.on('error', reject);
  });
}
