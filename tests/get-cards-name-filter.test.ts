import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { TrelloClient } from '../src/trello-client.js';

const MOCK_CARDS = [
  {
    id: '1',
    name: 'FEAT: Add Slippage to Position History',
    desc: '',
    due: null,
    idList: 'list1',
    idLabels: ['labelA'],
    closed: false,
    url: '',
    dateLastActivity: '',
  },
  {
    id: '2',
    name: 'FEAT: Execute trade slippage config',
    desc: '',
    due: null,
    idList: 'list1',
    idLabels: ['labelA', 'labelB'],
    closed: false,
    url: '',
    dateLastActivity: '',
  },
  {
    id: '3',
    name: 'BUG: Fix login page crash',
    desc: '',
    due: null,
    idList: 'list1',
    idLabels: ['labelB'],
    closed: false,
    url: '',
    dateLastActivity: '',
  },
  {
    id: '4',
    name: 'Add Slippage to Position History',
    desc: '',
    due: null,
    idList: 'list1',
    idLabels: [],
    closed: false,
    url: '',
    dateLastActivity: '',
  },
];

// Create a client and mock the axios instance's get method
function createMockedClient() {
  const client = new TrelloClient({ apiKey: 'fake', token: 'fake', boardId: 'board1' });
  // Replace the internal axios instance's get with a mock
  (client as any).axiosInstance = {
    get: vi.fn(() => Promise.resolve({ data: MOCK_CARDS })),
  };
  return client;
}

// Mirror the schema from index.ts for validation tests
const nameFilterSchema = z.string().trim().min(1, 'nameFilter must not be empty').optional();
const labelIdSchema = z.string().trim().min(1, 'labelId must not be empty').optional();

describe('nameFilter schema validation', () => {
  it('accepts undefined', () => {
    expect(nameFilterSchema.parse(undefined)).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(() => nameFilterSchema.parse('')).toThrow();
  });

  it('rejects whitespace-only string', () => {
    expect(() => nameFilterSchema.parse('   ')).toThrow();
  });

  it('accepts valid string', () => {
    expect(nameFilterSchema.parse('FEAT')).toBe('FEAT');
  });

  it('trims whitespace from valid string', () => {
    expect(nameFilterSchema.parse('  FEAT  ')).toBe('FEAT');
  });
});

describe('getCardsByList nameFilter', () => {
  let client: TrelloClient;

  beforeEach(() => {
    client = createMockedClient();
  });

  it('returns all cards when no nameFilter is provided', async () => {
    const cards = await client.getCardsByList('list1');
    expect(cards).toHaveLength(4);
  });

  it('returns all cards when nameFilter is undefined', async () => {
    const cards = await client.getCardsByList('list1', undefined, undefined);
    expect(cards).toHaveLength(4);
  });

  it('filters by exact name match', async () => {
    const cards = await client.getCardsByList(
      'list1',
      undefined,
      'Add Slippage to Position History'
    );
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('filters by substring match', async () => {
    const cards = await client.getCardsByList('list1', undefined, 'FEAT');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('filters case-insensitively', async () => {
    const cards = await client.getCardsByList('list1', undefined, 'add slippage');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id)).toEqual(['1', '4']);
  });

  it('returns empty array when no cards match', async () => {
    const cards = await client.getCardsByList('list1', undefined, 'nonexistent card name');
    expect(cards).toHaveLength(0);
  });

  it('does not match non-contiguous substrings', async () => {
    // "Add History" is not a contiguous substring of any card name
    const cards = await client.getCardsByList('list1', undefined, 'Add History');
    expect(cards).toHaveLength(0);
  });

  it('passes requested fields while filtering by name', async () => {
    const cards = await client.getCardsByList('list1', 'name,idList', 'FEAT');
    expect(cards).toHaveLength(2);
    const params = (client as any).axiosInstance.get.mock.calls[0][1].params;
    expect(params.fields).toBe('name,idList');
  });
});

describe('labelId schema validation', () => {
  it('accepts undefined', () => {
    expect(labelIdSchema.parse(undefined)).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(() => labelIdSchema.parse('')).toThrow();
  });

  it('rejects whitespace-only string', () => {
    expect(() => labelIdSchema.parse('   ')).toThrow();
  });

  it('accepts valid string', () => {
    expect(labelIdSchema.parse('labelA')).toBe('labelA');
  });

  it('trims whitespace from valid string', () => {
    expect(labelIdSchema.parse('  labelA  ')).toBe('labelA');
  });
});

describe('getCardsByList labelId', () => {
  let client: TrelloClient;

  beforeEach(() => {
    client = createMockedClient();
  });

  it('returns all cards when no labelId is provided', async () => {
    const cards = await client.getCardsByList('list1', undefined, undefined, undefined);
    expect(cards).toHaveLength(4);
  });

  it('filters to only cards carrying the given label ID', async () => {
    const cards = await client.getCardsByList('list1', undefined, undefined, 'labelA');
    expect(cards.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('matches cards that carry the label among several', async () => {
    const cards = await client.getCardsByList('list1', undefined, undefined, 'labelB');
    expect(cards.map((c) => c.id)).toEqual(['2', '3']);
  });

  it('returns empty array when no card carries the label', async () => {
    const cards = await client.getCardsByList('list1', undefined, undefined, 'labelZ');
    expect(cards).toHaveLength(0);
  });

  it('composes nameFilter and labelId (intersection)', async () => {
    const cards = await client.getCardsByList('list1', undefined, 'FEAT', 'labelB');
    expect(cards.map((c) => c.id)).toEqual(['2']);
  });

  it('force-includes idLabels when fields is restricted and labelId is set', async () => {
    await client.getCardsByList('list1', 'name,idList', undefined, 'labelA');
    const call = (client as any).axiosInstance.get.mock.calls[0];
    expect(call[0]).toBe('/lists/list1/cards');
    const requestedFields = call[1].params.fields.split(',');
    expect(requestedFields).toContain('idLabels');
    expect(requestedFields).toContain('name');
    expect(requestedFields).toContain('idList');
  });

  it('does not add idLabels to fields when no labelId is set', async () => {
    await client.getCardsByList('list1', 'name,idList', undefined, undefined);
    const call = (client as any).axiosInstance.get.mock.calls[0];
    expect(call[0]).toBe('/lists/list1/cards');
    expect(call[1].params.fields).toBe('name,idList');
  });
});
