import { Hono, Context } from 'hono'

// Configuration: which model triggers Claude routing (default: o3)
// All other models will be proxied to OpenAI directly
const CLAUDE_TRIGGER_MODEL = process.env.CLAUDE_MODEL || 'o3'
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com'

console.log(`🎯 Claude trigger model: "${CLAUDE_TRIGGER_MODEL}"`)
console.log(`📡 OpenAI passthrough: uses Authorization header from Cursor`)

function parseApiKeys(authHeader: string | undefined): { anthropic?: string; openai?: string } {
  if (!authHeader) return {}

  const token = authHeader.replace(/^Bearer\s+/i, '')
  const keys = token.split(',').map(k => k.trim()).filter(Boolean)

  const result: { anthropic?: string; openai?: string } = {}

  for (const key of keys) {
    if (key.startsWith('sk-ant-')) {
      result.anthropic = key
    } else if (key.startsWith('sk-')) {
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
  }

  return `Missing OpenAI API key. To set up:

1. Run: codex login
   Or get an API key from https://platform.openai.com/api-keys

2. In Cursor Settings → Models → OpenAI API Key, set:
   sk-ant-xxx,sk-xxx  (Anthropic key, OpenAI key - comma separated)

Your key should start with "sk-"`
}

// Log storage for viewer
interface LogEntry {
  id: string
  timestamp: string
  request: {
    model: string
    messagesCount: number
    toolsCount: number
    systemLength: number
    bodySize: string
    fullBody?: any
    efficiencyMode?: 'simple' | 'critical' | 'heavy' | 'standard'
    contextTokens?: number
  }
  response: {
    status: number
    error?: string
    bodyPreview?: string
    cacheStats?: {
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      inputTokens: number
      outputTokens: number
    }
  }
}

const logs: LogEntry[] = []
const MAX_LOGS = 50
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import type {
  AnthropicRequestBody,
  AnthropicResponse,
  ErrorResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// OAuth endpoints removed: use Cursor-provided tokens instead.

// Log viewer endpoint
app.get('/logs', (c: Context) => {
  return c.html(`<!DOCTYPE html>
<html>
<head>
  <title>Sub Bridge Proxy Logs</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; margin: 0; padding: 20px; }
    h1 { color: #00d9ff; margin-bottom: 20px; }
    .log-entry { background: #16213e; border-radius: 8px; margin-bottom: 15px; overflow: hidden; border: 1px solid #0f3460; }
    .log-header { padding: 12px 15px; background: #0f3460; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
    .log-header:hover { background: #1a4a7a; }
    .log-id { color: #00d9ff; font-weight: bold; }
    .log-time { color: #888; font-size: 12px; }
    .log-meta { display: flex; gap: 15px; font-size: 13px; }
    .log-meta span { padding: 2px 8px; border-radius: 4px; background: #1a1a2e; }
    .success { color: #00ff88; }
    .error { color: #ff6b6b; }
    .log-body { display: none; padding: 15px; border-top: 1px solid #0f3460; }
    .log-body.open { display: block; }
    .section { margin-bottom: 15px; }
    .section-title { color: #00d9ff; font-size: 14px; margin-bottom: 8px; font-weight: bold; cursor: pointer; user-select: none; }
    .section-title:hover { color: #00f0ff; }
    .section-title::before { content: '▶ '; display: inline-block; transition: transform 0.2s; }
    .section-title.open::before { transform: rotate(90deg); }
    .section-content { display: none; }
    .section-content.open { display: block; }
    .message-list { display: flex; flex-direction: column; gap: 10px; }
    .message { background: #0d1117; border-radius: 6px; padding: 12px; border-left: 3px solid #888; }
    .message.user { border-left-color: #00d9ff; }
    .message.assistant { border-left-color: #ff6b9d; }
    .message.system { border-left-color: #ffa500; }
    .message-role { font-weight: bold; font-size: 11px; text-transform: uppercase; margin-bottom: 6px; opacity: 0.7; }
    .message-content { font-family: 'SF Mono', Monaco, monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
    .tool-use { background: #1a1a2e; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 2px solid #00ff88; }
    .tool-result { background: #1a1a2e; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 2px solid #ffa500; }
    .tool-name { color: #00ff88; font-weight: bold; font-size: 12px; }
    .tool-id { color: #888; font-size: 11px; margin-left: 8px; }
    pre { background: #0d1117; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; max-height: 400px; overflow-y: auto; margin: 0; font-family: 'SF Mono', Monaco, monospace; }
    .refresh { position: fixed; top: 20px; right: 20px; background: #00d9ff; color: #1a1a2e; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; z-index: 100; }
    .refresh:hover { background: #00b8d4; }
    .stats { background: #0f3460; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 30px; }
    .stat { text-align: center; }
    .stat-value { font-size: 24px; color: #00d9ff; font-weight: bold; }
    .stat-label { font-size: 12px; color: #888; }
    .cache-badge { background: #00ff88; color: #000; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 8px; }
    .efficiency-badge { padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 8px; }
    .efficiency-simple { background: #00d9ff; color: #000; }
    .efficiency-standard { background: #888; color: #fff; }
    .efficiency-heavy { background: #ffa500; color: #000; }
    .efficiency-critical { background: #ff6b6b; color: #fff; }
    .context-tokens { color: #888; font-size: 11px; margin-left: 8px; }
  </style>
</head>
<body>
  <button class="refresh" onclick="loadLogs()">Refresh</button>
  <h1>🔄 Sub Bridge Proxy Logs</h1>
  <div class="stats">
    <div class="stat"><div class="stat-value" id="total">-</div><div class="stat-label">Total Requests</div></div>
    <div class="stat"><div class="stat-value" id="success">-</div><div class="stat-label">Successful</div></div>
    <div class="stat"><div class="stat-value" id="errors">-</div><div class="stat-label">Errors</div></div>
    <div class="stat"><div class="stat-value" id="cache-savings">-</div><div class="stat-label">Cache Savings</div></div>
  </div>
  <div id="logs"></div>
  <script>
    const openLogs = new Set();
    const openSections = new Map();
    let knownLogIds = new Set();

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function renderMessageContent(content) {
      if (typeof content === 'string') {
        return \`<div class="message-content">\${escapeHtml(content)}</div>\`;
      }
      if (Array.isArray(content)) {
        return content.map(block => {
          if (block.type === 'text') {
            return \`<div class="message-content">\${escapeHtml(block.text)}</div>\`;
          } else if (block.type === 'tool_use') {
            return \`<div class="tool-use">
              <span class="tool-name">🔧 \${block.name}</span>
              <span class="tool-id">\${block.id}</span>
              <pre>\${JSON.stringify(block.input, null, 2)}</pre>
            </div>\`;
          } else if (block.type === 'tool_result') {
            return \`<div class="tool-result">
              <span class="tool-name">📤 Result</span>
              <span class="tool-id">\${block.tool_use_id}</span>
              <div class="message-content">\${escapeHtml(block.content)}</div>
            </div>\`;
          }
          return \`<pre>\${JSON.stringify(block, null, 2)}</pre>\`;
        }).join('');
      }
      return \`<pre>\${JSON.stringify(content, null, 2)}</pre>\`;
    }

    function createLogEntry(log) {
      const body = log.request.fullBody;
      const cacheStats = log.response.cacheStats;
      const cacheHit = cacheStats && cacheStats.cacheReadInputTokens > 0;
      const efficiencyMode = log.request.efficiencyMode || 'standard';
      const contextTokens = log.request.contextTokens || 0;

      const efficiencyLabels = {
        simple: '⚡ SIMPLE',
        standard: '📝 STANDARD',
        heavy: '⚠️ HEAVY',
        critical: '🚨 CRITICAL'
      };

      let messagesHtml = '';
      if (body.messages && Array.isArray(body.messages)) {
        messagesHtml = body.messages.map((msg, idx) => \`
          <div class="message \${msg.role}">
            <div class="message-role">\${msg.role}</div>
            \${renderMessageContent(msg.content)}
          </div>
        \`).join('');
      }

      const sectionsOpen = openSections.get(log.id) || new Set();

      return \`
        <div class="log-entry" data-id="\${log.id}">
          <div class="log-header" onclick="toggleLog('\${log.id}')">
            <div>
              <span class="log-id">#\${log.id.slice(0,8)}</span>
              <span class="log-time">\${log.timestamp}</span>
              \${cacheHit ? '<span class="cache-badge">CACHED</span>' : ''}
              <span class="efficiency-badge efficiency-\${efficiencyMode}">\${efficiencyLabels[efficiencyMode]}</span>
              <span class="context-tokens">\${contextTokens.toLocaleString()} tokens</span>
            </div>
            <div class="log-meta">
              <span>📦 \${log.request.bodySize}</span>
              <span>💬 \${log.request.messagesCount} msgs</span>
              <span>🔧 \${log.request.toolsCount} tools</span>
              <span class="\${log.response.status < 400 ? 'success' : 'error'}">\${log.response.status < 400 ? '✓ OK' : '✗ ' + log.response.status}</span>
            </div>
          </div>
          <div class="log-body \${openLogs.has(log.id) ? 'open' : ''}">
            <div class="section">
              <div class="section-title \${sectionsOpen.has('messages') ? 'open' : ''}" onclick="event.stopPropagation(); toggleSection('\${log.id}', 'messages')">
                Messages (\${body.messages?.length || 0})
              </div>
              <div class="section-content \${sectionsOpen.has('messages') ? 'open' : ''}">
                <div class="message-list">\${messagesHtml}</div>
              </div>
            </div>
            <div class="section">
              <div class="section-title \${sectionsOpen.has('system') ? 'open' : ''}" onclick="event.stopPropagation(); toggleSection('\${log.id}', 'system')">
                System Prompt (\${body.system ? JSON.stringify(body.system).length : 0} chars)
              </div>
              <div class="section-content \${sectionsOpen.has('system') ? 'open' : ''}">
                <pre>\${body.system ? JSON.stringify(body.system, null, 2) : 'None'}</pre>
              </div>
            </div>
            <div class="section">
              <div class="section-title \${sectionsOpen.has('tools') ? 'open' : ''}" onclick="event.stopPropagation(); toggleSection('\${log.id}', 'tools')">
                Tools (\${body.tools?.length || 0})
              </div>
              <div class="section-content \${sectionsOpen.has('tools') ? 'open' : ''}">
                <pre>\${body.tools ? JSON.stringify(body.tools, null, 2) : 'None'}</pre>
              </div>
            </div>
            \${cacheStats ? \`<div class="section">
              <div class="section-title \${sectionsOpen.has('cache') ? 'open' : ''}" onclick="event.stopPropagation(); toggleSection('\${log.id}', 'cache')">
                Cache Stats
              </div>
              <div class="section-content \${sectionsOpen.has('cache') ? 'open' : ''}">
                <pre>\${JSON.stringify(cacheStats, null, 2)}</pre>
              </div>
            </div>\` : ''}
            \${log.response.error ? \`<div class="section">
              <div class="section-title error \${sectionsOpen.has('error') ? 'open' : ''}" onclick="event.stopPropagation(); toggleSection('\${log.id}', 'error')">
                Error Response
              </div>
              <div class="section-content \${sectionsOpen.has('error') ? 'open' : ''}">
                <pre class="error">\${log.response.error}</pre>
              </div>
            </div>\` : ''}
          </div>
        </div>
      \`;
    }

    async function loadLogs() {
      const res = await fetch('/logs/data');
      const data = await res.json();

      document.getElementById('total').textContent = data.length;
      document.getElementById('success').textContent = data.filter(l => l.response.status < 400).length;
      document.getElementById('errors').textContent = data.filter(l => l.response.status >= 400).length;

      const totalCacheSavings = data.reduce((sum, log) => {
        const cacheRead = log.response.cacheStats?.cacheReadInputTokens || 0;
        return sum + cacheRead;
      }, 0);
      document.getElementById('cache-savings').textContent = totalCacheSavings.toLocaleString() + ' tokens';

      const container = document.getElementById('logs');
      const newLogIds = new Set(data.map(l => l.id));
      const newLogs = data.filter(log => !knownLogIds.has(log.id));

      if (newLogs.length > 0) {
        const fragment = document.createElement('div');
        fragment.innerHTML = newLogs.map(createLogEntry).join('');
        while (fragment.firstChild) {
          container.insertBefore(fragment.firstChild, container.firstChild);
        }
      }

      knownLogIds.forEach(id => {
        if (!newLogIds.has(id)) {
          const entry = document.querySelector(\`[data-id="\${id}"]\`);
          if (entry) entry.remove();
          openSections.delete(id);
        }
      });

      knownLogIds = newLogIds;
    }

    function toggleLog(id) {
      if (openLogs.has(id)) {
        openLogs.delete(id);
      } else {
        openLogs.add(id);
      }
      const entry = document.querySelector(\`[data-id="\${id}"] .log-body\`);
      if (entry) entry.classList.toggle('open');
    }

    function toggleSection(logId, sectionName) {
      if (!openSections.has(logId)) {
        openSections.set(logId, new Set());
      }
      const sections = openSections.get(logId);
      if (sections.has(sectionName)) {
        sections.delete(sectionName);
      } else {
        sections.add(sectionName);
      }

      const entry = document.querySelector(\`[data-id="\${logId}"]\`);
      const titleEl = Array.from(entry.querySelectorAll('.section-title')).find(el => el.textContent.includes(sectionName === 'messages' ? 'Messages' : sectionName === 'system' ? 'System' : sectionName === 'tools' ? 'Tools' : sectionName === 'cache' ? 'Cache' : 'Error'));
      const contentEl = titleEl?.nextElementSibling;
      if (titleEl && contentEl) {
        titleEl.classList.toggle('open');
        contentEl.classList.toggle('open');
      }
    }

    loadLogs();
    setInterval(loadLogs, 3000);
  </script>
</body>
</html>`)
})

app.get('/logs/data', (c: Context) => {
  return c.json(logs.slice().reverse())
})

app.get('/v1/models', async (c: Context) => {
  try {
    // Fetch models from models.dev
    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const modelsData = (await response.json()) as any

    // Extract Anthropic models and format them like OpenAI's API would
    const anthropicProvider = modelsData.anthropic
    if (!anthropicProvider || !anthropicProvider.models) {
      return c.json<ModelsListResponse>({
        object: 'list',
        data: [],
      })
    }

    // Convert models to OpenAI's format
    const models: ModelInfo[] = Object.entries(anthropicProvider.models).map(
      ([modelId, modelData]: [string, any]) => {
        // Convert release date to Unix timestamp
        const releaseDate = modelData.release_date || '1970-01-01'
        const created = Math.floor(new Date(releaseDate).getTime() / 1000)

        return {
          id: modelId,
          object: 'model' as const,
          created: created,
          owned_by: 'anthropic',
        }
      },
    )

    // Sort models by created timestamp (newest first)
    models.sort((a, b) => b.created - a.created)

    const response_data: ModelsListResponse = {
      object: 'list',
      data: models,
    }

    return c.json(response_data)
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
})

const messagesFn = async (c: Context) => {
  let headers: Record<string, string> = c.req.header() as Record<string, string>
  headers.host = 'api.anthropic.com'
  const body: AnthropicRequestBody = await c.req.json()
  const isStreaming = body.stream === true
  const authHeader = c.req.header('authorization')
  const apiKeys = parseApiKeys(authHeader)

  // Bypass cursor enable openai key check
  if (isCursorKeyCheck(body)) {
    return c.json(createCursorBypassResponse())
  }

  try {
    let transformToOpenAIFormat = false
    const requestedModel = body.model || ''
    const isClaudeTrigger = requestedModel === CLAUDE_TRIGGER_MODEL || requestedModel.startsWith('claude-')

    // Debug: log incoming request
    console.log('=== INCOMING REQUEST ===')
    console.log('Model:', body.model)
    console.log('Claude trigger:', isClaudeTrigger ? `YES (matches "${CLAUDE_TRIGGER_MODEL}")` : `NO (passthrough to OpenAI)`)
    console.log('Has system:', !!body.system)
    console.log('Has messages:', !!body.messages)
    console.log('tool_choice:', JSON.stringify(body.tool_choice))
    console.log('tools count:', body.tools?.length || 0)

    // === OPENAI PASSTHROUGH ===
    // If model doesn't match Claude trigger, proxy directly to OpenAI
    if (!isClaudeTrigger) {
      console.log(`🔀 Passthrough to OpenAI for model: ${requestedModel}`)

      if (!apiKeys.openai) {
        const instructions = getMissingKeyInstructions('openai')
        return c.json<ErrorResponse>(
          { error: 'Missing OpenAI API key', message: instructions },
          401
        )
      }

      const openaiHeaders: Record<string, string> = {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKeys.openai}`,
      }

      const openaiUrl = `${OPENAI_BASE_URL}/v1/chat/completions`
      const isStreaming = body.stream === true

      const response = await fetch(openaiUrl, {
        method: 'POST',
        headers: openaiHeaders,
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('OpenAI API Error:', error)
        return new Response(error, {
          status: response.status,
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      // Stream or return response directly
      if (isStreaming) {
        response.headers.forEach((value, key) => {
          if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
            c.header(key, value)
          }
        })

        const reader = response.body!.getReader()
        return stream(c, async (stream) => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              await stream.write(value)
            }
          } finally {
            reader.releaseLock()
          }
        })
      } else {
        const data = await response.json()
        return c.json(data)
      }
    }

    // === CLAUDE ROUTING ===
    console.log('🎯 Routing to Claude API')

    // Map the trigger model to Claude model
    const claudeModel = requestedModel === CLAUDE_TRIGGER_MODEL
      ? 'claude-sonnet-4-20250514'  // Default Claude model for trigger
      : requestedModel  // Already a Claude model

    if (requestedModel === CLAUDE_TRIGGER_MODEL) {
      console.log(`Mapping model ${requestedModel} -> ${claudeModel}`)
      body.model = claudeModel
    }

    // Cursor uses 'input' instead of 'messages' - convert it
    if (body.input && !body.messages) {
      console.log('Converting input field to messages')
      body.messages = body.input
      delete body.input
    }

    // Check if this is NOT from Claude Code (needs OpenAI -> Anthropic conversion)
    const isClaudeCode = body.system?.[0]?.text?.includes(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    )

    if (!isClaudeCode) {
      const systemMessages = body.messages?.filter((msg: any) => msg.role === 'system') || []
      body.messages = body.messages?.filter((msg: any) => msg.role !== 'system') || []
      transformToOpenAIFormat = true // not claude-code, need to transform to openai format
      if (!body.system) {
        body.system = []
      }
      body.system.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      })

      for (const sysMsg of systemMessages) {
        body.system.push({
          type: 'text',
          text: sysMsg.content || ''
        })
      }

      // === EFFICIENCY OPTIMIZATIONS ===

      // 1. Detect request type for adaptive behavior
      const messageCount = body.messages?.length || 0
      const hasTools = (body.tools?.length || 0) > 0
      const lastUserMessage = body.messages?.filter((m: any) => m.role === 'user').pop()
      const lastUserContent = typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : JSON.stringify(lastUserMessage?.content || '')
      const isSimpleQuery = messageCount <= 2 && !hasTools && lastUserContent.length < 300

      // 2. Calculate context usage for adaptive conciseness
      const contextSize = JSON.stringify(body.messages || []).length
      const contextTokensEstimate = Math.ceil(contextSize / 4) // rough token estimate
      const isContextHeavy = contextTokensEstimate > 80_000 // ~80k tokens used
      const isContextCritical = contextTokensEstimate > 150_000 // approaching limits

      // 3. Inject Claude Code efficiency directives
      let efficiencyMode: 'simple' | 'critical' | 'heavy' | 'standard' = 'standard'

      if (isSimpleQuery) {
        // For simple queries: maximum conciseness
        efficiencyMode = 'simple'
        body.system.push({
          type: 'text',
          text: `[EFFICIENCY MODE: SIMPLE QUERY]
- Answer in 1-3 sentences maximum
- No preamble, no postamble
- Skip explanations unless explicitly asked
- One word answers are ideal when appropriate
- Do NOT use bullet points or lists for simple answers`
        })
        console.log('📝 Efficiency: Simple query mode activated')
      } else if (isContextCritical) {
        // Context approaching limits: emergency conciseness
        efficiencyMode = 'critical'
        body.system.push({
          type: 'text',
          text: `[CRITICAL: CONTEXT LIMIT APPROACHING - ${contextTokensEstimate.toLocaleString()} tokens used]
- Be EXTREMELY concise - every token counts
- Skip all examples and elaborations
- Use minimal explanations
- Combine multiple small edits into single operations
- If asked to explain, give 1-2 sentence summary only`
        })
        console.log('🚨 Efficiency: CRITICAL context mode - ' + contextTokensEstimate.toLocaleString() + ' tokens')
      } else if (isContextHeavy) {
        // High context usage: increased conciseness
        efficiencyMode = 'heavy'
        body.system.push({
          type: 'text',
          text: `[EFFICIENCY MODE: HIGH CONTEXT - ${contextTokensEstimate.toLocaleString()} tokens used]
- Keep responses concise (under 10 lines unless code generation)
- Minimize explanatory text
- Skip "here's what I did" summaries
- Don't repeat information already in context`
        })
        console.log('⚠️ Efficiency: High context mode - ' + contextTokensEstimate.toLocaleString() + ' tokens')
      } else {
        // Normal mode: standard Claude Code conciseness
        efficiencyMode = 'standard'
        body.system.push({
          type: 'text',
          text: `[EFFICIENCY MODE: STANDARD]
- Answer concisely, typically under 4 lines unless code generation needed
- Skip unnecessary preamble/postamble
- Don't explain code unless asked
- Prefer direct answers over verbose explanations`
        })
        console.log('✅ Efficiency: Standard mode - ' + contextTokensEstimate.toLocaleString() + ' tokens')
      }

      // Store for log entry
      ;(c as any).efficiencyMode = efficiencyMode
      ;(c as any).contextTokensEstimate = contextTokensEstimate

      if (body.model.includes('opus')) {
        body.max_tokens = 32_000
      }
      if (body.model.includes('sonnet')) {
        body.max_tokens = 64_000
      }

      // Convert OpenAI message format to Anthropic format
      // OpenAI uses role: "tool" for tool results, Anthropic uses role: "user" with tool_result content
      // OpenAI uses tool_calls in assistant messages, Anthropic uses tool_use content blocks
      // Cursor also uses custom types: "custom_tool_call" and "custom_tool_call_output"
      if (body.messages && Array.isArray(body.messages)) {
        const convertedMessages: any[] = []

        for (let i = 0; i < body.messages.length; i++) {
          const msg = body.messages[i]

          // Handle Cursor's custom_tool_call and function_call types (assistant calling a tool)
          if (msg.type === 'custom_tool_call' || msg.type === 'function_call') {
            // Parse input/arguments - function_call uses 'arguments', custom_tool_call uses 'input'
            let toolInput = msg.input || msg.arguments
            if (typeof toolInput === 'string') {
              try {
                toolInput = JSON.parse(toolInput)
              } catch {
                toolInput = { command: toolInput }
              }
            }

            const toolUse = {
              type: 'tool_use',
              id: msg.call_id,
              name: msg.name,
              input: toolInput || {}
            }

            // Check if last message is an assistant message we can append to
            const lastMsg = convertedMessages[convertedMessages.length - 1]
            if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
              lastMsg.content.push(toolUse)
            } else {
              convertedMessages.push({ role: 'assistant', content: [toolUse] })
            }
            continue
          }

          // Handle Cursor's custom_tool_call_output and function_call_output types (tool result)
          if (msg.type === 'custom_tool_call_output' || msg.type === 'function_call_output') {
            const toolResult = {
              type: 'tool_result',
              tool_use_id: msg.call_id,
              content: msg.output || ''
            }

            // Check if last message is a user with tool_result we can append to
            const lastMsg = convertedMessages[convertedMessages.length - 1]
            if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) &&
                lastMsg.content[0]?.type === 'tool_result') {
              lastMsg.content.push(toolResult)
            } else {
              convertedMessages.push({ role: 'user', content: [toolResult] })
            }
            continue
          }

          // Skip messages without role (shouldn't happen after handling custom types)
          if (!msg.role) {
            console.log(`Skipping message ${i} without role:`, JSON.stringify(msg).slice(0, 200))
            continue
          }

          // Convert assistant messages with tool_calls to Anthropic format
          if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
            const content: any[] = []

            // Add text content if present
            if (msg.content) {
              content.push({ type: 'text', text: msg.content })
            }

            // Convert tool_calls to tool_use blocks
            for (const toolCall of msg.tool_calls) {
              content.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function?.name || toolCall.name,
                input: typeof toolCall.function?.arguments === 'string'
                  ? JSON.parse(toolCall.function.arguments || '{}')
                  : (toolCall.function?.arguments || toolCall.arguments || {})
              })
            }

            convertedMessages.push({ role: 'assistant', content })
          }
          // Convert tool result messages to Anthropic format
          else if (msg.role === 'tool') {
            // Anthropic expects tool results in a user message with tool_result content
            // Check if previous converted message is already a user with tool_result
            const lastMsg = convertedMessages[convertedMessages.length - 1]
            const toolResult = {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            }

            if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content) &&
                lastMsg.content[0]?.type === 'tool_result') {
              // Append to existing tool_result user message
              lastMsg.content.push(toolResult)
            } else {
              // Create new user message with tool_result
              convertedMessages.push({ role: 'user', content: [toolResult] })
            }
          }
          // Pass through other messages, ensuring content is properly formatted
          else {
            // Ensure content is in proper format for Anthropic
            if (typeof msg.content === 'string') {
              convertedMessages.push({ role: msg.role, content: msg.content })
            } else if (Array.isArray(msg.content)) {
              convertedMessages.push({ role: msg.role, content: msg.content })
            } else if (msg.content === null || msg.content === undefined) {
              // Skip messages with no content unless they're assistant messages
              if (msg.role === 'assistant') {
                convertedMessages.push({ role: 'assistant', content: '' })
              }
            } else {
              convertedMessages.push(msg)
            }
          }
        }

        body.messages = convertedMessages
        console.log(`Converted ${body.messages.length} messages to Anthropic format`)

        // Fix: Anthropic doesn't allow trailing whitespace in final assistant message
        if (body.messages.length > 0) {
          const lastMsg = body.messages[body.messages.length - 1]
          if (lastMsg.role === 'assistant') {
            if (typeof lastMsg.content === 'string') {
              lastMsg.content = lastMsg.content.trimEnd()
              if (!lastMsg.content) lastMsg.content = '...'
            } else if (Array.isArray(lastMsg.content)) {
              // Trim text blocks
              for (const block of lastMsg.content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  block.text = block.text.trimEnd()
                  if (!block.text) block.text = '...'
                }
              }
            }
          }
        }
      }
    }

    if (!apiKeys.anthropic) {
      const instructions = getMissingKeyInstructions('anthropic')
      return c.json<ErrorResponse>(
        {
          error: 'Missing Anthropic API key',
          message: instructions,
        },
        401,
      )
    }

    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKeys.anthropic}`,
      'anthropic-beta':
        'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,prompt-caching-2024-07-31',
      'anthropic-version': '2023-06-01',
      'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
    }

    if (transformToOpenAIFormat) {
      if (!body.metadata) {
        body.metadata = {}
      }

      if (!body.system) {
        body.system = []
      }

      // Convert OpenAI tool_choice format to Anthropic format
      console.log('Received tool_choice:', JSON.stringify(body.tool_choice))
      if (body.tool_choice !== undefined) {
        if (body.tool_choice === 'auto') {
          body.tool_choice = { type: 'auto' }
        } else if (body.tool_choice === 'none' || body.tool_choice === null) {
          delete body.tool_choice
        } else if (body.tool_choice === 'required') {
          body.tool_choice = { type: 'any' }
        } else if (typeof body.tool_choice === 'object' && body.tool_choice?.function?.name) {
          body.tool_choice = { type: 'tool', name: body.tool_choice.function.name }
        } else if (typeof body.tool_choice === 'object' && body.tool_choice?.type) {
          // Already in Anthropic format, keep it
        } else {
          // Unknown format, remove it
          console.log('Removing unknown tool_choice format')
          delete body.tool_choice
        }
      }
      console.log('Converted tool_choice:', JSON.stringify(body.tool_choice))

      // Convert OpenAI tools format to Anthropic format
      // Anthropic format: { name, description, input_schema } - NO type field for custom tools
      if (body.tools && Array.isArray(body.tools)) {
        console.log(`Converting ${body.tools.length} tools`)
        body.tools = body.tools.map((tool: any, idx: number) => {
          let converted: any
          // OpenAI nested format: { type: "function", function: { name, description, parameters } }
          if (tool.type === 'function' && tool.function) {
            converted = {
              name: tool.function.name,
              description: tool.function.description || '',
              input_schema: tool.function.parameters || { type: 'object', properties: {} }
            }
          }
          // OpenAI flat format: { type: "function", name, description, parameters }
          else if (tool.type === 'function' && tool.name) {
            converted = {
              name: tool.name,
              description: tool.description || '',
              input_schema: tool.parameters || { type: 'object', properties: {} }
            }
          }
          // Fallback: convert any tool with a name to Anthropic format
          else if (tool.name) {
            converted = {
              name: tool.name,
              description: tool.description || '',
              input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
            }
          } else {
            console.log(`Tool ${idx} not converted:`, JSON.stringify(tool).slice(0, 200))
            converted = tool
          }

          // Add cache_control to last tool to cache all tools
          if (idx === body.tools.length - 1) {
            converted.cache_control = { type: 'ephemeral' }
            console.log('Added cache_control to last tool')
          }

          return converted
        })
      }

      // Add cache_control to last system block to cache system prompt
      if (body.system && Array.isArray(body.system) && body.system.length > 0) {
        body.system[body.system.length - 1].cache_control = { type: 'ephemeral' }
        console.log('Added cache_control to system prompt')
      }

      // Whitelist approach: only keep fields Anthropic accepts
      const anthropicFields = [
        'model', 'messages', 'max_tokens', 'stop_sequences', 'stream',
        'system', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice'
      ]

      // Build clean body with only allowed fields
      const cleanBody: any = {}
      for (const field of anthropicFields) {
        if (body[field] !== undefined) {
          cleanBody[field] = body[field]
        }
      }

      // Ensure max_tokens is set (required by Anthropic)
      if (!cleanBody.max_tokens) {
        cleanBody.max_tokens = 64000
      }

      // Ensure messages exists
      if (!cleanBody.messages || cleanBody.messages.length === 0) {
        cleanBody.messages = [{ role: 'user', content: 'Hello' }]
      }

      // Replace body with clean version
      Object.keys(body).forEach(key => delete body[key])
      Object.assign(body, cleanBody)

      console.log('Clean body keys:', Object.keys(body))

      // Log context size
      const bodyStr = JSON.stringify(body)
      const bodySizeKB = `${(bodyStr.length / 1024).toFixed(1)}KB`
      console.log(`Request size: ${bodySizeKB}`)
      console.log(`Messages count: ${body.messages?.length || 0}`)
      console.log(`System prompt length: ${JSON.stringify(body.system || []).length} chars`)

      // Log full system prompt for analysis (first request only)
      if (body.system && Array.isArray(body.system) && body.system.length > 0) {
        const systemText = body.system.map((s: any) => s.text || '').join('\n')
        if (systemText.length > 100) {
          console.log('\n=== FULL SYSTEM PROMPT ===')
          console.log(systemText)
          console.log('=== END SYSTEM PROMPT ===\n')
        }
      }

      // Create log entry
      const logEntry: LogEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        request: {
          model: body.model,
          messagesCount: body.messages?.length || 0,
          toolsCount: body.tools?.length || 0,
          systemLength: JSON.stringify(body.system || []).length,
          bodySize: bodySizeKB,
          fullBody: JSON.parse(JSON.stringify(body)), // deep copy
          efficiencyMode: (c as any).efficiencyMode || 'standard',
          contextTokens: (c as any).contextTokensEstimate || 0
        },
        response: { status: 0 }
      }
      logs.push(logEntry)
      if (logs.length > MAX_LOGS) logs.shift()

      // Store reference for updating response later
      ;(c as any).logEntry = logEntry
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    // Update log entry with response status
    const logEntry = (c as any).logEntry as LogEntry | undefined

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)

      if (logEntry) {
        logEntry.response.status = response.status
        logEntry.response.error = error
      }

      if (response.status === 401) {
        return c.json<ErrorResponse>(
          {
            error: 'Authentication failed',
            message:
              'OAuth token may be expired. Please re-authenticate using /auth/login/start',
            details: error,
          },
          401,
        )
      }
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    // Log success
    if (logEntry) {
      logEntry.response.status = response.status
    }

    if (isStreaming) {
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== 'content-encoding' &&
          key.toLowerCase() !== 'content-length' &&
          key.toLowerCase() !== 'transfer-encoding'
        ) {
          c.header(key, value)
        }
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      return stream(c, async (stream) => {
        const converterState = createConverterState()
        const enableLogging = false

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })

            if (transformToOpenAIFormat) {
              if (enableLogging) {
                console.log('🔄 [TRANSFORM MODE] Converting to OpenAI format')
              }

              const results = processChunk(converterState, chunk, enableLogging)

              for (const result of results) {
                if (result.type === 'chunk') {
                  const dataToSend = `data: ${JSON.stringify(result.data)}\n\n`
                  if (enableLogging) {
                    console.log('✅ [SENDING] OpenAI Chunk:', dataToSend)
                  }
                  await stream.write(dataToSend)
                } else if (result.type === 'done') {
                  await stream.write('data: [DONE]\n\n')
                }
              }
            } else {
              await stream.write(chunk)
            }
          }
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      if (transformToOpenAIFormat) {
        const openAIResponse = convertNonStreamingResponse(responseData)

        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value)
          }
        })

        return c.json(openAIResponse)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          c.header(key, value)
        }
      })

      return c.json(responseData)
    }
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

const port = process.env.PORT || 9095

// Export app for Vercel
export default app

// Start server for local development
import { serve } from '@hono/node-server'

serve({
  fetch: app.fetch,
  port: Number(port),
}, (info) => {
  console.log(`🚀 Sub Bridge running on http://localhost:${info.port}`)
  console.log(``)
  console.log(`📡 Configure Cursor to use one of:`)
  console.log(`   Local:  http://localhost:${info.port}/v1`)
  console.log(`   Remote: https://local.buremba.com/v1`)
  console.log(``)
  console.log(`🎯 Model routing:`)
  console.log(`   "${CLAUDE_TRIGGER_MODEL}" → Claude API (with efficiency optimizations)`)
  console.log(`   Other models → OpenAI API (passthrough)`)
  console.log(``)
  console.log(`📋 Logs viewer: http://localhost:${info.port}/logs`)
  console.log(``)
  console.log(`🔑 Claude: keychain credentials | OpenAI: from Cursor's auth header`)
})
