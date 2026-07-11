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
        actions: 'commentCard',
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
