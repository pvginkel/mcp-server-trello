# Workflow patterns

Use these patterns to keep Trello operations predictable and verifiable.

## Target a board

Do this first. Every pattern below depends on it.

Check `tools/list` for `set_active_board`.

- If it is there, ambient selection is on. Run it once with the target board ID,
  then omit `boardId` on later calls. `set_active_workspace` and
  `get_active_board_info` are available too.
- If it is not there, ambient selection is off, which is the default for the
  HTTP transport. There is no active board, and calling `set_active_board`,
  `set_active_workspace`, or `get_active_board_info` fails because the tools do
  not exist. Instead carry the board ID as an explicit `boardId` argument on
  every call that accepts one, or rely on `TRELLO_BOARD_ID`.

Only board-scoped tools accept `boardId`: `get_lists`, `get_recent_activity`,
`move_card`, `add_list_to_board`, `get_card_by_short`, `get_checklist_items`,
`add_checklist_item`, `find_checklist_items_by_description`,
`get_acceptance_criteria`, `get_checklist_by_name`, `get_board_members`,
`get_board_labels`, `create_label`, and `get_board_custom_fields`. Card, list,
and attachment tools take the card or list ID alone and no longer declare
`boardId`.

`list_boards`, `list_workspaces`, and `list_boards_in_workspace` work in both
modes; `list_boards_in_workspace` always takes an explicit `workspaceId`.

## Find and update a card

Use this sequence when the user names a board, list, or card instead of giving
IDs.

1. Run `list_boards`.
2. Target the matching board: run `set_active_board` when it is available,
   otherwise carry that board ID as `boardId` on the later steps that accept
   one, such as `get_lists` and `move_card`.
3. Run `get_lists`.
4. Run `get_cards_by_list_id` for likely lists.
5. Run `get_card` for the target card.
6. Run the requested write tool, such as `update_card_details` or `move_card`.
7. Run `get_card` again to verify the final state.

## Create a card with checklist work

Use this sequence for task setup.

1. Run `get_lists` and identify the destination list.
2. Run `add_card_to_list`.
3. Run `create_checklist` if the card needs a new checklist.
4. Run `add_checklist_item` for each item.
5. Run `get_card` or `get_checklist_by_name` to verify the checklist.

With no active board, pass `boardId` to `get_lists`, `add_checklist_item`, and
`get_checklist_by_name`. `add_card_to_list` and `create_checklist` never take
one.

## Work from acceptance criteria

Use the built-in acceptance criteria helper when a Trello card stores delivery
criteria in a checklist.

1. Run `get_acceptance_criteria`, passing `boardId` when there is no active
   board.
2. Map each checklist item to the requested work.
3. After implementation, run `update_checklist_item` to mark completed items
   only when the work has been verified.

## Attach generated or external assets

Use URL attachment tools when an asset is already hosted.

1. Run `get_card` to verify the target card.
2. Run `attach_image_to_card` for image URLs or `attach_file_to_card` for other
   file URLs.
3. Run `get_card` again and inspect attachments.

Use `attach_image_data_to_card` only when the image is available as base64 data.

## Comments for audit trails

Use comments for user-visible status notes.

1. Run `get_card` to verify the target.
2. Run `add_comment` with a concise note.
3. Run `get_card_comments` to confirm the comment was added.
