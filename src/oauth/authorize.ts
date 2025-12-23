/**
 * OAuth Authorization Endpoint
 *
 * Handles the /oauth/authorize endpoint. When an MCP client redirects here,
 * we redirect to the landing page with OAuth params. After the user authenticates
 * with Claude/ChatGPT, the frontend calls /oauth/code to get an authorization code.
 */
import crypto from 'node:crypto'
import { generateAuthCode } from './crypto'
import { getClient, validateRedirectUri } from './dcr'

// ============================================================================
// Types
// ============================================================================

export interface AuthorizationRequest {
  client_id: string
  redirect_uri: string
  response_type: string
  state?: string
  scope?: string
  code_challenge?: string
  code_challenge_method?: string
}

export interface PendingAuthorization {
  clientId: string
  redirectUri: string
  state?: string
  scope?: string
  codeChallenge?: string
  codeChallengeMethod?: string
  createdAt: number
}

export interface AuthorizationCode {
  code: string
  clientId: string
  redirectUri: string
  userId: string
  providers: {
    claude?: {
      access_token: string
      refresh_token?: string
      expires_at?: number
    }
    chatgpt?: {
      access_token: string
      account_id: string
    }
  }
  codeChallenge?: string
  codeChallengeMethod?: string
  createdAt: number
  expiresAt: number
}

// ============================================================================
// Storage (In-Memory)
// ============================================================================

const AUTH_CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// Pending authorizations waiting for user to complete auth
const pendingAuthorizations = new Map<string, PendingAuthorization>()

// Issued authorization codes waiting for token exchange
const authorizationCodes = new Map<string, AuthorizationCode>()

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [id, pending] of pendingAuthorizations.entries()) {
    if (now - pending.createdAt > AUTH_CODE_TTL_MS) {
      pendingAuthorizations.delete(id)
    }
  }
  for (const [code, auth] of authorizationCodes.entries()) {
    if (now > auth.expiresAt) {
      authorizationCodes.delete(code)
    }
  }
}, 60 * 1000)

// ============================================================================
// Authorization Functions
// ============================================================================

/**
 * Validate and process an authorization request.
 * Returns a pending authorization ID if valid, or an error.
 */
export function startAuthorization(
  request: AuthorizationRequest
): { pendingId: string } | { error: string; errorDescription: string } {
  // Validate response_type
  if (request.response_type !== 'code') {
    return {
      error: 'unsupported_response_type',
      errorDescription: 'Only "code" response type is supported',
    }
  }

  // Validate client exists
  const client = getClient(request.client_id)
  if (!client) {
    return {
      error: 'invalid_client',
      errorDescription: 'Client not registered. Use /oauth/register first.',
    }
  }

  // Validate redirect_uri
  if (!validateRedirectUri(request.client_id, request.redirect_uri)) {
    return {
      error: 'invalid_redirect_uri',
      errorDescription: 'Redirect URI not registered for this client',
    }
  }

  // Create pending authorization
  const pendingId = crypto.randomBytes(16).toString('hex')
  pendingAuthorizations.set(pendingId, {
    clientId: request.client_id,
    redirectUri: request.redirect_uri,
    state: request.state,
    scope: request.scope,
    codeChallenge: request.code_challenge,
    codeChallengeMethod: request.code_challenge_method,
    createdAt: Date.now(),
  })

  return { pendingId }
}

/**
 * Get pending authorization by ID.
 */
export function getPendingAuthorization(pendingId: string): PendingAuthorization | null {
  const pending = pendingAuthorizations.get(pendingId)
  if (!pending) return null
  if (Date.now() - pending.createdAt > AUTH_CODE_TTL_MS) {
    pendingAuthorizations.delete(pendingId)
    return null
  }
  return pending
}

/**
 * Complete authorization and generate an authorization code.
 * Called after user successfully authenticates with Claude/ChatGPT.
 */
export function completeAuthorization(
  pendingId: string,
  userId: string,
  providers: AuthorizationCode['providers']
): { code: string; redirectUri: string; state?: string } | { error: string } {
  const pending = pendingAuthorizations.get(pendingId)
  if (!pending) {
    return { error: 'Authorization session expired or not found' }
  }

  // Generate authorization code
  const code = generateAuthCode()
  const now = Date.now()

  authorizationCodes.set(code, {
    code,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    userId,
    providers,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    createdAt: now,
    expiresAt: now + AUTH_CODE_TTL_MS,
  })

  // Clean up pending authorization
  pendingAuthorizations.delete(pendingId)

  return {
    code,
    redirectUri: pending.redirectUri,
    state: pending.state,
  }
}

/**
 * Exchange authorization code for token data.
 * Validates and consumes the code (one-time use).
 */
export function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
): AuthorizationCode | { error: string; errorDescription: string } {
  const authCode = authorizationCodes.get(code)

  if (!authCode) {
    return {
      error: 'invalid_grant',
      errorDescription: 'Authorization code not found or expired',
    }
  }

  // Validate client_id matches
  if (authCode.clientId !== clientId) {
    authorizationCodes.delete(code)
    return {
      error: 'invalid_grant',
      errorDescription: 'Client ID mismatch',
    }
  }

  // Validate redirect_uri matches
  if (authCode.redirectUri !== redirectUri) {
    authorizationCodes.delete(code)
    return {
      error: 'invalid_grant',
      errorDescription: 'Redirect URI mismatch',
    }
  }

  // Validate PKCE if code challenge was provided
  if (authCode.codeChallenge) {
    if (!codeVerifier) {
      authorizationCodes.delete(code)
      return {
        error: 'invalid_grant',
        errorDescription: 'Code verifier required',
      }
    }

    const method = authCode.codeChallengeMethod || 'plain'
    let expectedChallenge: string

    if (method === 'S256') {
      expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')
    } else {
      expectedChallenge = codeVerifier
    }

    if (expectedChallenge !== authCode.codeChallenge) {
      authorizationCodes.delete(code)
      return {
        error: 'invalid_grant',
        errorDescription: 'Code verifier mismatch',
      }
    }
  }

  // Check expiration
  if (Date.now() > authCode.expiresAt) {
    authorizationCodes.delete(code)
    return {
      error: 'invalid_grant',
      errorDescription: 'Authorization code expired',
    }
  }

  // Consume the code (one-time use)
  authorizationCodes.delete(code)

  return authCode
}
