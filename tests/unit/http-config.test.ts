import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { readHttpConfig, createAuthMiddleware } from '../../src/http-server.js';

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
