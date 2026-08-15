import { describe, it, expect, vi } from 'vitest';
import { TrelloHealthMonitor, HealthStatus } from '../../src/health/health-monitor.js';
import type { TrelloClient } from '../../src/trello-client.js';

/**
 * A client stub covering only what the board-scoped checks reach for. The
 * question under test is what the monitor does when there is no board to check,
 * so the Trello calls below should never fire.
 */
function stubClient(overrides: Partial<Record<string, unknown>> = {}): TrelloClient {
  return {
    hasAmbientSelection: true,
    effectiveBoardId: undefined,
    listBoards: vi.fn(async () => []),
    getBoardById: vi.fn(async () => ({ id: 'b1', name: 'Board', closed: false, url: 'u' })),
    getLists: vi.fn(async () => {
      throw new Error('boardId is required when no default board is configured');
    }),
    getAcceptanceCriteria: vi.fn(async () => {
      throw new Error('boardId is required when no default board is configured');
    }),
    ...overrides,
  } as unknown as TrelloClient;
}

async function boardChecks(client: TrelloClient) {
  const report = await new TrelloHealthMonitor(client).getSystemHealth(true);
  const byName = Object.fromEntries(report.checks.map(c => [c.name, c]));
  return { report, byName };
}

describe('health checks and ambient selection', () => {
  it('reports DEGRADED with no board when ambient selection is on', async () => {
    const { byName } = await boardChecks(stubClient());

    expect(byName.board_access.status).toBe(HealthStatus.DEGRADED);
    expect(byName.board_access.message).toBe('No active board configured');
  });

  // An HTTP deployment with no TRELLO_BOARD_ID is a valid configuration, not an
  // unhealthy one. Left alone these checks would peg the report at DEGRADED for
  // the life of the process, with a suggestion naming a tool that isn't registered.
  it('treats board checks as not applicable when ambient selection is off', async () => {
    const client = stubClient({ hasAmbientSelection: false });
    const { report, byName } = await boardChecks(client);

    for (const name of ['board_access', 'list_operations', 'checklist_operations']) {
      expect(byName[name].status, name).toBe(HealthStatus.HEALTHY);
      expect(byName[name].metadata?.not_applicable, name).toBe(true);
    }

    expect(report.overall_status).not.toBe(HealthStatus.DEGRADED);
    expect(client.getLists).not.toHaveBeenCalled();
    expect(client.getAcceptanceCriteria).not.toHaveBeenCalled();
    expect(report.recommendations).not.toContain('Set an active board using set_active_board tool');
  });

  it('still checks the board when ambient is off but an env default exists', async () => {
    const client = stubClient({
      hasAmbientSelection: false,
      effectiveBoardId: 'b1',
      getLists: vi.fn(async () => []),
      getAcceptanceCriteria: vi.fn(async () => []),
    });
    const { byName } = await boardChecks(client);

    expect(byName.board_access.status).toBe(HealthStatus.HEALTHY);
    expect(byName.board_access.metadata?.not_applicable).toBeUndefined();
    expect(client.getBoardById).toHaveBeenCalledWith('b1');
    expect(client.getLists).toHaveBeenCalled();
  });
});
