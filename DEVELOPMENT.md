# Development

## MCP settings (Cursor local)

Add an MCP server in Cursor with:

- Command: `npx`
- Args: `-y sub-bridge`

Then, in Cursor chat, call the tool: `get_status` and use the returned `publicUrl` to set your OpenAI API Base URL to `<publicUrl>/v1`.

If you need custom options, append them after `sub-bridge` in the args list (example: `-y sub-bridge --port 8787`).
