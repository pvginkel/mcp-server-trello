import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMcpServer } from '../../src/index.js';
import { TrelloClient } from '../../src/trello-client.js';
import { TrelloHealthEndpoints } from '../../src/health/health-endpoints.js';

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
    isAxiosError: vi.fn(() => false),
  },
}));

vi.mock('../../src/rate-limiter.js', () => ({
  createTrelloRateLimiters: () => ({
    canMakeRequest: () => true,
    waitForAvailableToken: async () => {},
  }),
}));

/** The three tools that only make sense when a selection can be held. */
const AMBIENT_TOOLS = ['set_active_board', 'set_active_workspace', 'get_active_board_info'];

function toolNames(ambientSelection: boolean): string[] {
  const client = new TrelloClient({ apiKey: 'k', token: 't', ambientSelection });
  const server = createMcpServer(client, new TrelloHealthEndpoints(client), { ambientSelection });
  // registerTool stashes each registration on the server's private tool table.
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

describe('tool registration gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the selection tools by default', () => {
    const names = toolNames(true);

    for (const tool of AMBIENT_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it('omits exactly the selection tools when ambient selection is off', () => {
    const withAmbient = toolNames(true);
    const withoutAmbient = toolNames(false);

    for (const tool of AMBIENT_TOOLS) {
      expect(withoutAmbient).not.toContain(tool);
    }

    // Nothing else may go missing — the flag hides three tools, not a category.
    const missing = withAmbient.filter(n => !withoutAmbient.includes(n));
    expect(missing.sort()).toEqual([...AMBIENT_TOOLS].sort());
    expect(withoutAmbient.filter(n => !withAmbient.includes(n))).toEqual([]);
  });

  // list_boards_in_workspace takes an explicit workspaceId and reads no ambient
  // state; hiding it would remove a capability for no reason.
  it('keeps the explicitly-scoped workspace tool', () => {
    expect(toolNames(false)).toContain('list_boards_in_workspace');
  });
});
