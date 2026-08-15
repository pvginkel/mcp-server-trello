# Configuration

The skill bundles the Trello MCP server source and installs it locally on first
use. The server communicates over MCP stdio by default and requires Trello API
credentials.

## Install

Run the bundled installer from the skill root.

```bash
bash {skill-root}/scripts/install.sh
```

When Bun is available, the installer copies `assets/source/` to
`{XDG_DATA_HOME:-$HOME/.local/share}/mcp-server-trello-skill/server`, installs
dependencies, and builds `build/index.js`. When Bun is unavailable, it falls
back to the published Smithery installation path and creates a local
`build/index.js` wrapper that launches the published package through `npx`.

## MCP command

For clients that need a direct command, use the built server path.

```json
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": [
        "{XDG_DATA_HOME:-$HOME/.local/share}/mcp-server-trello-skill/server/build/index.js"
      ],
      "env": {
        "TRELLO_API_KEY": "your-api-key",
        "TRELLO_TOKEN": "your-token"
      }
    }
  }
}
```

Expand `{XDG_DATA_HOME:-$HOME/.local/share}` before adding the command to a
client configuration.

## Environment variables

- `TRELLO_API_KEY`: Required Trello API key.
- `TRELLO_TOKEN`: Required Trello token for the Trello account.
- `TRELLO_BOARD_ID`: Optional default board ID. Used whenever a board-scoped
  tool is called without `boardId` and no active board applies. Works in both
  selection modes.
- `TRELLO_WORKSPACE_ID`: Optional initial workspace ID.
- `TRELLO_MCP_AMBIENT_SELECTION`: Optional `on` or `off`. Controls whether the
  server holds an active board and workspace across calls. Unset, it follows the
  transport: on for stdio, off for HTTP (`TRELLO_MCP_TRANSPORT=http`). Any other
  value fails at startup.
- `https_proxy` or `HTTPS_PROXY`: Optional HTTPS proxy for restricted networks.

Get the API key from `https://trello.com/app-key`, then generate a token from
that key page.

## Ambient board and workspace selection

With ambient selection **on**, the server keeps an active board and workspace
across calls and persists them to `~/.trello-mcp/config.json`. Board-scoped
tools resolve their target as: explicit `boardId` argument, then the active
board, then `TRELLO_BOARD_ID`.

With ambient selection **off**:

- `set_active_board`, `set_active_workspace`, and `get_active_board_info` are
  not registered and do not appear in `tools/list`.
- There is no active board. Board resolution is the explicit `boardId` argument,
  then `TRELLO_BOARD_ID`.
- Workspace targeting is explicit only, so `create_board` under
  `TRELLO_ALLOWED_WORKSPACES` requires an explicit `idOrganization`.
- `~/.trello-mcp/config.json` is neither read nor written.

Off is the default for the HTTP transport because one Trello client is shared by
every session: an active board set by one client would silently retarget another
client's unqualified calls. Stdio keeps ambient selection on.

## Build artifacts

The install script writes generated runtime files under the user data directory,
not inside the skill. The source of truth remains `assets/source/` in this skill
package.
