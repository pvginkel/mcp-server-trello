#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TrelloClient } from './trello-client.js';
import { TrelloHealthEndpoints, HealthEndpointSchemas } from './health/health-endpoints.js';
import { formatCardListResponse } from './card-list-preview.js';
import { readHttpConfig, startHttpServer } from './http-server.js';

/**
 * Build the shared {@link TrelloClient} from environment variables. The client
 * holds the mutable board/workspace selection and is shared across every MCP
 * session (stdio has one session; HTTP shares one client across sessions).
 */
export function createTrelloClient(): TrelloClient {
  const apiKey = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const defaultBoardId = process.env.TRELLO_BOARD_ID;
  const allowedWorkspacesEnv = process.env.TRELLO_ALLOWED_WORKSPACES;

  if (!apiKey || !token) {
    throw new Error('TRELLO_API_KEY and TRELLO_TOKEN environment variables are required');
  }

  // Parse allowed workspaces from comma-separated string
  const allowedWorkspaceIds = allowedWorkspacesEnv
    ? allowedWorkspacesEnv
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0)
    : undefined;

  return new TrelloClient({
    apiKey,
    token,
    defaultBoardId,
    boardId: defaultBoardId,
    allowedWorkspaceIds,
  });
}

/**
 * One MCP server instance and its tool registrations. In stdio mode there is
 * exactly one; in HTTP mode a fresh instance is created per session (see
 * {@link createMcpServer}), all wired to the same shared {@link TrelloClient}
 * so board/workspace selection persists across requests.
 */
class TrelloServer {
  private server: McpServer;
  private trelloClient: TrelloClient;
  private healthEndpoints: TrelloHealthEndpoints;

  constructor(trelloClient: TrelloClient, healthEndpoints: TrelloHealthEndpoints) {
    this.trelloClient = trelloClient;
    this.healthEndpoints = healthEndpoints;

    this.server = new McpServer({
      name: 'trello-server',
      version: '1.7.1',
    });

    this.setupTools();
    this.setupHealthEndpoints();
  }

  /** The underlying MCP server, ready to connect to a transport. */
  getServer(): McpServer {
    return this.server;
  }

  private handleError(error: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        },
      ],
      isError: true,
    };
  }

  private setupTools() {
    // Get cards from a specific list
    this.server.registerTool(
      'get_cards_by_list_id',
      {
        title: 'Get Cards by List ID',
        description:
          'Fetch cards from a specific Trello list on a specific board. Optionally filter by name substring (nameFilter) and/or label ID (labelId); both are applied client-side and compose. Each card carries a "reporter" field naming the member who created it. Descriptions are previewed by default to keep responses compact; set fields without "desc" to omit descriptions, or increase descMaxLength/omitDescThresholdBytes and use get_card for full details.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the Trello list'),
          fields: z
            .string()
            .optional()
            .describe('Comma-separated list of fields to return (e.g., "name,idShort,labels,due,dueComplete"). Omit for all fields.'),
          nameFilter: z
            .string()
            .trim()
            .min(1, 'nameFilter must not be empty')
            .optional()
            .describe('Optional substring to filter cards by name (case-insensitive)'),
          labelId: z
            .string()
            .trim()
            .min(1, 'labelId must not be empty')
            .optional()
            .describe('Optional Trello label ID; only cards carrying this label are returned'),
          descMaxLength: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Maximum description preview length per card. Defaults to 200. Increase for fuller descriptions.'
            ),
          omitDescThresholdBytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Approximate response size threshold before descriptions are omitted. Defaults to 50000 bytes.'
            ),
        },
      },
      async ({ listId, fields, nameFilter, labelId, descMaxLength, omitDescThresholdBytes }) => {
        try {
          const cards = await this.trelloClient.getCardsByList(listId, fields, nameFilter, labelId);
          return formatCardListResponse(cards, { descMaxLength, omitDescThresholdBytes });
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get all lists from a board
    this.server.registerTool(
      'get_lists',
      {
        title: 'Get Lists',
        description: 'Retrieve all lists from the specified board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const lists = await this.trelloClient.getLists(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(lists, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get recent activity
    this.server.registerTool(
      'get_recent_activity',
      {
        title: 'Get Recent Activity',
        description: 'Fetch recent activity on the Trello board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          limit: z
            .number()
            .optional()
            .default(10)
            .describe('Number of activities to fetch (default: 10)'),
          since: z
            .string()
            .optional()
            .describe('Only return actions after this date (ISO 8601) or action ID'),
          before: z
            .string()
            .optional()
            .describe('Only return actions before this date (ISO 8601) or action ID'),
        },
      },
      async ({ boardId, limit, since, before }) => {
        try {
          const activity = await this.trelloClient.getRecentActivity(boardId, limit, since, before);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(activity, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a new card to a list
    this.server.registerTool(
      'add_card_to_list',
      {
        title: 'Add Card to List',
        description: 'Add a new card to a specified list on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the list to add the card to'),
          name: z.string().describe('Name of the card'),
          description: z.string().optional().describe('Description of the card'),
          dueDate: z.string().optional().describe('Due date for the card (ISO 8601 format)'),
          dueReminder: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe(
              'Due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)'
            ),
          start: z
            .string()
            .optional()
            .describe('Start date for the card (YYYY-MM-DD format, date only)'),
          labels: z
            .array(z.string())
            .optional()
            .describe('Array of label IDs to apply to the card'),
        },
      },
      async args => {
        try {
          const card = await this.trelloClient.addCard(args.boardId, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update card details
    this.server.registerTool(
      'update_card_details',
      {
        title: 'Update Card Details',
        description: "Update an existing card's details on a specific board",
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardId: z.string().describe('ID of the card to update'),
          name: z.string().optional().describe('New name for the card'),
          description: z.string().optional().describe('New description for the card'),
          dueDate: z.string().optional().describe('New due date for the card (ISO 8601 format)'),
          dueReminder: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe(
              'New due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)'
            ),
          start: z
            .string()
            .optional()
            .describe('New start date for the card (YYYY-MM-DD format, date only)'),
          dueComplete: z
            .boolean()
            .optional()
            .describe('Mark the due date as complete (true) or incomplete (false)'),
          labels: z.array(z.string()).optional().describe('New array of label IDs for the card'),
          pos: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
              'Position of the card in the list. Accepts "top", "bottom", or a positive number'
            ),
        },
      },
      async args => {
        try {
          const card = await this.trelloClient.updateCard(args.boardId, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Archive a card
    this.server.registerTool(
      'archive_card',
      {
        title: 'Archive Card',
        description: 'Send a card to the archive on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardId: z.string().describe('ID of the card to archive'),
        },
      },
      async ({ boardId, cardId }) => {
        try {
          const card = await this.trelloClient.archiveCard(boardId, cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Un-archive a card
    this.server.registerTool(
      'unarchive_card',
      {
        title: 'Un-archive Card',
        description:
          'Return a card from the archive to its list on a specific board (the reverse of archive_card)',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardId: z.string().describe('ID of the card to un-archive'),
        },
      },
      async ({ boardId, cardId }) => {
        try {
          const card = await this.trelloClient.unarchiveCard(boardId, cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Move a card
    this.server.registerTool(
      'move_card',
      {
        title: 'Move Card',
        description: 'Move a card to a different list, potentially on a different board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the target Trello board (where the listId resides, uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to move'),
          listId: z.string().describe('ID of the target list'),
          pos: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
              'Position of the card in the target list. Accepts "top", "bottom", or a positive number'
            ),
        },
      },
      async ({ boardId, cardId, listId, pos }) => {
        try {
          const card = await this.trelloClient.moveCard(boardId, cardId, listId, pos);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a new list to a board
    this.server.registerTool(
      'add_list_to_board',
      {
        title: 'Add List to Board',
        description: 'Add a new list to the specified board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          name: z.string().describe('Name of the new list'),
        },
      },
      async ({ boardId, name }) => {
        try {
          const list = await this.trelloClient.addList(boardId, name);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Archive a list
    this.server.registerTool(
      'archive_list',
      {
        title: 'Archive List',
        description: 'Send a list to the archive on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the list to archive'),
        },
      },
      async ({ boardId, listId }) => {
        try {
          const list = await this.trelloClient.archiveList(boardId, listId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update a list
    this.server.registerTool(
      'update_list',
      {
        title: 'Update List',
        description:
          'Update a list name, archive state, subscription state, or board. Use update_list_position for moving a list within a board.',
        inputSchema: {
          listId: z.string().describe('ID of the Trello list to update'),
          name: z.string().optional().describe('New name for the list'),
          closed: z.boolean().optional().describe('Whether to close (archive) the list'),
          subscribed: z
            .boolean()
            .optional()
            .describe('Whether the authenticated user is subscribed to the list'),
          idBoard: z.string().optional().describe('ID of a board to move the list to'),
        },
      },
      async ({ listId, name, closed, subscribed, idBoard }) => {
        try {
          const params: {
            name?: string;
            closed?: boolean;
            subscribed?: boolean;
            idBoard?: string;
          } = {};
          if (name !== undefined) params.name = name;
          if (closed !== undefined) params.closed = closed;
          if (subscribed !== undefined) params.subscribed = subscribed;
          if (idBoard !== undefined) params.idBoard = idBoard;
          if (Object.keys(params).length === 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'At least one of name, closed, subscribed, or idBoard must be provided'
            );
          }
          const list = await this.trelloClient.updateList(listId, params);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update list position
    this.server.registerTool(
      'update_list_position',
      {
        title: 'Update List Position',
        description:
          'Update the position of a list on the board. Trello uses fractional indexing: each list has a float position, and to place a list between two others, use the average of their positions (e.g., between pos 1024 and 2048, use 1536). Use "top"/"bottom" shortcuts to move to the edges.',
        inputSchema: {
          listId: z.string().describe('ID of the list to reposition'),
          position: z
            .string()
            .refine(
              (val) => {
                if (val === 'top' || val === 'bottom') return true;
                const num = Number(val);
                return num > 0 && isFinite(num);
              },
              {
                message: "Position must be 'top', 'bottom', or a positive finite numeric string.",
              }
            )
            .describe(
              'New position: "top" (move to leftmost), "bottom" (move to rightmost), or a numeric string (e.g. "1536"). To place between two lists, use the average of their pos values.'
            ),
        },
      },
      async ({ listId, position }) => {
        try {
          const parsedPosition =
            position === 'top' || position === 'bottom' ? position : Number(position);
          const list = await this.trelloClient.updateListPosition(listId, parsedPosition);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get cards assigned to current user
    this.server.registerTool(
      'get_my_cards',
      {
        title: 'Get My Cards',
        description: 'Fetch all cards assigned to the current user',
        inputSchema: {},
      },
      async () => {
        try {
          const cards = await this.trelloClient.getMyCards();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach image to card (kept for backward compatibility)
    this.server.registerTool(
      'attach_image_to_card',
      {
        title: 'Attach Image to Card',
        description: 'Attach an image to a card from a URL on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the image to'),
          imageUrl: z.string().describe('URL of the image to attach'),
          name: z
            .string()
            .optional()
            .default('Image Attachment')
            .describe('Optional name for the attachment (defaults to "Image Attachment")'),
        },
      },
      async ({ boardId, cardId, imageUrl, name }) => {
        try {
          const attachment = await this.trelloClient.attachImageToCard(
            boardId,
            cardId,
            imageUrl,
            name
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(attachment, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach file to card (generic file attachment)
    this.server.registerTool(
      'attach_file_to_card',
      {
        title: 'Attach File to Card',
        description: 'Attach any file to a card from a URL on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the file to'),
          fileUrl: z.string().describe('URL of the file to attach'),
          name: z
            .string()
            .optional()
            .default('File Attachment')
            .describe('Optional name for the attachment (defaults to "File Attachment")'),
          mimeType: z
            .string()
            .optional()
            .describe(
              'Optional MIME type of the file (e.g., "application/pdf", "text/plain", "video/mp4")'
            ),
        },
      },
      async ({ boardId, cardId, fileUrl, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachFileToCard(
            boardId,
            cardId,
            fileUrl,
            name,
            mimeType
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(attachment, null, 2) }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    // Attach arbitrary binary data to a card (base64 or data URL)
    this.server.registerTool(
      'attach_data_to_card',
      {
        title: 'Attach Data to Card',
        description:
          'Attach binary data (image, markdown, PDF, text, etc.) to a card from base64-encoded data or a data URL. Use this for any non-image content. For image/screenshot uploads with PNG defaults, see attach_image_data_to_card.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the data to'),
          data: z
            .string()
            .describe(
              'Base64-encoded data or a data URL (e.g. data:text/markdown;base64,...). Any content type, not just images.'
            ),
          name: z
            .string()
            .optional()
            .describe(
              'Filename for the attachment, including extension (e.g. "notes.md", "report.pdf"). Defaults to "attachment-<timestamp>".'
            ),
          mimeType: z
            .string()
            .optional()
            .describe(
              'MIME type of the data (e.g. "text/markdown", "application/pdf", "image/png"). Recommended for correct rendering in Trello. If omitted, inferred from a data URL prefix or the filename extension; falls back to "application/octet-stream".'
            ),
        },
      },
      async ({ boardId, cardId, data, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachDataToCard(
            boardId,
            cardId,
            data,
            name,
            mimeType
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(attachment, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach image data to card (image-flavored convenience over attach_data_to_card)
    this.server.registerTool(
      'attach_image_data_to_card',
      {
        title: 'Attach Image Data to Card',
        description:
          'Attach an image to a card from base64 data or a data URL. Image-flavored convenience over attach_data_to_card: defaults assume PNG when mimeType/name are omitted, suitable for screenshot pasting. For non-image content, use attach_data_to_card.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the image to'),
          imageData: z.string().describe('Base64 encoded image data or data URL (e.g., data:image/png;base64,...)'),
          name: z
            .string()
            .optional()
            .describe('Optional name for the attachment'),
          mimeType: z
            .string()
            .optional()
            .default('image/png')
            .describe('Optional MIME type (default: image/png)'),
        },
      },
      async ({ boardId, cardId, imageData, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachImageDataToCard(
            boardId,
            cardId,
            imageData,
            name,
            mimeType
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(attachment, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Get Card Attachments ──
    this.server.registerTool(
      'get_card_attachments',
      {
        title: 'Get Card Attachments',
        description: 'Get all attachments from a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card'),
        },
      },
      async ({ cardId }) => {
        try {
          const attachments = await this.trelloClient.getCardAttachments(cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ attachments }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Get Card Checklists ──
    this.server.registerTool(
      'get_card_checklists',
      {
        title: 'Get Card Checklists',
        description: 'Get all checklists on a card with their items and completion percentage',
        inputSchema: {
          cardId: z.string().describe('ID of the card'),
        },
      },
      async ({ cardId }) => {
        try {
          const checklists = await this.trelloClient.getCardChecklists(cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ checklists }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List all boards
    this.server.registerTool(
      'list_boards',
      {
        title: 'List Boards',
        description: 'List all boards the user has access to',
        inputSchema: {},
      },
      async () => {
        try {
          const boards = await this.trelloClient.listBoards();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(boards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Set active board
    this.server.registerTool(
      'set_active_board',
      {
        title: 'Set Active Board',
        description: 'Set the active board for future operations',
        inputSchema: {
          boardId: z.string().describe('ID of the board to set as active'),
        },
      },
      async ({ boardId }) => {
        try {
          const board = await this.trelloClient.setActiveBoard(boardId);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Successfully set active board to "${board.name}" (${board.id})`,
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List workspaces
    this.server.registerTool(
      'list_workspaces',
      {
        title: 'List Workspaces',
        description:
          'List workspaces the user has access to. If TRELLO_ALLOWED_WORKSPACES is configured, only allowed workspaces are returned.',
        inputSchema: {},
      },
      async () => {
        try {
          const workspaces = await this.trelloClient.listWorkspaces();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(workspaces, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Create a new board
    this.server.registerTool(
      'create_board',
      {
        title: 'Create Board',
        description: 'Create a new Trello board optionally within a workspace',
        inputSchema: {
          name: z.string().describe('Name of the board'),
          desc: z.string().optional().describe('Description of the board'),
          idOrganization: z
            .string()
            .min(1)
            .optional()
            .describe('Workspace ID to create the board in (uses active if not provided)'),
          defaultLabels: z
            .boolean()
            .optional()
            .default(true)
            .describe('Create default labels (true by default)'),
          defaultLists: z
            .boolean()
            .optional()
            .default(true)
            .describe('Create default lists (true by default)'),
        },
      },
      async ({ name, desc, idOrganization, defaultLabels, defaultLists }) => {
        try {
          const board = await this.trelloClient.createBoard({
            name,
            desc,
            idOrganization,
            defaultLabels,
            defaultLists,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(board, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Set active workspace
    this.server.registerTool(
      'set_active_workspace',
      {
        title: 'Set Active Workspace',
        description: 'Set the active workspace for future operations',
        inputSchema: {
          workspaceId: z.string().describe('ID of the workspace to set as active'),
        },
      },
      async ({ workspaceId }) => {
        try {
          const workspace = await this.trelloClient.setActiveWorkspace(workspaceId);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Successfully set active workspace to "${workspace.displayName}" (${workspace.id})`,
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List boards in workspace
    this.server.registerTool(
      'list_boards_in_workspace',
      {
        title: 'List Boards in Workspace',
        description: 'List all boards in a specific workspace',
        inputSchema: {
          workspaceId: z.string().describe('ID of the workspace to list boards from'),
        },
      },
      async ({ workspaceId }) => {
        try {
          const boards = await this.trelloClient.listBoardsInWorkspace(workspaceId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(boards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get active board info
    this.server.registerTool(
      'get_active_board_info',
      {
        title: 'Get Active Board Info',
        description: 'Get information about the currently active board',
        inputSchema: {},
      },
      async () => {
        try {
          const boardId = this.trelloClient.activeBoardId;
          if (!boardId) {
            return {
              content: [{ type: 'text' as const, text: 'No active board set' }],
              isError: true,
            };
          }
          const board = await this.trelloClient.getBoardById(boardId);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    ...board,
                    isActive: true,
                    activeWorkspaceId: this.trelloClient.activeWorkspaceId || 'Not set',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get card details
    this.server.registerTool(
      'get_card',
      {
        title: 'Get Card',
        description:
          'Get detailed information about a specific Trello card, including the reporter (the member who created it).',
        inputSchema: {
          cardId: z.string().describe('ID of the card to fetch'),
          includeMarkdown: z
            .boolean()
            .optional()
            .default(false)
            .describe('Whether to return card description in markdown format (default: false)'),
        },
      },
      async ({ cardId, includeMarkdown }) => {
        try {
          const card = await this.trelloClient.getCard(cardId, includeMarkdown);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get card details by board-local numeric short ID (idShort)
    this.server.registerTool(
      'get_card_by_short',
      {
        title: 'Get Card by Short ID',
        description:
          'Get detailed information about one or more Trello cards by their board-local numeric card number (idShort, e.g. 42), including the reporter (the member who created each card). Requires a board (falls back to the default board if configured). Pass an array of short IDs to fetch several cards in a single call; the response is then split into sections, each introduced by a "# Card #<n>: <name>" heading line, and short IDs that could not be fetched get a section describing the error instead of failing the whole call.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardShort: z
            .union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)])
            .describe(
              "The card's numeric short ID (the number shown in the UI, e.g. 42), or an array of short IDs (e.g. [42, 43, 51]) to fetch several cards at once"
            ),
          includeMarkdown: z
            .boolean()
            .optional()
            .default(false)
            .describe('Whether to return card description in markdown format (default: false)'),
        },
      },
      async ({ boardId, cardShort, includeMarkdown }) => {
        try {
          if (!Array.isArray(cardShort)) {
            const card = await this.trelloClient.getCardByShort(
              boardId,
              cardShort,
              includeMarkdown
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: typeof card === 'string' ? card : JSON.stringify(card, null, 2),
                },
              ],
            };
          }

          // Asking for the same card twice would just duplicate a large payload.
          const cardShorts = [...new Set(cardShort)];
          const results = await this.trelloClient.getCardsByShort(
            boardId,
            cardShorts,
            includeMarkdown
          );

          // Sections are delimited by an H1 that no card body can produce on its own: the
          // markdown renderer emits its single H1 as this heading, and pretty-printed JSON
          // never starts a line with "# ". That makes "^# Card #<n>" a reliable anchor for
          // grepping a card back out of a response large enough to be spilled to disk.
          const text = results
            .map(result => {
              const heading = `# Card #${result.cardShort}${result.name ? `: ${result.name}` : ''}`;
              if (result.error) {
                return `${heading}\n\nError: ${result.error}`;
              }
              if (includeMarkdown) {
                return result.card as string;
              }
              return `${heading}\n\n\`\`\`json\n${JSON.stringify(result.card, null, 2)}\n\`\`\``;
            })
            .join('\n\n');

          return {
            content: [{ type: 'text' as const, text }],
            // Only a wholly failed batch is an error; a partial one still carries usable cards.
            ...(results.every(result => result.error) ? { isError: true } : {}),
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a comment to a card
    this.server.registerTool(
      'add_comment',
      {
        title: 'Add Comment to Card',
        description: 'Add the given text as a new comment to the given card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to comment on'),
          text: z.string().describe('The text of the comment to add'),
        },
      },
      async ({ cardId, text }) => {
        try {
          const comment = await this.trelloClient.addCommentToCard(cardId, text);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update a comment to a card
    this.server.registerTool(
      'update_comment',
      {
        title: 'Update Comment on Card',
        description: 'Update the given comment with the new text',
        inputSchema: {
          commentId: z.string().describe('ID of the comment to change'),
          text: z.string().describe('The new text of the comment'),
        },
      },
      async ({ commentId, text }) => {
        try {
          const success = await this.trelloClient.updateCommentOnCard(commentId, text);
          return {
            content: [{ type: 'text' as const, text: success ? 'success' : 'failure' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Delete a comment from a card
    this.server.registerTool(
      'delete_comment',
      {
        title: 'Delete Comment from Card',
        description: 'Delete a comment from a Trello card',
        inputSchema: {
          commentId: z.string().describe('ID of the comment to delete'),
        },
      },
      async ({ commentId }) => {
        try {
          const success = await this.trelloClient.deleteCommentFromCard(commentId);
          return {
            content: [{ type: 'text' as const, text: success ? 'success' : 'failure' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get comments from a card
    this.server.registerTool(
      'get_card_comments',
      {
        title: 'Get Card Comments',
        description: 'Retrieve all comments from a specific Trello card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to get comments from'),
          limit: z
            .number()
            .optional()
            .default(100)
            .describe('Maximum number of comments to retrieve (default: 100)'),
        },
      },
      async ({ cardId, limit }) => {
        try {
          const comments = await this.trelloClient.getCardComments(cardId, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(comments, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Checklist tools
    this.server.registerTool(
      'create_checklist',
      {
        title: 'Create Checklist',
        description: 'Create a new checklist',
        inputSchema: {
          name: z.string().describe('Name of the checklist to create'),
          cardId: z.string().describe('ID of the Trello card'),
        },
      },
      async ({ name, cardId }) => {
        try {
          const items = await this.trelloClient.createChecklist(name, cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Checklist tools
    this.server.registerTool(
      'get_checklist_items',
      {
        title: 'Get Checklist Items',
        description: 'Get all items from a checklist by name',
        inputSchema: {
          name: z.string().describe('Name of the checklist to retrieve items from'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ name, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getChecklistItems(name, cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'add_checklist_item',
      {
        title: 'Add Checklist Item',
        description: 'Add a new item to a checklist',
        inputSchema: {
          text: z.string().describe('Text content of the checklist item'),
          checkListName: z.string().describe('Name of the checklist to add the item to'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ text, checkListName, cardId, boardId }) => {
        try {
          const item = await this.trelloClient.addChecklistItem(text, checkListName, cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'find_checklist_items_by_description',
      {
        title: 'Find Checklist Items by Description',
        description: 'Search for checklist items containing specific text in their description',
        inputSchema: {
          description: z.string().describe('Text to search for in checklist item descriptions'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ description, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.findChecklistItemsByDescription(
            description,
            cardId,
            boardId
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'get_acceptance_criteria',
      {
        title: 'Get Acceptance Criteria',
        description: 'Get all items from the "Acceptance Criteria" checklist',
        inputSchema: {
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getAcceptanceCriteria(cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'get_checklist_by_name',
      {
        title: 'Get Checklist by Name',
        description: 'Get a complete checklist with all its items and completion percentage',
        inputSchema: {
          name: z.string().describe('Name of the checklist to retrieve'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ name, cardId, boardId }) => {
        try {
          const checklist = await this.trelloClient.getChecklistByName(name, cardId, boardId);
          if (!checklist) {
            return {
              content: [{ type: 'text' as const, text: `Checklist "${name}" not found` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(checklist, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_checklist_item',
      {
        title: 'Update Checklist Item',
        description: 'Update a checklist item name, state, position, due date, reminder, or assigned member',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the checklist item'),
          checkItemId: z.string().describe('ID of the checklist item to update'),
          state: z
            .enum(['complete', 'incomplete'])
            .optional()
            .describe('New state for the checklist item'),
          name: z.string().optional().describe('New text for the checklist item'),
          pos: z
            .union([z.number(), z.enum(['top', 'bottom'])])
            .optional()
            .describe('New position for the checklist item'),
          due: z
            .string()
            .nullable()
            .optional()
            .describe('New due date for the checklist item in ISO 8601 format, or null to clear it'),
          dueReminder: z
            .number()
            .nullable()
            .optional()
            .describe('Reminder offset in minutes before due date, or null to clear it'),
          idMember: z
            .string()
            .nullable()
            .optional()
            .describe('Member ID to assign to the checklist item, or null to clear it'),
        },
      },
      async ({ cardId, checkItemId, name, state, pos, due, dueReminder, idMember }) => {
        try {
          const item = await this.trelloClient.updateChecklistItem(cardId, checkItemId, {
            name,
            state,
            pos,
            due,
            dueReminder,
            idMember,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_checklist_item',
      {
        title: 'Delete Checklist Item',
        description: 'Delete a checklist item from a card',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the checklist item'),
          checkItemId: z.string().describe('ID of the checklist item to delete'),
        },
      },
      async ({ cardId, checkItemId }) => {
        try {
          const deleted = await this.trelloClient.deleteChecklistItem(cardId, checkItemId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ deleted }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Member management tools
    this.server.registerTool(
      'get_board_members',
      {
        title: 'Get Board Members',
        description: 'Get all members of a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const members = await this.trelloClient.getBoardMembers(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(members, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'assign_member_to_card',
      {
        title: 'Assign Member to Card',
        description: 'Assign a member to a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to assign the member to'),
          memberId: z.string().describe('ID of the member to assign to the card'),
        },
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.assignMemberToCard(cardId, memberId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'remove_member_from_card',
      {
        title: 'Remove Member from Card',
        description: 'Remove a member from a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to remove the member from'),
          memberId: z.string().describe('ID of the member to remove from the card'),
        },
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.removeMemberFromCard(cardId, memberId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Label management tools
    this.server.registerTool(
      'get_board_labels',
      {
        title: 'Get Board Labels',
        description: 'Get all labels of a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const labels = await this.trelloClient.getBoardLabels(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(labels, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'create_label',
      {
        title: 'Create Label',
        description: 'Create a new label on a board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          name: z.string().describe('Name of the label'),
          color: z
            .string()
            .optional()
            .describe(
              'Color of the label (e.g., "red", "blue", "green", "yellow", "orange", "purple", "pink", "sky", "lime", "black", "null")'
            ),
        },
      },
      async ({ boardId, name, color }) => {
        try {
          const label = await this.trelloClient.createLabel(boardId, name, color);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(label, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_label',
      {
        title: 'Update Label',
        description: 'Update an existing label',
        inputSchema: {
          labelId: z.string().describe('ID of the label to update'),
          name: z.string().optional().describe('New name for the label'),
          color: z.string().optional().describe('New color for the label'),
        },
      },
      async ({ labelId, name, color }) => {
        try {
          const label = await this.trelloClient.updateLabel(labelId, name, color);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(label, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_label',
      {
        title: 'Delete Label',
        description: 'Delete a label from a board',
        inputSchema: {
          labelId: z.string().describe('ID of the label to delete'),
        },
      },
      async ({ labelId }) => {
        try {
          await this.trelloClient.deleteLabel(labelId);
          return {
            content: [{ type: 'text' as const, text: 'Label deleted successfully' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Copy a card (supports cross-board copy)
    this.server.registerTool(
      'copy_card',
      {
        title: 'Copy Card',
        description:
          'Copy/duplicate a Trello card to any list (even on a different board). Copies all properties by default including checklists, attachments, comments, labels, etc.',
        inputSchema: {
          sourceCardId: z.string().describe('ID of the source card to copy'),
          listId: z
            .string()
            .describe('ID of the destination list (can be on a different board)'),
          name: z
            .string()
            .optional()
            .describe('Override the name of the copied card (defaults to source card name)'),
          description: z
            .string()
            .optional()
            .describe('Override the description of the copied card'),
          keepFromSource: z
            .string()
            .optional()
            .describe(
              'Comma-separated list of properties to copy: "all" (default), or any combination of: attachments, checklists, comments, customFields, due, start, labels, members, stickers'
            ),
          pos: z
            .string()
            .optional()
            .describe('Position of the new card: "top", "bottom", or a positive float'),
        },
      },
      async ({ sourceCardId, listId, name, description, keepFromSource, pos }) => {
        try {
          const card = await this.trelloClient.copyCard({
            sourceCardId,
            listId,
            name,
            description,
            keepFromSource,
            pos,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Copy a checklist from one card to another
    this.server.registerTool(
      'copy_checklist',
      {
        title: 'Copy Checklist',
        description:
          'Copy a checklist (with all its items) from one card to another. Works across different boards.',
        inputSchema: {
          sourceChecklistId: z
            .string()
            .describe('ID of the source checklist to copy'),
          cardId: z
            .string()
            .describe('ID of the destination card to copy the checklist to'),
          name: z
            .string()
            .optional()
            .describe('Override the name of the copied checklist (defaults to source checklist name)'),
          pos: z
            .string()
            .optional()
            .describe('Position of the new checklist: "top", "bottom", or a positive number'),
        },
      },
      async ({ sourceChecklistId, cardId, name, pos }) => {
        try {
          const checklist = await this.trelloClient.copyChecklist({
            sourceChecklistId,
            cardId,
            name,
            pos,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(checklist, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add multiple cards to a list
    this.server.registerTool(
      'add_cards_to_list',
      {
        title: 'Add Cards to List',
        description:
          'Add multiple cards to a list in one operation. Cards are created sequentially (Trello API does not support batch writes). Rate limiting is handled automatically.',
        inputSchema: {
          listId: z.string().describe('ID of the list to add cards to'),
          cards: z
            .array(
              z.object({
                name: z.string().describe('Name of the card'),
                description: z.string().optional().describe('Description of the card'),
                dueDate: z
                  .string()
                  .optional()
                  .describe('Due date for the card (ISO 8601 format)'),
                start: z
                  .string()
                  .optional()
                  .describe('Start date for the card (YYYY-MM-DD format)'),
                labels: z
                  .array(z.string())
                  .optional()
                  .describe('Array of label IDs to apply to the card'),
              })
            )
            .describe('Array of cards to create (max 50)'),
        },
      },
      async ({ listId, cards }) => {
        try {
          const results = await this.trelloClient.batchAddCards(listId, cards);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Custom field management tools
    this.server.registerTool(
      'get_board_custom_fields',
      {
        title: 'Get Board Custom Fields',
        description:
          'Get all custom field definitions on a board. Returns field IDs, names, and types. ' +
          'For dropdown/list fields, also returns available options with their IDs. ' +
          'Requires Trello Standard plan or higher.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const fields = await this.trelloClient.getBoardCustomFields(boardId);

          const fieldsWithOptions = await Promise.all(
            fields.map(async (field) => {
              if (field.type !== 'list') {
                return field;
              }

              try {
                const options = await this.trelloClient.getCustomFieldOptions(field.id);
                return { ...field, options };
              } catch (error) {
                return {
                  ...field,
                  optionsError: error instanceof Error ? error.message : 'Failed to fetch options',
                };
              }
            })
          );

          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(fieldsWithOptions, null, 2) },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_card_custom_field',
      {
        title: 'Update Card Custom Field',
        description:
          'Set or clear a custom field value on a card. Requires Trello Standard plan or higher. ' +
          'Use get_board_custom_fields first to find field IDs and types. ' +
          'Value format depends on type: text=any string, number=numeric string, ' +
          'checkbox="true"/"false", date=ISO 8601 string, list=option ID from get_board_custom_fields. ' +
          'To clear a field, set type to "clear" and omit value.',
        inputSchema: {
          cardId: z.string().describe('ID of the card to update'),
          customFieldId: z.string().describe('ID of the custom field definition'),
          type: z
            .enum(['text', 'number', 'checkbox', 'date', 'list', 'clear'])
            .describe('The custom field type. Use "clear" to remove the value from the field.'),
          value: z
            .string()
            .optional()
            .describe(
              'The value to set. For text: any string. For number: numeric string (e.g. "42.5"). ' +
                'For checkbox: "true" or "false". For date: ISO 8601 (e.g. "2025-12-31T00:00:00.000Z"). ' +
                'For list: the option ID. Not needed when type is "clear".'
            ),
        },
      },
      async ({ cardId, customFieldId, type, value }) => {
        try {
          if (type !== 'clear' && !value) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: value is required when type is not "clear"',
                },
              ],
              isError: true,
            };
          }

          const result = await this.trelloClient.updateCardCustomField(cardId, customFieldId, {
            type,
            value,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Card history tool
    this.server.registerTool(
      'get_card_history',
      {
        title: 'Get Card History',
        description: 'Get the history/actions of a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to get history for'),
          filter: z
            .string()
            .optional()
            .describe(
              'Optional: Filter actions by type (e.g., "all", "updateCard:idList", "addAttachmentToCard", "commentCard", "updateCard:name", "updateCard:desc", "updateCard:due", "addMemberToCard", "removeMemberFromCard", "addLabelToCard", "removeLabelFromCard")'
            ),
          limit: z
            .number()
            .optional()
            .describe('Optional: Number of actions to fetch (default: all)'),
        },
      },
      async ({ cardId, filter, limit }) => {
        try {
          const history = await this.trelloClient.getCardHistory(cardId, filter, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Download attachment tool
    this.server.registerTool(
      'download_attachment',
      {
        title: 'Download Attachment',
        description: 'Download an attachment from a card. Returns base64-encoded data that can be saved or viewed.',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the attachment'),
          attachmentId: z.string().describe('ID of the attachment to download'),
        },
      },
      async ({ cardId, attachmentId }) => {
        try {
          const result = await this.trelloClient.downloadAttachment(cardId, attachmentId);

          // For images, return as image content type for direct viewing
          if (result.mimeType.startsWith('image/')) {
            return {
              content: [
                {
                  type: 'image' as const,
                  data: result.data,
                  mimeType: result.mimeType,
                },
                {
                  type: 'text' as const,
                  text: `Downloaded: ${result.fileName} (${result.mimeType})`,
                },
              ],
            };
          }

          // For non-images, return base64 data as text
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  fileName: result.fileName,
                  mimeType: result.mimeType,
                  data: result.data,
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
  }

  private setupHealthEndpoints() {
    // Basic health check endpoint
    this.server.registerTool('get_health', HealthEndpointSchemas.basicHealth, async () => {
      try {
        return await this.healthEndpoints.getBasicHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });

    // Detailed health diagnostic endpoint
    this.server.registerTool(
      'get_health_detailed',
      HealthEndpointSchemas.detailedHealth,
      async () => {
        try {
          return await this.healthEndpoints.getDetailedHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Metadata consistency check endpoint
    this.server.registerTool(
      'get_health_metadata',
      HealthEndpointSchemas.metadataHealth,
      async () => {
        try {
          return await this.healthEndpoints.getMetadataHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Performance metrics endpoint
    this.server.registerTool(
      'get_health_performance',
      HealthEndpointSchemas.performanceHealth,
      async () => {
        try {
          return await this.healthEndpoints.getPerformanceHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // System repair endpoint
    this.server.registerTool('perform_system_repair', HealthEndpointSchemas.repair, async () => {
      try {
        return await this.healthEndpoints.performRepair();
      } catch (error) {
        return this.handleError(error);
      }
    });
  }
}

/**
 * Build a fresh MCP server bound to the shared client + health endpoints.
 * HTTP mode calls this once per session; stdio mode calls it once. Declared as
 * a function so it is hoisted for the (safe, call-time-only) import cycle with
 * {@link ./http-server}.
 */
export function createMcpServer(client: TrelloClient, health: TrelloHealthEndpoints): McpServer {
  return new TrelloServer(client, health).getServer();
}

async function main(): Promise<void> {
  const client = createTrelloClient();
  const health = new TrelloHealthEndpoints(client);

  // Load configuration once, before serving (best effort; fall back to defaults).
  await client.loadConfig().catch(() => {
    // Continue with default config if loading fails
  });

  const httpConfig = readHttpConfig();

  if (httpConfig.transport === 'http') {
    const { close } = await startHttpServer(client, health, httpConfig);
    process.on('SIGINT', async () => {
      await close().catch(() => {});
      process.exit(0);
    });
    return;
  }

  // Default: stdio transport — single session, backward compatible.
  const server = createMcpServer(client, health);
  const transport = new StdioServerTransport();
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  await server.connect(transport);
}

/**
 * True only when this module is the process entry point (not when imported by
 * a test or by the HTTP server module). Guards the bootstrap so importing the
 * factory has no side effects.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    // stderr only — never stdout, which carries the stdio JSON-RPC stream.
    console.error('Fatal error starting Trello MCP server:', error);
    process.exit(1);
  });
}
