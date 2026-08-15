import type { TrelloCardAction, TrelloMemberRef } from './types.js';

// Trello serves no creator field on a card, so the reporter has to be recovered from the
// action that brought the card into being. A card is normally born via `createCard`, but it
// can also arrive by copy, by promotion from a checklist item, or over email — each of those
// emits its own action type instead, and a card that arrived that way has no `createCard` at
// all. Asking for all four is what keeps the reporter from going blank on those cards.
const CARD_ORIGIN_ACTION_TYPES = [
  'createCard',
  'copyCard',
  'convertToCardFromCheckItem',
  'emailCard',
] as const;

const ORIGIN_TYPES = new Set<string>(CARD_ORIGIN_ACTION_TYPES);

// Ready-made value for Trello's `actions` query param, which takes a comma-separated filter.
export const CARD_ORIGIN_ACTIONS_PARAM = CARD_ORIGIN_ACTION_TYPES.join(',');

/**
 * Pick the reporter out of a card's action bundle.
 *
 * Returns `null` rather than throwing when the bundle holds no origin action: that happens
 * legitimately when a card has so many comments that the origin action falls off the end of
 * the `actions_limit` window, and a missing reporter should never sink a card fetch.
 */
export function extractReporter(actions?: TrelloCardAction[]): TrelloMemberRef | null {
  const origins = (actions ?? []).filter(
    action => ORIGIN_TYPES.has(action?.type) && action.memberCreator
  );

  if (origins.length === 0) {
    return null;
  }

  // Oldest wins. A card that was copied and then moved carries more than one origin-ish
  // action, and the earliest of them is the one that actually created it. Trello dates are
  // ISO-8601 UTC, which orders correctly as plain strings.
  const origin = origins.reduce((oldest, action) => (action.date < oldest.date ? action : oldest));

  const { id, fullName, username } = origin.memberCreator;
  return { id, fullName, username };
}
