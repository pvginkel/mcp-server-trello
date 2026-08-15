import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readHttpConfig, createAuthMiddleware, SessionRegistry } from '../../src/http-server.js';

describe('readHttpConfig', () => {
  it('defaults to stdio with no env', () => {
    const config = readHttpConfig({});
    expect(config.transport).toBe('stdio');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.token).toBeUndefined();
  });

  it('selects http only when TRELLO_MCP_TRANSPORT=http (case/space tolerant)', () => {
    expect(readHttpConfig({ TRELLO_MCP_TRANSPORT: 'http' }).transport).toBe('http');
    expect(readHttpConfig({ TRELLO_MCP_TRANSPORT: '  HTTP ' }).transport).toBe('http');
    expect(readHttpConfig({ TRELLO_MCP_TRANSPORT: 'sse' }).transport).toBe('stdio');
    expect(readHttpConfig({ TRELLO_MCP_TRANSPORT: '' }).transport).toBe('stdio');
  });

  it('applies host/port/token overrides', () => {
    const config = readHttpConfig({
      TRELLO_MCP_TRANSPORT: 'http',
      TRELLO_MCP_HTTP_HOST: '0.0.0.0',
      TRELLO_MCP_HTTP_PORT: '8080',
      TRELLO_MCP_HTTP_TOKEN: 's3cret',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.token).toBe('s3cret');
  });

  describe('ambientSelection', () => {
    it('follows the transport when unset', () => {
      expect(readHttpConfig({}).ambientSelection).toBe(true);
      expect(readHttpConfig({ TRELLO_MCP_TRANSPORT: 'http' }).ambientSelection).toBe(false);
    });

    it('honours an explicit override in both directions', () => {
      expect(
        readHttpConfig({ TRELLO_MCP_TRANSPORT: 'http', TRELLO_MCP_AMBIENT_SELECTION: 'on' })
          .ambientSelection
      ).toBe(true);
      expect(readHttpConfig({ TRELLO_MCP_AMBIENT_SELECTION: 'off' }).ambientSelection).toBe(false);
    });

    it('is case/space tolerant, like the neighbouring parsers', () => {
      expect(readHttpConfig({ TRELLO_MCP_AMBIENT_SELECTION: '  OFF ' }).ambientSelection).toBe(
        false
      );
      expect(readHttpConfig({ TRELLO_MCP_AMBIENT_SELECTION: '' }).ambientSelection).toBe(true);
    });

    it('rejects anything that is not on or off', () => {
      expect(() => readHttpConfig({ TRELLO_MCP_AMBIENT_SELECTION: 'true' })).toThrow(
        /TRELLO_MCP_AMBIENT_SELECTION/
      );
      expect(() => readHttpConfig({ TRELLO_MCP_AMBIENT_SELECTION: '1' })).toThrow(
        /TRELLO_MCP_AMBIENT_SELECTION/
      );
    });
  });

  it('rejects an invalid port', () => {
    expect(() => readHttpConfig({ TRELLO_MCP_HTTP_PORT: 'abc' })).toThrow(/TRELLO_MCP_HTTP_PORT/);
    expect(() => readHttpConfig({ TRELLO_MCP_HTTP_PORT: '0' })).toThrow(/TRELLO_MCP_HTTP_PORT/);
    expect(() => readHttpConfig({ TRELLO_MCP_HTTP_PORT: '70000' })).toThrow(/TRELLO_MCP_HTTP_PORT/);
  });

  it('derives allowedHosts from a loopback bind (with localhost alias)', () => {
    const config = readHttpConfig({ TRELLO_MCP_HTTP_PORT: '3000' });
    expect(config.allowedHosts).toContain('127.0.0.1:3000');
    expect(config.allowedHosts).toContain('localhost:3000');
  });

  it('derives allowedHosts for a wildcard bind including loopback aliases', () => {
    const config = readHttpConfig({
      TRELLO_MCP_HTTP_HOST: '0.0.0.0',
      TRELLO_MCP_HTTP_PORT: '9000',
    });
    expect(config.allowedHosts).toContain('0.0.0.0:9000');
    expect(config.allowedHosts).toContain('localhost:9000');
    expect(config.allowedHosts).toContain('127.0.0.1:9000');
  });

  it('honors an explicit allowedHosts list, trimming entries', () => {
    const config = readHttpConfig({
      TRELLO_MCP_HTTP_ALLOWED_HOSTS: 'trello.example.com, mcp.internal:3000 ,',
    });
    expect(config.allowedHosts).toEqual(['trello.example.com', 'mcp.internal:3000']);
  });

  it('defaults the session idle timeout to 30 minutes', () => {
    expect(readHttpConfig({}).sessionIdleTimeoutMs).toBe(30 * 60 * 1000);
  });

  it('reads the session idle timeout in seconds, 0 disabling reaping', () => {
    expect(
      readHttpConfig({ TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: '90' }).sessionIdleTimeoutMs
    ).toBe(90_000);
    expect(readHttpConfig({ TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: '0' }).sessionIdleTimeoutMs).toBe(
      0
    );
  });

  it('rejects an invalid session idle timeout', () => {
    expect(() => readHttpConfig({ TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: 'never' })).toThrow(
      /TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT/
    );
    expect(() => readHttpConfig({ TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT: '-5' })).toThrow(
      /TRELLO_MCP_HTTP_SESSION_IDLE_TIMEOUT/
    );
  });
});

/**
 * A transport double that only records whether it was closed — enough to assert
 * that the sweep releases a session rather than merely forgetting it.
 */
function fakeTransport() {
  const state = { closed: 0 };
  const transport = {
    close: async () => {
      state.closed++;
    },
  } as unknown as StreamableHTTPServerTransport;
  return { transport, state };
}

describe('SessionRegistry', () => {
  /** A registry on a clock the test advances by hand. */
  function registry(idleTimeoutMs: number) {
    let now = 1_000_000;
    const reg = new SessionRegistry(idleTimeoutMs, () => now);
    return { reg, advance: (ms: number) => (now += ms) };
  }

  it('reaps a session left idle past the timeout, closing its transport', () => {
    const { reg, advance } = registry(60_000);
    const { transport, state } = fakeTransport();
    reg.set('a', transport);

    advance(59_000);
    expect(reg.sweep()).toBe(0);
    expect(reg.size).toBe(1);

    advance(2_000);
    expect(reg.sweep()).toBe(1);
    expect(reg.size).toBe(0);
    expect(state.closed).toBe(1);
    expect(reg.get('a')).toBeUndefined();
  });

  it('keeps a session alive while it is being used', () => {
    const { reg, advance } = registry(60_000);
    reg.set('a', fakeTransport().transport);

    for (let i = 0; i < 5; i++) {
      advance(50_000);
      expect(reg.get('a')).toBeDefined(); // the lookup itself counts as activity
      expect(reg.sweep()).toBe(0);
    }
    expect(reg.size).toBe(1);
  });

  it('never reaps a session holding an open response', () => {
    const { reg, advance } = registry(60_000);
    reg.set('a', fakeTransport().transport);
    const release = reg.hold('a');

    advance(10 * 60_000);
    expect(reg.sweep()).toBe(0);
    expect(reg.size).toBe(1);

    // Releasing counts as activity, so the clock restarts from there.
    release();
    advance(59_000);
    expect(reg.sweep()).toBe(0);
    advance(2_000);
    expect(reg.sweep()).toBe(1);
  });

  it('ignores a double release so the hold count cannot go negative', () => {
    const { reg, advance } = registry(60_000);
    reg.set('a', fakeTransport().transport);
    const release = reg.hold('a');
    const second = reg.hold('a');

    release();
    release();
    advance(120_000);
    expect(reg.sweep()).toBe(0); // `second` is still holding

    second();
    advance(120_000);
    expect(reg.sweep()).toBe(1);
  });

  it('holding an unknown session is a no-op', () => {
    const { reg } = registry(60_000);
    expect(() => reg.hold('nope')()).not.toThrow();
  });

  it('reaps nothing when the timeout is disabled', () => {
    const { reg, advance } = registry(0);
    const { transport, state } = fakeTransport();
    reg.set('a', transport);

    advance(365 * 24 * 60 * 60 * 1000);
    expect(reg.sweep()).toBe(0);
    expect(reg.size).toBe(1);
    expect(state.closed).toBe(0);
  });

  it('closeAll releases every session', () => {
    const { reg } = registry(60_000);
    const first = fakeTransport();
    const second = fakeTransport();
    reg.set('a', first.transport);
    reg.set('b', second.transport);

    reg.closeAll();
    expect(reg.size).toBe(0);
    expect(first.state.closed).toBe(1);
    expect(second.state.closed).toBe(1);
  });
});

/** Minimal Express req/res doubles for exercising the auth middleware. */
function mockReqRes(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  } as unknown as Response;
  return {
    req,
    res,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

describe('createAuthMiddleware', () => {
  it('passes through when no token is configured', () => {
    const mw = createAuthMiddleware(undefined);
    const { req, res, getStatus } = mockReqRes();
    let called = false;
    mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(getStatus()).toBeUndefined();
  });

  it('rejects requests without a bearer token (401)', () => {
    const mw = createAuthMiddleware('secret');
    const { req, res, getStatus } = mockReqRes();
    let called = false;
    mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(getStatus()).toBe(401);
  });

  it('rejects a wrong bearer token (401)', () => {
    const mw = createAuthMiddleware('secret');
    const { req, res, getStatus } = mockReqRes('Bearer nope');
    let called = false;
    mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(getStatus()).toBe(401);
  });

  it('accepts the correct bearer token', () => {
    const mw = createAuthMiddleware('secret');
    const { req, res, getStatus } = mockReqRes('Bearer secret');
    let called = false;
    mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(getStatus()).toBeUndefined();
  });
});
