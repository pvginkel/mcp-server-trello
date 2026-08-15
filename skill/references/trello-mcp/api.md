# API reference

This server exposes Trello operations as MCP tools. Use these names exactly
when selecting tools.

## Board scope

Board-scoped tools take an optional `boardId`. It resolves in this order:
explicit `boardId` argument, then the active board, then `TRELLO_BOARD_ID`.
With ambient selection off there is no active board, so it is the argument or
`TRELLO_BOARD_ID` only. Ambient selection is on for the stdio transport and off
for the HTTP transport unless `TRELLO_MCP_AMBIENT_SELECTION` overrides it; see
`configuration.md`.

These tools accept `boardId`: `get_lists`, `get_recent_activity`, `move_card`
(the board the target `listId` lives on), `add_list_to_board`,
`get_card_by_short`, `get_checklist_items`, `add_checklist_item`,
`find_checklist_items_by_description`, `get_acceptance_criteria`,
`get_checklist_by_name`, `get_board_members`, `get_board_labels`,
`create_label`, and `get_board_custom_fields`.

No other tool accepts `boardId`. Card, list, and attachment tools are addressed
by the card or list ID alone, because those IDs are globally unique in Trello.

## Boards, workspaces, and lists

- `list_boards`: List boards available to the configured Trello account.
- `set_active_board`: Persist an active board for later operations. Registered
  only when ambient selection is on.
- `list_workspaces`: List workspaces available to the account.
- `set_active_workspace`: Persist an active workspace. Registered only when
  ambient selection is on.
- `list_boards_in_workspace`: List boards in a workspace, by explicit
  `workspaceId`.
- `get_active_board_info`: Show the active board and workspace state. Registered
  only when ambient selection is on.
- `get_lists`: Retrieve lists for a board.
- `add_list_to_board`: Create a list on a board.
- `archive_list`: Archive a list.
- `update_list_position`: Move a list to a new position.

## Cards

- `get_cards_by_list_id`: Fetch cards from a list.
- `get_card`: Fetch full card details.
- `add_card_to_list`: Create a card.
- `update_card_details`: Update card name, description, dates, labels, and due
  completion.
- `move_card`: Move a card to another list.
- `archive_card`: Archive a card.
- `copy_card`: Copy a card and selected properties.
- `add_cards_to_list`: Create several cards in one list.
- `get_my_cards`: List cards assigned to the current Trello user.
- `get_card_history`: Retrieve card activity history.

## Checklists

- `create_checklist`: Create a checklist on a card.
- `get_checklist_items`: Get items from a checklist by name.
- `add_checklist_item`: Add an item to a named checklist.
- `find_checklist_items_by_description`: Search checklist item text.
- `get_acceptance_criteria`: Get the `Acceptance Criteria` checklist.
- `get_checklist_by_name`: Get a checklist with items and completion percent.
- `update_checklist_item`: Rename, complete, reorder, date, or assign an item.
- `delete_checklist_item`: Remove a checklist item.
- `copy_checklist`: Copy a checklist between cards.

## Comments and attachments

- `add_comment`: Add a comment to a card.
- `update_comment`: Update a comment.
- `delete_comment`: Delete a comment.
- `get_card_comments`: List card comments.
- `attach_image_to_card`: Attach an image by URL.
- `attach_file_to_card`: Attach a file by URL.
- `attach_image_data_to_card`: Attach base64 image data.
- `download_attachment`: Download a card attachment.

## Labels and members

- `get_board_labels`: List board labels.
- `create_label`: Create a label.
- `update_label`: Update a label.
- `delete_label`: Delete a label.
- `get_board_members`: List board members.
- `assign_member_to_card`: Assign a member to a card.
- `remove_member_from_card`: Remove a member from a card.

## Health

- `get_health`: Return basic health.
- `get_health_detailed`: Return detailed health checks.
- `get_health_metadata`: Return server metadata health.
- `get_health_performance`: Return performance metrics.
- `perform_system_repair`: Attempt supported repair actions.
