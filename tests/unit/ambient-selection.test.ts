import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import { TrelloClient } from '../../src/trello-client.js';
import type { TrelloConfig } from '../../src/types.js';

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

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: vi.fn(() => false),
  },
}));

vi.mock('../../src/rate-limiter.js', () => ({
  createTrelloRateLimiters: () => ({
    canMakeRequest: () => true,
    waitForAvailableToken: async () => {},
  }),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async () => JSON.stringify({ boardId: 'saved-board', workspaceId: 'saved-ws' })),
  writeFile: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
}));

function createClient(overrides: Partial<TrelloConfig> = {}) {
  return new TrelloClient({
    apiKey: 'test-key',
    token: 'test-token',
    ...overrides,
  });
}

describe('ambientSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('board resolution', () => {
    it('defaults to on, so the active board wins over the env default', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: { id: 'b2', name: 'Active' } });
      const client = createClient({ defaultBoardId: 'b1' });

      await client.setActiveBoard('b2');

      expect(client.effectiveBoardId).toBe('b2');
    });

    it('skips the active board when off, falling through to the env default', async () => {
      const client = createClient({ defaultBoardId: 'b1', ambientSelection: false });

      expect(client.effectiveBoardId).toBe('b1');
    });

    it('still honours an explicit boardId when off', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: [] });
      const client = createClient({ defaultBoardId: 'b1', ambientSelection: false });

      await client.getLists('b2');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/boards/b2/lists');
    });

    it('has no effective board when off with no env default', () => {
      const client = createClient({ ambientSelection: false });

      expect(client.effectiveBoardId).toBeUndefined();
    });

    it('throws on an unqualified board-scoped call when off with no env default', async () => {
      const client = createClient({ ambientSelection: false });

      await expect(client.getLists()).rejects.toThrow(
        'boardId is required when no default board is configured'
      );
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('the selection tools', () => {
    it('setActiveBoard throws when off', async () => {
      const client = createClient({ ambientSelection: false });

      await expect(client.setActiveBoard('b1')).rejects.toThrow(
        /ambient board\/workspace selection is disabled/
      );
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('setActiveWorkspace throws when off', async () => {
      const client = createClient({ ambientSelection: false });

      await expect(client.setActiveWorkspace('w1')).rejects.toThrow(
        /ambient board\/workspace selection is disabled/
      );
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('the getters', () => {
    it('report no selection when off, even with an env default seeding it', () => {
      const client = createClient({
        defaultBoardId: 'b1',
        workspaceId: 'w1',
        ambientSelection: false,
      });

      expect(client.activeBoardId).toBeUndefined();
      expect(client.activeWorkspaceId).toBeUndefined();
      expect(client.hasAmbientSelection).toBe(false);
    });

    it('report the selection when on', () => {
      const client = createClient({ defaultBoardId: 'b1', workspaceId: 'w1' });

      expect(client.activeBoardId).toBe('b1');
      expect(client.activeWorkspaceId).toBe('w1');
      expect(client.hasAmbientSelection).toBe(true);
    });
  });

  // The half that actually stops state leaking across runs: with the tools
  // hidden but the file still read at boot, a stale selection from an earlier
  // stdio run would silently retarget an HTTP deployment.
  describe('persistence', () => {
    it('loadConfig performs no file I/O when off', async () => {
      const client = createClient({ ambientSelection: false });

      await client.loadConfig();

      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(client.effectiveBoardId).toBeUndefined();
    });

    it('loadConfig reads the saved selection when on', async () => {
      const client = createClient();

      await client.loadConfig();

      expect(fs.readFile).toHaveBeenCalled();
      expect(client.activeBoardId).toBe('saved-board');
      expect(client.activeWorkspaceId).toBe('saved-ws');
    });

    it('writes nothing to disk when off', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: { id: 'b1', name: 'Board' } });
      const client = createClient({ ambientSelection: false });

      await client.setActiveBoard('b1').catch(() => {});

      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('createBoard under workspace restrictions', () => {
    const restricted = { allowedWorkspaceIds: ['w-allowed'] };

    it('falls back to the active workspace when on', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: { id: 'w-allowed', name: 'WS' } });
      mockAxiosInstance.post.mockResolvedValue({ data: { id: 'b-new' } });
      const client = createClient(restricted);
      await client.setActiveWorkspace('w-allowed');

      await client.createBoard({ name: 'New Board' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/boards',
        expect.objectContaining({ idOrganization: 'w-allowed' })
      );
    });

    it('throws without idOrganization when off, naming only what is available', async () => {
      const client = createClient({ ...restricted, ambientSelection: false, workspaceId: 'w-allowed' });

      await expect(client.createBoard({ name: 'New Board' })).rejects.toThrow(
        /Provide idOrganization\. Allowed workspaces/
      );
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('still accepts an explicit allowed workspace when off', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { id: 'b-new' } });
      const client = createClient({ ...restricted, ambientSelection: false });

      await client.createBoard({ name: 'New Board', idOrganization: 'w-allowed' });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/boards',
        expect.objectContaining({ idOrganization: 'w-allowed' })
      );
    });
  });
});
