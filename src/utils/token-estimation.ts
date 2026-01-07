// Token estimation and context truncation utilities
// Used to handle Claude's 200K context window limit

export const CLAUDE_MAX_CONTEXT_TOKENS = 200_000
export const SAFETY_MARGIN = 0.05 // 5% buffer to account for estimation errors

export interface TokenEstimation {
  systemTokens: number
  messagesTokens: number
  toolsTokens: number
  totalTokens: number
  isOverLimit: boolean
  overLimitBy: number
}

export interface TruncationResult {
  messages: any[]
  truncated: boolean
  removedCount: number
  truncationNotice?: string
}

/**
 * Estimate tokens for a string using character-based heuristics.
 * Uses ~3.2 chars per token for mixed content (between code's ~3 and English's ~4)
 */
export function estimateTokens(content: string): number {
  if (!content) return 0
  return Math.ceil(content.length / 3.2)
}

/**
 * Estimate tokens for system prompt blocks
 */
function estimateSystemTokens(system: Array<{ type: string; text: string }> | undefined): number {
  if (!system || !Array.isArray(system)) return 0
  return system.reduce((sum, block) => sum + estimateTokens(block.text || ''), 0)
}

/**
 * Estimate tokens for messages array
 */
function estimateMessagesTokens(messages: any[] | undefined): number {
  if (!messages || !Array.isArray(messages)) return 0
  // Add overhead for message structure (role, content wrapper, etc.)
  const structuralOverhead = messages.length * 4
  const contentTokens = estimateTokens(JSON.stringify(messages))
  return contentTokens + structuralOverhead
}

/**
 * Estimate tokens for tool definitions
 */
function estimateToolsTokens(tools: any[] | undefined): number {
  if (!tools || !Array.isArray(tools)) return 0
  // Tool schemas are verbose JSON, use lower char/token ratio
  return Math.ceil(JSON.stringify(tools).length / 3)
}

/**
 * Full token estimation for a Claude request
 */
export function estimateRequestTokens(body: {
  system?: Array<{ type: string; text: string }>
  messages?: any[]
  tools?: any[]
}): TokenEstimation {
  const systemTokens = estimateSystemTokens(body.system)
  const messagesTokens = estimateMessagesTokens(body.messages)
  const toolsTokens = estimateToolsTokens(body.tools)
  const totalTokens = systemTokens + messagesTokens + toolsTokens

  const effectiveLimit = CLAUDE_MAX_CONTEXT_TOKENS * (1 - SAFETY_MARGIN)
  const isOverLimit = totalTokens > effectiveLimit
  const overLimitBy = isOverLimit ? totalTokens - Math.floor(effectiveLimit) : 0

  return {
    systemTokens,
    messagesTokens,
    toolsTokens,
    totalTokens,
    isOverLimit,
    overLimitBy,
  }
}

/**
 * Check if a message contains tool_use blocks
 */
function hasToolUse(msg: any): boolean {
  if (msg.tool_calls?.length) return true
  if (Array.isArray(msg.content)) {
    return msg.content.some((b: any) => b.type === 'tool_use')
  }
  return false
}

/**
 * Check if a message contains tool_result blocks
 */
function hasToolResult(msg: any): boolean {
  if (msg.role === 'tool') return true
  if (Array.isArray(msg.content)) {
    return msg.content.some((b: any) => b.type === 'tool_result')
  }
  return false
}

/**
 * Get tool IDs from a message that contains tool_use
 */
function getToolUseIds(msg: any): string[] {
  const ids: string[] = []
  if (msg.tool_calls?.length) {
    for (const call of msg.tool_calls) {
      if (call.id) ids.push(call.id)
    }
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) ids.push(block.id)
    }
  }
  return ids
}

/**
 * Get tool IDs from a message that contains tool_result
 */
function getToolResultIds(msg: any): string[] {
  const ids: string[] = []
  if (msg.tool_call_id) ids.push(msg.tool_call_id)
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Truncate messages using sliding window approach.
 * Removes oldest messages first, preserving system and tool definitions.
 * Ensures tool_use/tool_result pairs are kept together.
 */
export function truncateMessages(
  messages: any[],
  targetTokens: number,
  systemTokens: number,
  toolsTokens: number
): TruncationResult {
  const availableForMessages = targetTokens - systemTokens - toolsTokens

  if (availableForMessages <= 0) {
    // System + tools already exceed limit, cannot truncate messages
    return {
      messages: [],
      truncated: true,
      removedCount: messages.length,
      truncationNotice: 'Warning: System prompt and tools exceed context limit. Unable to include any conversation history.',
    }
  }

  if (messages.length === 0) {
    return { messages: [], truncated: false, removedCount: 0 }
  }

  // Build a map of tool_use IDs to their message indices, and tool_result IDs to their message indices
  const toolUseIdToIndex = new Map<string, number>()
  const toolResultIdToIndex = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    for (const id of getToolUseIds(msg)) {
      toolUseIdToIndex.set(id, i)
    }
    for (const id of getToolResultIds(msg)) {
      toolResultIdToIndex.set(id, i)
    }
  }

  // Find pairs: for each tool_use, find its corresponding tool_result
  const pairs = new Map<number, number>() // tool_use index -> tool_result index
  for (const [id, useIndex] of toolUseIdToIndex) {
    const resultIndex = toolResultIdToIndex.get(id)
    if (resultIndex !== undefined) {
      pairs.set(useIndex, resultIndex)
    }
  }

  // Calculate tokens for each message
  const messageTokens: number[] = messages.map(msg => estimateTokens(JSON.stringify(msg)) + 4)

  // Track which messages to include (start from newest)
  const include = new Set<number>()
  let currentTokens = 0

  // Process from newest to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    // Skip if already included (as part of a pair)
    if (include.has(i)) continue

    const tokensNeeded = messageTokens[i]

    // Check if this message is part of a pair
    let pairedIndex: number | undefined
    let pairTokens = tokensNeeded

    // Check if this is a tool_use message with a corresponding result
    if (pairs.has(i)) {
      pairedIndex = pairs.get(i)!
      if (!include.has(pairedIndex)) {
        pairTokens += messageTokens[pairedIndex]
      }
    }

    // Check if this is a tool_result message with a corresponding use
    for (const [useIdx, resultIdx] of pairs) {
      if (resultIdx === i && !include.has(useIdx)) {
        pairedIndex = useIdx
        pairTokens += messageTokens[useIdx]
        break
      }
    }

    // Check if we can include this message (and its pair if applicable)
    if (currentTokens + pairTokens <= availableForMessages) {
      include.add(i)
      currentTokens += tokensNeeded
      if (pairedIndex !== undefined && !include.has(pairedIndex)) {
        include.add(pairedIndex)
        currentTokens += messageTokens[pairedIndex]
      }
    }
  }

  // Build result array maintaining original order
  const result: any[] = []
  for (let i = 0; i < messages.length; i++) {
    if (include.has(i)) {
      result.push(messages[i])
    }
  }

  const removedCount = messages.length - result.length
  const truncated = removedCount > 0

  const truncationNotice = truncated
    ? `[Context truncated: ${removedCount} earlier message(s) removed to fit within token limit]`
    : undefined

  return {
    messages: result,
    truncated,
    removedCount,
    truncationNotice,
  }
}
