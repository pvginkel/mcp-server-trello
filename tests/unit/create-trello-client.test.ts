import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTrelloClient } from '../../src/index.js';
import { TrelloClient } from '../../src/trello-client.js';

const KEYS = ['TRELLO_API_KEY', 'TRELLO_TOKEN', 'TRELLO_BOARD_ID', 'TRELLO_ALLOWED_WORKSPACES'];

describe('createTrelloClient', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('throws when credentials are missing', () => {
    delete process.env.TRELLO_API_KEY;
    delete process.env.TRELLO_TOKEN;
    expect(() => createTrelloClient()).toThrow(/TRELLO_API_KEY and TRELLO_TOKEN/);
  });

  it('builds a client with credentials only', () => {
    process.env.TRELLO_API_KEY = 'k';
    process.env.TRELLO_TOKEN = 't';
    delete process.env.TRELLO_ALLOWED_WORKSPACES;
    expect(createTrelloClient()).toBeInstanceOf(TrelloClient);
  });

  it('parses the allowed-workspaces list (trimming and dropping blanks)', () => {
    process.env.TRELLO_API_KEY = 'k';
    process.env.TRELLO_TOKEN = 't';
    process.env.TRELLO_ALLOWED_WORKSPACES = ' w1 , w2 ,';
    expect(createTrelloClient()).toBeInstanceOf(TrelloClient);
  });
});
