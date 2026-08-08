export interface TrelloConfig {
  apiKey: string;
  token: string;
  defaultBoardId?: string;
  boardId?: string;
  workspaceId?: string;
  /** Optional list of workspace IDs to restrict access to. If set, only these workspaces can be accessed. */
  allowedWorkspaceIds?: string[];
}

export interface TrelloBoard {
  id: string;
  name: string;
  desc: string;
  closed: boolean;
  idOrganization: string;
  url: string;
  shortUrl: string;
}

export interface TrelloWorkspace {
  id: string;
  name: string;
  displayName: string;
  desc?: string;
  url: string;
  website?: string;
}

// The identity of a member as it is surfaced on a card. Deliberately narrower than
// TrelloMember: this is what gets embedded in card payloads, so it stays to the three
// fields a caller needs to recognise and address a person.
export interface TrelloMemberRef {
  id: string;
  fullName: string;
  username: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  idList: string;
  idLabels: string[];
  closed: boolean;
  url: string;
  dateLastActivity: string;
  // Who created the card. Trello exposes no creator on the card itself, so this is
  // derived from the card's origin action — see extractReporter. `null` means the
  // origin action was fetched but yielded nobody; absent means it was never fetched.
  reporter?: TrelloMemberRef | null;
}

export interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
  idBoard: string;
  pos: number;
}

export interface TrelloAction {
  id: string;
  idMemberCreator: string;
  type: string;
  date: string;
  data: {
    text?: string;
    card?: {
      id: string;
      name: string;
    };
    list?: {
      id: string;
      name: string;
    };
    board: {
      id: string;
      name: string;
    };
  };
  memberCreator: {
    id: string;
    fullName: string;
    username: string;
  };
}

export interface TrelloLabel {
  id: string;
  name: string;
  color: string;
}

export interface TrelloMember {
  id: string;
  fullName: string;
  username: string;
  avatarUrl: string | null;
}

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  fileName: string | null;
  bytes: number | null;
  date: string;
  mimeType: string;
  previews: Array<{
    id: string;
    url: string;
    width: number;
    height: number;
  }>;
  isUpload: boolean;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
  pos: number;
  due?: string | null;
  dueReminder?: number | null;
  idMember?: string | null;
}

export interface TrelloCheckItemUpdate {
  name?: string;
  state?: 'complete' | 'incomplete';
  pos?: number | 'top' | 'bottom';
  due?: string | null;
  dueReminder?: number | null;
  idMember?: string | null;
}

export interface TrelloChecklist {
  id: string;
  name: string;
  idCard: string;
  pos: number;
  checkItems: TrelloCheckItem[];
}

export interface TrelloLabelDetails {
  id: string;
  idBoard: string;
  name: string;
  color: string;
}

export interface TrelloComment {
  id: string;
  date: string;
  data: {
    text: string;
    card?: {
      id: string;
      name: string;
    };
  };
  memberCreator: {
    id: string;
    fullName: string;
    username: string;
    avatarUrl?: string;
  };
}

// An entry from a card's inline action bundle, which a card fetch pulls in via the
// `actions` nested resource. The bundle mixes kinds: comment actions carry `data.text`,
// while the card's origin action carries only the member who triggered it. `type` is what
// tells them apart.
export interface TrelloCardAction {
  id: string;
  type: string;
  date: string;
  data: {
    text?: string;
    card?: {
      id: string;
      name: string;
    };
  };
  memberCreator: TrelloMemberRef & { avatarUrl?: string };
}

export interface TrelloCustomFieldDefinition {
  id: string;
  idModel: string;
  modelType: string;
  fieldGroup: string;
  name: string;
  type: 'text' | 'number' | 'checkbox' | 'date' | 'list';
  pos: number;
  display: {
    cardFront: boolean;
  };
  options?: TrelloCustomFieldOption[];
}

export interface TrelloCustomFieldOption {
  id: string;
  idCustomField: string;
  value: { text: string };
  color: string;
  pos: number;
}

export interface TrelloCustomFieldItem {
  id: string;
  idCustomField: string;
  idModel: string;
  modelType: string;
  idValue?: string;
  value?: {
    text?: string;
    number?: string;
    checked?: string;
    date?: string;
  } | null;
}

export interface TrelloBadges {
  attachmentsByType?: {
    trello?: {
      board: number;
      card: number;
    };
  };
  location: boolean;
  votes: number;
  viewingMemberVoted: boolean;
  subscribed: boolean;
  fogbugz: string;
  checkItems: number;
  checkItemsChecked: number;
  checkItemsEarliestDue?: string | null;
  comments: number;
  attachments: number;
  description: boolean;
  due?: string | null;
  dueComplete: boolean;
  start?: string | null;
}

export interface TrelloCover {
  idAttachment?: string | null;
  color?: string | null;
  idUploadedBackground?: string | null;
  size: 'normal' | 'full';
  brightness: 'light' | 'dark';
  isTemplate: boolean;
}

export interface EnhancedTrelloCard {
  // Basic fields
  id: string;
  name: string;
  desc: string;
  descData?: {
    emoji?: Record<string, unknown>;
  };
  due: string | null;
  dueComplete: boolean;
  dueReminder: number | null;
  start: string | null;
  idList: string;
  idBoard: string;
  closed: boolean;
  url: string;
  shortUrl: string;
  dateLastActivity: string;
  pos: number;

  // Enhanced fields
  labels: TrelloLabelDetails[];
  idLabels: string[];
  attachments: TrelloAttachment[];
  checklists: TrelloChecklist[];
  members: TrelloMember[];
  idMembers: string[];
  comments: TrelloComment[];
  // Trello returns comment actions under `actions` when fetched with
  // actions=commentCard; formatCardAsMarkdown falls back to this. The same bundle also
  // carries the card's origin action, which is where `reporter` comes from.
  actions?: TrelloCardAction[];
  // Who created the card — derived from the origin action in `actions`, not a field
  // Trello serves on the card. See extractReporter.
  reporter?: TrelloMemberRef | null;
  customFieldItems?: TrelloCustomFieldItem[];
  badges: TrelloBadges;
  cover: TrelloCover;

  // List and board info
  list?: {
    id: string;
    name: string;
  };
  board?: {
    id: string;
    name: string;
    url: string;
  };
}

export interface RateLimiter {
  canMakeRequest(): boolean;
  waitForAvailableToken(): Promise<void>;
}

// One entry per requested short ID when fetching several cards at once. Lookups are
// independent, so a missing or archived card yields `error` for that entry only and
// leaves the rest of the batch intact. `name` is carried separately so callers can
// build a section heading without having to reach into `card`, which is already
// rendered markdown when includeMarkdown is set.
export interface CardByShortResult {
  cardShort: number;
  name?: string;
  card?: EnhancedTrelloCard | string;
  error?: string;
}

// Enhanced checklist types for MCP tools
export interface CheckList {
  id: string;
  name: string;
  items: CheckListItem[];
  percentComplete: number;
}

export interface CheckListItem {
  id: string;
  text: string;
  complete: boolean;
  parentCheckListId: string;
}
