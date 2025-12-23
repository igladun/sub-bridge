/**
 * OAuth Token Endpoint
 *
 * Handles token exchange and issues encrypted access tokens
 * containing upstream provider credentials.
 */
import { createAccessToken, type SubBridgeTokenPayload } from './crypto'
import { validateClient } from './dcr'
import { exchangeAuthorizationCode, type AuthorizationCode } from './authorize'

// ============================================================================
// Types
// ============================================================================

export interface TokenRequest {
  grant_type: string
  code?: string
  redirect_uri?: string
  client_id?: string
  client_secret?: string
  code_verifier?: string
  refresh_token?: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token?: string
  scope?: string
}

export interface TokenError {
  error: string
  error_description: string
}

// ============================================================================
// Token Generation
// ============================================================================

const ACCESS_TOKEN_TTL_SECONDS = 3600 * 24 * 7 // 7 days

/**
 * Process a token request and return an access token or error.
 */
export function processTokenRequest(
  request: TokenRequest
): TokenResponse | TokenError {
  // Validate grant_type
  if (request.grant_type === 'authorization_code') {
    return handleAuthorizationCodeGrant(request)
  }

  if (request.grant_type === 'refresh_token') {
    return handleRefreshTokenGrant(request)
  }

  return {
    error: 'unsupported_grant_type',
    error_description: 'Only authorization_code and refresh_token grants are supported',
  }
}

/**
 * Handle authorization_code grant type.
 */
function handleAuthorizationCodeGrant(
  request: TokenRequest
): TokenResponse | TokenError {
  // Validate required parameters
  if (!request.code) {
    return {
      error: 'invalid_request',
      error_description: 'Missing authorization code',
    }
  }

  if (!request.client_id) {
    return {
      error: 'invalid_request',
      error_description: 'Missing client_id',
    }
  }

  if (!request.redirect_uri) {
    return {
      error: 'invalid_request',
      error_description: 'Missing redirect_uri',
    }
  }

  // Validate client
  const client = validateClient(request.client_id, request.client_secret)
  if (!client) {
    return {
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    }
  }

  // Exchange authorization code
  const codeResult = exchangeAuthorizationCode(
    request.code,
    request.client_id,
    request.redirect_uri,
    request.code_verifier
  )

  if ('error' in codeResult) {
    return {
      error: codeResult.error,
      error_description: codeResult.errorDescription,
    }
  }

  // Create access token
  return createTokenResponse(codeResult, request.client_id)
}

/**
 * Handle refresh_token grant type.
 * For now, we don't support refresh tokens on the Sub Bridge side.
 * Users need to re-authenticate when tokens expire.
 */
function handleRefreshTokenGrant(
  _request: TokenRequest
): TokenResponse | TokenError {
  // TODO: Implement refresh token support
  // This would require storing refresh tokens securely
  return {
    error: 'unsupported_grant_type',
    error_description: 'Refresh tokens are not yet supported. Please re-authenticate.',
  }
}

/**
 * Create a token response from an authorization code.
 */
function createTokenResponse(
  authCode: AuthorizationCode,
  clientId: string
): TokenResponse {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS

  const payload: SubBridgeTokenPayload = {
    iss: 'sub-bridge',
    sub: authCode.userId,
    aud: clientId,
    exp: expiresAt,
    iat: now,
    providers: authCode.providers,
  }

  const accessToken = createAccessToken(payload)

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: 'openid profile',
  }
}

/**
 * Check if a response is an error.
 */
export function isTokenError(
  response: TokenResponse | TokenError
): response is TokenError {
  return 'error' in response
}
