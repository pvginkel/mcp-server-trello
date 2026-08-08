import { describe, it, expect } from 'vitest';
import { CARD_ORIGIN_ACTIONS_PARAM, extractReporter } from '../../src/card-reporter.js';
import type { TrelloCardAction } from '../../src/types.js';

function action(overrides: Partial<TrelloCardAction> & { type: string }): TrelloCardAction {
  return {
    id: `a-${overrides.type}`,
    date: '2020-01-01T00:00:00.000Z',
    data: {},
    memberCreator: { id: 'm1', fullName: 'Jane Doe', username: 'jane' },
    ...overrides,
  };
}

describe('extractReporter', () => {
  it('returns null when there are no actions at all', () => {
    expect(extractReporter(undefined)).toBeNull();
    expect(extractReporter([])).toBeNull();
  });

  it('pulls the member off a createCard action', () => {
    expect(extractReporter([action({ type: 'createCard' })])).toEqual({
      id: 'm1',
      fullName: 'Jane Doe',
      username: 'jane',
    });
  });

  it('ignores comment actions, which share the bundle with the origin action', () => {
    const comment = action({
      type: 'commentCard',
      data: { text: 'a comment' },
      memberCreator: { id: 'm2', fullName: 'Sam Ray', username: 'sam' },
    });

    expect(extractReporter([comment])).toBeNull();
    expect(extractReporter([comment, action({ type: 'createCard' })])?.username).toBe('jane');
  });

  it('falls back to the other ways a card can be born', () => {
    for (const type of ['copyCard', 'convertToCardFromCheckItem', 'emailCard']) {
      expect(extractReporter([action({ type })])?.username).toBe('jane');
    }
  });

  it('picks the oldest origin action when a card has more than one', () => {
    const reporter = extractReporter([
      action({
        type: 'copyCard',
        date: '2021-06-01T00:00:00.000Z',
        memberCreator: { id: 'm2', fullName: 'Sam Ray', username: 'sam' },
      }),
      action({ type: 'createCard', date: '2020-01-01T00:00:00.000Z' }),
    ]);

    expect(reporter?.username).toBe('jane');
  });

  it('narrows the member down to the three fields callers need', () => {
    const withExtras = action({
      type: 'createCard',
      memberCreator: {
        id: 'm1',
        fullName: 'Jane Doe',
        username: 'jane',
        avatarUrl: 'https://example.invalid/a.png',
      },
    });

    expect(Object.keys(extractReporter([withExtras]) ?? {}).sort()).toEqual([
      'fullName',
      'id',
      'username',
    ]);
  });

  it('survives an action bundle with a missing member', () => {
    const orphan = { id: 'a1', type: 'createCard', date: '2020-01-01T00:00:00.000Z', data: {} };
    expect(extractReporter([orphan as TrelloCardAction])).toBeNull();
  });

  it('exposes every origin type in the query param', () => {
    expect(CARD_ORIGIN_ACTIONS_PARAM.split(',')).toEqual([
      'createCard',
      'copyCard',
      'convertToCardFromCheckItem',
      'emailCard',
    ]);
  });
});
