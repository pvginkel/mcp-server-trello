import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TrelloHealthEndpoints } from '../../src/health/health-endpoints.js';
import { createTrelloClient } from '../../src/index.js';
import { readHttpConfig, startHttpServer, type HttpServerHandle } from '../../src/http-server.js';

/**
 * Boots the real Streamable HTTP server in-process (dummy creds, no live Trello
 * calls — `initialize`/`tools/list` never touch the API) and drives it with the
 * SDK client. This runs in CI: it verifies the transport, session management,
 * DNS-rebinding protection, and bearer auth without external dependencies.
 */

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '1.0.0' },
  },
};

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/**
 * Low-level POST via node:http so we can set the `Host` header — `fetch` treats
 * `Host` as a forbidden header and silently drops it, which would defeat the
 * DNS-rebinding test.
 */
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname, method: 'POST', headers },
      res => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function bootServer(
  env: NodeJS.ProcessEnv
): Promise<HttpServerHandle & { config: ReturnType<typeof readHttpConfig> }> {
  process.env.TRELLO_API_KEY = 'test-key';
  process.env.TRELLO_TOKEN = 'test-token';
  const client = createTrelloClient();
  const health = new TrelloHealthEndpoints(client);
  const config = readHttpConfig(env);
  return startHttpServer(client, health, config).then(handle => ({ ...handle, config }));
}

describe('Streamable HTTP transport (no auth)', () => {
  let handle: HttpServerHandle;
  let url: string;

  beforeAll(async () => {
    const port = await getFreePort();
    const booted = await bootServer({
      TRELLO_MCP_TRANSPORT: 'http',
      TRELLO_MCP_HTTP_HOST: '127.0.0.1',
      TRELLO_MCP_HTTP_PORT: String(port),
    });
    handle = booted;
    url = booted.url;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('completes an initialize + tools/list handshake via the SDK client', async () => {
    const client = new Client({ name: 'smoke-http', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);

    expect(transport.sessionId).toBeTruthy();

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map(t => t.name);
    expect(names).toContain('get_cards_by_list_id');
    expect(names).toContain('list_boards');

    await client.close();
  });

  it('rejects a POST with no session that is not an initialize request (400)', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown session id (404)', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'does-not-exist' },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(404);
  });

  it('blocks a spoofed Host header (DNS-rebinding protection)', async () => {
    const res = await rawPost(
      url,
      { ...MCP_HEADERS, Host: 'evil.example.com' },
      JSON.stringify(INIT_BODY)
    );
    expect(res.status).toBe(403);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });
});

describe('Streamable HTTP session reaping', () => {
  let handle: HttpServerHandle;
  let url: string;

  beforeAll(async () => {
    const port = await getFreePort();
    const booted = await bootServer({
      TRELLO_MCP_TRANSPORT: 'http',
      TRELLO_MCP_HTTP_HOST: '127.0.0.1',
      TRELLO_MCP_HTTP_PORT: String(port),
      // Sub-second so the sweep is observable in a test; production defaults to
      // 30 minutes.
      TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: '0.3',
    });
    handle = booted;
    url = booted.url;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('drops an idle session and answers 404 on its next request', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain, so the response closes and stops holding the session
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(handle.sessionCount()).toBe(1);

    // Idle past the timeout; the sweep runs at half of it.
    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(handle.sessionCount()).toBe(0);
    const after = await fetch(url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId as string },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(after.status).toBe(404);
  });
});

describe('Streamable HTTP transport (bearer auth)', () => {
  let handle: HttpServerHandle;
  let url: string;
  const TOKEN = 'super-secret-token';

  beforeAll(async () => {
    const port = await getFreePort();
    const booted = await bootServer({
      TRELLO_MCP_TRANSPORT: 'http',
      TRELLO_MCP_HTTP_HOST: '127.0.0.1',
      TRELLO_MCP_HTTP_PORT: String(port),
      TRELLO_MCP_HTTP_TOKEN: TOKEN,
    });
    handle = booted;
    url = booted.url;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('rejects a request without a bearer token (401)', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('accepts an initialize request with the correct bearer token', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});
