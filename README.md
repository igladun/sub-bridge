# Sub Bridge

Use ChatGPT Pro/Max, Claude Max, etc. directly in Cursor via an MCP-managed OpenAI-compatible proxy.

[![Add Sub Bridge to Cursor](https://cursor.com/deeplink/mcp-install-dark.png)](cursor://anysphere.cursor-deeplink/mcp/install?name=sub-bridge&config=eyJjb21tYW5kIjogIm5weCIsICJhcmdzIjogWyIteSIsICJzdWItYnJpZGdlIl19)

## Quick start (Cursor MCP)

1. Install the MCP server:
   - Click the button above, or
   - Add an MCP server in Cursor with:
     - Command: `npx`
     - Args: `-y sub-bridge`
2. In Cursor chat, call the tool: `get_status`
3. Copy the public URL from the tool output and set:
   - OpenAI API Base URL: `<publicUrl>/v1`
   - OpenAI API Key: `sk-ant-xxx,sk-xxx`

Defaults:
- If no options are passed, the MCP server auto-starts an anonymous Cloudflare tunnel.
- The proxy starts automatically when the MCP server launches via `npx`.
