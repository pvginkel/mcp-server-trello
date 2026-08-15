# Trello MCP reference

This reference routes agents to the smallest useful context for Trello MCP
work. Start here, then load only the file that matches the task.

## Choose the right reference

- Use `configuration.md` when installing the bundled server, configuring MCP
  clients, setting Trello credentials, or troubleshooting setup.
- Use `api.md` when you need the available tool names grouped by capability.
- Use `patterns.md` when you need a proven sequence for board discovery, card
  updates, checklist workflows, comments, labels, members, or attachments.
- Use `gotchas.md` when a workflow touches dates, IDs, rate limits, destructive
  operations, proxies, or error recovery.

## Default workflow

Most tasks follow the same path.

1. Discover boards with `list_boards`.
2. Target the board: run `set_active_board` when that tool is registered,
   otherwise pass the board ID as `boardId` on each call that accepts it.
3. Discover lists with `get_lists`.
4. Discover cards with `get_cards_by_list_id` or `get_card`.
5. Make the requested change with the narrowest tool that fits the task.
6. Re-read the affected card, list, checklist, or board to verify the change.

`set_active_board`, `set_active_workspace`, and `get_active_board_info` exist
only when ambient board and workspace selection is on: on for the stdio
transport, off for the HTTP transport. Check `tools/list` before step 2, and see
`patterns.md` for the branch.

Do not invent Trello IDs. Fetch them from Trello through the MCP tools.
