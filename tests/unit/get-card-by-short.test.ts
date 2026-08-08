import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrelloClient } from '../../src/trello-client.js';

// Shared mock instance that axios.create will return
const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

// Mock axios
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: vi.fn(() => false),
  },
}));

// Mock rate-limiter
vi.mock('../../src/rate-limiter.js', () => ({
  createTrelloRateLimiters: () => ({
    apiKeyLimiter: { canMakeRequest: () => true, waitForAvailableToken: async () => {} },
    tokenLimiter: { canMakeRequest: () => true, waitForAvailableToken: async () => {} },
    canMakeRequest: () => true,
    waitForAvailableToken: async () => {},
  }),
}));

// Mock fs/promises for config loading
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
}));

function createClient(overrides?: { boardId?: string; defaultBoardId?: string }) {
  return new TrelloClient({
    apiKey: 'test-key',
    token: 'test-token',
    boardId: overrides?.boardId,
    defaultBoardId: overrides?.defaultBoardId,
  });
}

describe('getCardByShort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch a card by short ID with the full detail params', async () => {
    const card = { id: 'c1', idShort: 42, name: 'Card', checklists: [], labels: [] };
    mockAxiosInstance.get.mockResolvedValue({ data: card });

    const client = createClient();
    const result = await client.getCardByShort('board-1', 42);

    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/boards/board-1/cards/42', {
      params: expect.objectContaining({
        attachments: true,
        checklists: 'all',
        checkItemStates: true,
        members: true,
        membersVoted: true,
        labels: true,
        // Comments and the origin action share one nested resource, so the reporter
        // rides along on the same request.
        actions: 'commentCard,createCard,copyCard,convertToCardFromCheckItem,emailCard',
        actions_limit: 100,
        fields: 'all',
        customFieldItems: true,
        list: true,
        board: true,
        stickers: true,
        pluginData: true,
      }),
    });
    expect(result).toEqual(card);
  });

  it('should fall back to the active board when boardId is omitted', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: { id: 'c1' } });

    const client = createClient({ boardId: 'active-board' });
    await client.getCardByShort(undefined, 7);

    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/boards/active-board/cards/7',
      expect.anything()
    );
  });

  it('should fall back to the default board when boardId and active board are unset', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: { id: 'c1' } });

    const client = createClient({ defaultBoardId: 'default-board' });
    await client.getCardByShort(undefined, 7);

    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/boards/default-board/cards/7',
      expect.anything()
    );
  });

  it('should throw InvalidParams when no board is available anywhere', async () => {
    const client = createClient();

    await expect(client.getCardByShort(undefined, 7)).rejects.toThrow(
      'boardId is required when no default board is configured'
    );
    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
  });

  it('should return markdown when includeMarkdown is true', async () => {
    const card = {
      id: 'c1',
      idShort: 42,
      name: 'My Card',
      board: { name: 'Board', url: 'https://trello.com/b/x' },
      list: { name: 'To Do' },
      labels: [],
    };
    mockAxiosInstance.get.mockResolvedValue({ data: card });

    const client = createClient();
    const result = await client.getCardByShort('board-1', 42, true);

    expect(typeof result).toBe('string');
    expect(result).toContain('# My Card');
  });
});

describe('getCardsByShort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch every requested short ID and keep them in request order', async () => {
    mockAxiosInstance.get.mockImplementation(async (url: string) => {
      const cardShort = Number(url.split('/').pop());
      return { data: { id: `c${cardShort}`, idShort: cardShort, name: `Card ${cardShort}` } };
    });

    const client = createClient();
    const results = await client.getCardsByShort('board-1', [42, 7, 13]);

    expect(results.map(r => r.cardShort)).toEqual([42, 7, 13]);
    expect(results.map(r => r.name)).toEqual(['Card 42', 'Card 7', 'Card 13']);
    expect(results.every(r => r.error === undefined)).toBe(true);
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/boards/board-1/cards/7',
      expect.objectContaining({ params: expect.objectContaining({ fields: 'all' }) })
    );
  });

  it('should report per-card errors without failing the whole batch', async () => {
    mockAxiosInstance.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/99')) {
        throw new Error('boom');
      }
      return { data: { id: 'c42', idShort: 42, name: 'Card 42' } };
    });

    const client = createClient();
    const results = await client.getCardsByShort('board-1', [42, 99]);

    // reporter is explicitly null, not absent: the origin action was asked for and came
    // back empty, which is a different statement from never having looked.
    expect(results[0].card).toEqual({
      id: 'c42',
      idShort: 42,
      name: 'Card 42',
      reporter: null,
    });
    expect(results[0].error).toBeUndefined();
    expect(results[1].card).toBeUndefined();
    expect(results[1].error).toBeTruthy();
  });

  it('should render each card under a "Card #<n>" heading when includeMarkdown is true', async () => {
    mockAxiosInstance.get.mockImplementation(async (url: string) => {
      const cardShort = Number(url.split('/').pop());
      return {
        data: { id: `c${cardShort}`, idShort: cardShort, name: `Card ${cardShort}`, labels: [] },
      };
    });

    const client = createClient();
    const results = await client.getCardsByShort('board-1', [42, 7], true);

    expect(results[0].card).toContain('# Card #42: Card 42');
    expect(results[1].card).toContain('# Card #7: Card 7');
    // The heading replaces the card's own H1 rather than stacking on top of it, so it
    // stays usable as a section delimiter.
    expect((results[0].card as string).match(/^# /gm)).toHaveLength(1);
  });

  it('should throw InvalidParams when no board is available anywhere', async () => {
    const client = createClient();

    await expect(client.getCardsByShort(undefined, [7])).rejects.toThrow(
      'boardId is required when no default board is configured'
    );
    expect(mockAxiosInstance.get).not.toHaveBeenCalled();
  });
});
