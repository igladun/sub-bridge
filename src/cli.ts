#!/usr/bin/env node
import { Hono, Context } from 'hono'
import { stream } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { program } from 'commander'
import chalk from 'chalk'
import { Tunnel } from 'cloudflared'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
} from './utils/anthropic-to-openai-converter'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'

// ============================================================================
// CONFIGURATION
// ============================================================================

interface Config {
  port: number
  opusModel: string      // Model name in Cursor that maps to Claude Opus
  sonnetModel: string    // Model name in Cursor that maps to Claude Sonnet
  tunnelUrl?: string     // Existing cloudflare tunnel URL (e.g., local.buremba.com)
  useAnonymousTunnel: boolean
  verbose: boolean
}

let verboseMode = false
const log = (...args: Parameters<typeof console.error>) => console.error(...args)

const OPENAI_BASE_URL = 'https://api.openai.com'

// ============================================================================
// CLI LOGGING (Claude Code style with ⏺)
// ============================================================================

let requestCounter = 0

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

// Parse API keys from Authorization header (comma-separated)
// Returns { anthropic?: string, openai?: string }
function parseApiKeys(authHeader: string | undefined): { anthropic?: string; openai?: string } {
  if (!authHeader) return {}

  const token = authHeader.replace(/^Bearer\s+/i, '')
  const keys = token.split(',').map(k => k.trim()).filter(Boolean)

  const result: { anthropic?: string; openai?: string } = {}

  for (const key of keys) {
    if (key.startsWith('sk-ant-')) {
      // Anthropic OAuth token (sk-ant-oat-) or API key (sk-ant-api-)
      result.anthropic = key
    } else if (key.startsWith('sk-')) {
      // OpenAI API key
      result.openai = key
    }
  }

  return result
}

function getMissingKeyInstructions(provider: 'anthropic' | 'openai'): string {
  if (provider === 'anthropic') {
    return `Missing Anthropic API key. To set up:

1. Run: claude setup-token
   Or: codex login

2. In Cursor Settings → Models → OpenAI API Key, set:
   sk-ant-xxx,sk-xxx  (Anthropic key, OpenAI key - comma separated)

Your key should start with "sk-ant-"`
  } else {
    return `Missing OpenAI API key. To set up:

1. Run: codex login
   Or get an API key from https://platform.openai.com/api-keys

2. In Cursor Settings → Models → OpenAI API Key, set:
   sk-ant-xxx,sk-xxx  (Anthropic key, OpenAI key - comma separated)

Your key should start with "sk-"`
  }
}

function logRequest(
  route: 'claude' | 'openai' | 'bypass',
  model: string,
  data: {
    system?: string
    messages?: any[]
    tools?: any[]
    tokens?: number
  }
) {
  requestCounter++

  const routeColors = {
    claude: chalk.cyan,
    openai: chalk.yellow,
    bypass: chalk.gray,
  }
  const routeLabels = {
    claude: 'Claude',
    openai: 'OpenAI',
    bypass: 'Bypass',
  }
  const roleColors: Record<string, typeof chalk.blue> = {
    user: chalk.blue,
    assistant: chalk.green,
    system: chalk.magenta,
    tool: chalk.yellow,
  }

  // Header with token count
  log()
  const tokenInfo = data.tokens ? ` ${chalk.dim(`(~${data.tokens.toLocaleString()} tokens)`)}` : ''
  log(`${routeColors[route]('⏺')} ${chalk.bold(routeLabels[route])} ${chalk.dim(`#${requestCounter}`)} ${chalk.dim('·')} ${model}${tokenInfo}`)

  // Tools
  if (data.tools?.length) {
    log()
    log(`  ${chalk.green('⏺')} ${chalk.green('Tools')} ${chalk.dim(`(${data.tools.length})`)}`)
    const toolNames = data.tools.map((t: any) => t.name || t.function?.name || '?')

    if (verboseMode) {
      // Show all tools, one per line
      for (const name of toolNames) {
        log(`    ${chalk.dim(name)}`)
      }
    } else {
      // Truncate: show first 8 tools
      const shown = toolNames.slice(0, 8)
      log(`    ${chalk.dim(shown.join(', '))}${toolNames.length > 8 ? chalk.dim(` ... +${toolNames.length - 8} more`) : ''}`)
    }
  }

  // System prompt
  if (data.system) {
    log()
    log(`  ${chalk.magenta('⏺')} ${chalk.magenta('System')}`)
    if (verboseMode) {
      const lines = data.system.split('\n')
      for (const line of lines) {
        log(`    ${chalk.dim(line)}`)
      }
    } else {
      // Truncate to first 200 chars
      const preview = data.system.replace(/\n/g, ' ').slice(0, 200)
      log(`    ${chalk.dim(preview)}${data.system.length > 200 ? '...' : ''}`)
    }
  }

  // Messages
  if (data.messages?.length) {
    log()

    const messagesToShow = verboseMode ? data.messages : data.messages.slice(-5)

    if (!verboseMode && data.messages.length > 5) {
      log(`  ${chalk.dim('⏺')} ${chalk.dim(`... ${data.messages.length - 5} earlier messages`)}`)
      log()
    }

    for (const msg of messagesToShow) {
      // Detect role from various formats
      let role = msg.role
      if (!role) {
        if (msg.type === 'human') role = 'user'
        else if (msg.type === 'ai') role = 'assistant'
        else if (msg.type === 'function' || msg.type === 'tool') role = 'tool'
        else if (msg.type === 'system') role = 'system'
      }

      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const parts: string[] = []
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text)
          } else if (block.type === 'tool_use') {
            parts.push(`[tool: ${block.name}]`)
          } else if (block.type === 'tool_result') {
            const resultContent = verboseMode ? String(block.content || '') : truncate(String(block.content || ''), 50)
            parts.push(`[result: ${resultContent}]`)
          } else if (block.type === 'image' || block.type === 'image_url') {
            parts.push('[image]')
          } else {
            parts.push(`[${block.type || '?'}]`)
          }
        }
        content = parts.join(' ')
      }

      if (msg.tool_calls?.length) {
        const toolNames = msg.tool_calls.map((tc: any) => tc.function?.name || tc.name || '?')
        content = content ? `${content} → [tools: ${toolNames.join(', ')}]` : `[tools: ${toolNames.join(', ')}]`
      }

      // Skip empty messages without role
      if (!role && !content) continue

      // Default role if still unknown - show message keys in verbose mode for debugging
      if (!role) {
        role = 'unknown'
        if (verboseMode) {
          log(chalk.yellow(`  [DEBUG] Unknown message format: ${JSON.stringify(Object.keys(msg))}`))
        }
      }
      const color = roleColors[role] || chalk.gray

      log(`  ${color('⏺')} ${color(role)}`)
      if (verboseMode) {
        const lines = content.split('\n')
        for (const line of lines) {
          log(`    ${chalk.dim(line)}`)
        }
      } else {
        // Truncate message to 150 chars
        const preview = content.replace(/\n/g, ' ').slice(0, 150)
        log(`    ${chalk.dim(preview)}${content.length > 150 ? '...' : ''}`)
      }
    }
  }
}

function logResponse(status: number, tokens?: { input?: number, output?: number, cached?: number }) {
  const statusColor = status < 400 ? chalk.green : chalk.red
  const statusText = status < 400 ? 'OK' : 'Error'

  let tokenInfo = ''
  if (tokens?.input || tokens?.output) {
    const parts = []
    if (tokens.input) parts.push(`${tokens.input} in`)
    if (tokens.output) parts.push(`${tokens.output} out`)
    if (tokens.cached) parts.push(chalk.cyan(`${tokens.cached} cached`))
    tokenInfo = ` ${chalk.dim('·')} ${parts.join(' → ')}`
  }

  log()
  log(`  ${statusColor('⏺')} ${statusColor(statusText)} ${chalk.dim(status)}${tokenInfo}`)
  log()
}

function logError(message: string) {
  log()
  log(`  ${chalk.red('⏺')} ${chalk.red('Error')}: ${message}`)
  log()
}

// ============================================================================
// SERVER
// ============================================================================

function createServer(config: Config) {
  const app = new Hono()

  app.options('*', corsPreflightHandler)
  app.use('*', corsMiddleware)

  // Health check
  app.get('/', (c) => c.json({ status: 'ok', service: 'sub-bridge' }))

  // Models endpoint
  app.get('/v1/models', async (c) => {
    const response = await fetch('https://models.dev/api.json')
    if (!response.ok) {
      return c.json({ object: 'list', data: [] })
    }
    const modelsData = await response.json() as any
    const anthropicModels = modelsData.anthropic?.models || {}

    const models = Object.entries(anthropicModels).map(([modelId, modelData]: [string, any]) => ({
      id: modelId,
      object: 'model' as const,
      created: Math.floor(new Date(modelData.release_date || '1970-01-01').getTime() / 1000),
      owned_by: 'anthropic',
    }))

    return c.json({ object: 'list', data: models })
  })

  // Main chat completions endpoint
  app.post('/v1/chat/completions', async (c) => {
    return handleChatCompletion(c, config)
  })

  app.post('/v1/messages', async (c) => {
    return handleChatCompletion(c, config)
  })

  return app
}

async function handleChatCompletion(c: Context, config: Config) {
  const body = await c.req.json()
  const requestedModel = body.model || ''
  const isStreaming = body.stream === true

  // Bypass cursor key check
  if (isCursorKeyCheck(body)) {
    logRequest('bypass', requestedModel, {})
    logResponse(200)
    return c.json(createCursorBypassResponse())
  }

  // Determine routing
  const isOpus = requestedModel === config.opusModel
  const isSonnet = requestedModel === config.sonnetModel
  const isClaude = isOpus || isSonnet || requestedModel.startsWith('claude-')

  // Parse API keys from header
  const apiKeys = parseApiKeys(c.req.header('authorization'))

  if (!isClaude) {
    // === OPENAI PASSTHROUGH ===
    logRequest('openai', requestedModel, { messages: body.messages, tools: body.tools })

    if (!apiKeys.openai) {
      const instructions = getMissingKeyInstructions('openai')
      return c.json({
        id: 'error',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: instructions },
          finish_reason: 'stop'
        }]
      })
    }

    const response = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKeys.openai}` },
      body: JSON.stringify(body),
    })

    logResponse(response.status)

    if (isStreaming && response.ok) {
      const reader = response.body!.getReader()
      return stream(c, async (s) => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await s.write(value)
        }
        reader.releaseLock()
      })
    }

    const data = await response.json()
    return c.json(data, response.status as any)
  }

  // === CLAUDE ROUTING ===
  const claudeModel = isOpus
    ? 'claude-opus-4-5-20251101'
    : isSonnet
      ? 'claude-sonnet-4-5-20250514'
      : requestedModel

  // Check for Anthropic API key
  if (!apiKeys.anthropic) {
    const instructions = getMissingKeyInstructions('anthropic')
    logResponse(200)
    return c.json({
      id: 'instructions',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: instructions },
        finish_reason: 'stop'
      }]
    })
  }

  // Transform request
  body.model = claudeModel

  // Handle Cursor's "input" format (OpenAI Responses API style)
  // Cursor sends: { input: "user message" or [...], user: "system prompt", ... }
  if (body.input !== undefined && !body.messages) {
    // Convert input to messages format
    if (typeof body.input === 'string') {
      body.messages = [{ role: 'user', content: body.input }]
    } else if (Array.isArray(body.input)) {
      body.messages = body.input
    }
    // "user" field in this format is actually the system instructions
    if (body.user && typeof body.user === 'string') {
      body.messages = [{ role: 'system', content: body.user }, ...body.messages]
    }
  }

  // Extract system messages
  const systemMessages = body.messages?.filter((msg: any) => msg.role === 'system') || []
  body.messages = body.messages?.filter((msg: any) => msg.role !== 'system') || []

  // If no messages left after filtering, return error
  if (body.messages.length === 0) {
    logError('No user messages in request')
    return c.json({ error: 'No messages provided' }, 400)
  }

  // Build system prompt - must include Claude Code identifier for OAuth token to work
  body.system = [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ...systemMessages.map((msg: any) => ({ type: 'text', text: msg.content || '' })),
  ]

  // Estimate context size for logging
  const contextSize = JSON.stringify(body.messages || []).length
  const contextTokensEstimate = Math.ceil(contextSize / 4)

  // Log the request with full details
  const systemText = body.system.map((s: any) => s.text).join('\n')
  logRequest('claude', `${requestedModel} → ${claudeModel}`, {
    system: systemText,
    messages: body.messages,
    tools: body.tools,
    tokens: contextTokensEstimate
  })

  // Set max tokens
  body.max_tokens = claudeModel.includes('opus') ? 32_000 : 64_000

  // Convert message format
  body.messages = convertMessages(body.messages)

  // Convert tools format
  if (body.tools?.length) {
    body.tools = body.tools.map((tool: any, idx: number) => {
      let converted: any
      if (tool.type === 'function' && tool.function) {
        converted = {
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object', properties: {} }
        }
      } else if (tool.name) {
        converted = {
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
      } else {
        converted = tool
      }
      if (idx === body.tools.length - 1) {
        converted.cache_control = { type: 'ephemeral' }
      }
      return converted
    })
  }

  // Convert tool_choice
  if (body.tool_choice === 'auto') {
    body.tool_choice = { type: 'auto' }
  } else if (body.tool_choice === 'none' || body.tool_choice === null) {
    delete body.tool_choice
  } else if (body.tool_choice === 'required') {
    body.tool_choice = { type: 'any' }
  } else if (body.tool_choice?.function?.name) {
    body.tool_choice = { type: 'tool', name: body.tool_choice.function.name }
  }

  // Add cache control to system
  if (body.system.length > 0) {
    body.system[body.system.length - 1].cache_control = { type: 'ephemeral' }
  }

  // Clean body - only keep Anthropic-supported fields
  const cleanBody: any = {}
  const allowedFields = ['model', 'messages', 'max_tokens', 'stop_sequences', 'stream', 'system', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice']
  for (const field of allowedFields) {
    if (body[field] !== undefined) cleanBody[field] = body[field]
  }

  // Make request to Anthropic
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKeys.anthropic}`,
      'anthropic-beta': 'oauth-2025-04-20,prompt-caching-2024-07-31',
      'anthropic-version': '2023-06-01',
      'accept': isStreaming ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(cleanBody),
  })

  if (!response.ok) {
    const error = await response.text()
    logError(error.slice(0, 200))
    return new Response(error, { status: response.status })
  }

  logResponse(response.status)

  if (isStreaming) {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const converterState = createConverterState()

    return stream(c, async (s) => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const results = processChunk(converterState, chunk, false)
        for (const result of results) {
          if (result.type === 'chunk') {
            await s.write(`data: ${JSON.stringify(result.data)}\n\n`)
          } else if (result.type === 'done') {
            await s.write('data: [DONE]\n\n')
          }
        }
      }
      reader.releaseLock()
    })
  } else {
    const responseData = await response.json()
    const openAIResponse = convertNonStreamingResponse(responseData as any)
    return c.json(openAIResponse)
  }
}

function convertMessages(messages: any[]): any[] {
  const converted: any[] = []

  for (const msg of messages) {
    // Handle custom tool types from Cursor
    if (msg.type === 'custom_tool_call' || msg.type === 'function_call') {
      let toolInput = msg.input || msg.arguments
      if (typeof toolInput === 'string') {
        try { toolInput = JSON.parse(toolInput) } catch { toolInput = { command: toolInput } }
      }
      const toolUse = { type: 'tool_use', id: msg.call_id, name: msg.name, input: toolInput || {} }
      const last = converted[converted.length - 1]
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        last.content.push(toolUse)
      } else {
        converted.push({ role: 'assistant', content: [toolUse] })
      }
      continue
    }

    if (msg.type === 'custom_tool_call_output' || msg.type === 'function_call_output') {
      const toolResult = { type: 'tool_result', tool_use_id: msg.call_id, content: msg.output || '' }
      const last = converted[converted.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(toolResult)
      } else {
        converted.push({ role: 'user', content: [toolResult] })
      }
      continue
    }

    if (!msg.role) continue

    // Convert assistant with tool_calls
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content: any[] = msg.content ? [{ type: 'text', text: msg.content }] : []
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || tc.name,
          input: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments || tc.arguments || {})
        })
      }
      converted.push({ role: 'assistant', content })
      continue
    }

    // Convert tool results
    if (msg.role === 'tool') {
      const toolResult = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }
      const last = converted[converted.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(toolResult)
      } else {
        converted.push({ role: 'user', content: [toolResult] })
      }
      continue
    }

    // Pass through other messages
    converted.push({ role: msg.role, content: msg.content ?? '' })
  }

  // Trim trailing whitespace from last assistant message
  const last = converted[converted.length - 1]
  if (last?.role === 'assistant') {
    if (typeof last.content === 'string') {
      last.content = last.content.trimEnd() || '...'
    } else if (Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === 'text') block.text = (block.text?.trimEnd()) || '...'
      }
    }
  }

  return converted
}

// ============================================================================
// CLI
// ============================================================================

type TunnelType = 'existing' | 'anonymous'

interface StartupStatus {
  publicUrl: string
  localPort: number
  tunnelType: TunnelType
  config: Config
  startedAt: string
}

function buildStatusText(status: StartupStatus): string {
  const baseUrl = `${status.publicUrl.replace(/\/$/, '')}/v1`
  const tunnelLabel = status.tunnelType === 'anonymous' ? 'Cloudflare anonymous' : 'Existing tunnel'

  return [
    'Sub Bridge',
    `Status: running`,
    `Public URL: ${status.publicUrl}`,
    `Local URL: http://localhost:${status.localPort}`,
    `Tunnel: ${tunnelLabel}`,
    '',
    'Model routing:',
    `- ${status.config.opusModel} -> Claude Opus 4.5`,
    `- ${status.config.sonnetModel} -> Claude Sonnet 4.5`,
    '- Other models -> OpenAI (passthrough)',
    '',
    'Cursor setup:',
    `1) OpenAI API Base URL: ${baseUrl}`,
    '2) OpenAI API Key: sk-ant-xxx,sk-xxx (Anthropic + OpenAI keys)',
    '3) Select the model in chat',
    '',
    'Token notes:',
    '- Run `claude setup-token` to copy your Anthropic token',
    '- Or run `codex login` to fetch a compatible token',
    '',
    'Subscriptions supported: ChatGPT Pro/Max, Claude Max, etc.',
  ].join('\n')
}

async function startProxy(config: Config): Promise<StartupStatus> {
  const app = createServer(config)

  return new Promise((resolve, reject) => {
    serve(
      {
        fetch: app.fetch,
        port: config.port,
      },
      async (info) => {
        let publicUrl = ''
        let tunnelType: TunnelType = 'existing'

        if (config.tunnelUrl) {
          publicUrl = `https://${config.tunnelUrl}`
          tunnelType = 'existing'
          printStartupInfo(config, publicUrl, tunnelType, info.port)
          resolve({
            publicUrl,
            localPort: info.port,
            tunnelType,
            config,
            startedAt: new Date().toISOString(),
          })
          return
        }

        if (config.useAnonymousTunnel) {
          log(chalk.dim('\n  Starting tunnel...'))
          try {
            const tunnel = Tunnel.quick(`http://localhost:${info.port}`)

            publicUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
              const timeout = setTimeout(
                () => rejectUrl(new Error('Tunnel timeout')),
                30000,
              )
              tunnel.once('url', (url: string) => {
                clearTimeout(timeout)
                resolveUrl(url)
              })
              tunnel.once('error', (err: Error) => {
                clearTimeout(timeout)
                rejectUrl(err)
              })
            })

            tunnelType = 'anonymous'
            printStartupInfo(config, publicUrl, tunnelType, info.port)

            const cleanup = () => {
              tunnel.stop()
              process.exit(0)
            }
            process.on('SIGINT', cleanup)
            process.on('SIGTERM', cleanup)

            resolve({
              publicUrl,
              localPort: info.port,
              tunnelType,
              config,
              startedAt: new Date().toISOString(),
            })
            return
          } catch (err) {
            log(chalk.red('\n  Failed to start tunnel:'), (err as Error).message)
            log(chalk.dim('  Make sure cloudflared binary is installed.\n'))
            reject(err)
            return
          }
        }

        publicUrl = `http://localhost:${info.port}`
        tunnelType = 'existing'
        printStartupInfo(config, publicUrl, tunnelType, info.port)
        resolve({
          publicUrl,
          localPort: info.port,
          tunnelType,
          config,
          startedAt: new Date().toISOString(),
        })
      },
    )
  })
}

async function main() {
  program
    .name('sub-bridge')
    .description('MCP bridge that starts a Cursor-ready proxy for ChatGPT Pro, Claude Max, etc.')
    .option('-p, --port <number>', 'Local proxy port (default: 8787)')
    .option('--opus <model>', 'Cursor model → Claude Opus 4.5 (default: o3)')
    .option('--sonnet <model>', 'Cursor model → Claude Sonnet 4.5 (default: o3-mini)')
    .option('--tunnel <url>', 'Existing tunnel URL (e.g., local.buremba.com)')
    .option('--anonymous', 'Use anonymous Cloudflare tunnel (temporary URL)')
    .option('--verbose', 'Show full messages and tools without truncation')
    .parse()

  const opts = program.opts()
  const hasArgs = process.argv.slice(2).length > 0
  const useAnonymousTunnel = opts.anonymous || !opts.tunnel
  const port =
    opts.port !== undefined
      ? parseInt(opts.port, 10)
      : useAnonymousTunnel
        ? 0
        : 8787

  const config: Config = {
    port,
    opusModel: opts.opus || 'o3',
    sonnetModel: opts.sonnet || 'o3-mini',
    tunnelUrl: opts.tunnel,
    useAnonymousTunnel,
    verbose: opts.verbose || false,
  }

  verboseMode = config.verbose

  if (!hasArgs) {
    config.useAnonymousTunnel = true
  }

  const status = await startProxy(config)
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({
    name: 'Sub Bridge',
    version: '2.1.0',
  })

  server.tool(
    'get_status',
    'Get the running status, public URL, and setup steps for ChatGPT Pro/Max, Claude Max, etc.',
    {},
    async () => ({
      content: [
        {
          type: 'text',
          text: buildStatusText(status),
        },
      ],
    }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('[sub-bridge] MCP server started')
}

function printStartupInfo(config: Config, publicUrl: string, tunnelType: 'existing' | 'anonymous', localPort: number) {
  log()
  log(chalk.bold.cyan('  Sub Bridge'))
  log(chalk.dim('  ─────────────────────────────────────'))
  log()
  log(' ', chalk.green(publicUrl))
  if (tunnelType === 'existing') {
    log(chalk.dim(`  → localhost:${localPort}`))
    log(chalk.dim('  (ensure your tunnel is running)'))
  }
  log()
  log(chalk.dim('  Model routing:'))
  log(chalk.dim('    ├─'), `${chalk.bold(config.opusModel)} → Claude Opus 4.5`)
  log(chalk.dim('    ├─'), `${chalk.bold(config.sonnetModel)} → Claude Sonnet 4.5`)
  log(chalk.dim('    └─'), `Other models → OpenAI (passthrough)`)
  log()
  log(chalk.bold.yellow('  Setup in Cursor:'))
  log(chalk.dim('  ─────────────────────────────────────'))
  log()
  log(chalk.dim('  Settings → Cursor Settings → Models'))
  log()
  log(chalk.dim('  1.'), 'OpenAI API Base URL:')
  log(chalk.dim('     '), chalk.cyan.bold(`${publicUrl}/v1`))
  log(chalk.dim('  2.'), 'OpenAI API Key (comma-separated):')
  log(chalk.dim('     '), chalk.cyan('sk-ant-xxx,sk-xxx'))
  log(chalk.dim('     '), chalk.dim('(Anthropic + OpenAI keys)'))
  log(chalk.dim('  3.'), 'Select model in chat:')
  log(chalk.dim('     '), `${chalk.cyan.bold(config.opusModel)} → Claude Opus`)
  log(chalk.dim('     '), `${chalk.cyan.bold(config.sonnetModel)} → Claude Sonnet`)
  log()
  log(chalk.dim('  Subscriptions: ChatGPT Pro, Claude Max, etc.'))
  log()
  log(chalk.dim('  Use MCP tool: "get_status" to fetch URL + setup anytime'))
  log()
}

main().catch((error) => {
  log('[sub-bridge] Fatal error:', error)
  process.exit(1)
})
