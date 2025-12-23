/**
 * OAuth Routes
 *
 * Implements the MCP OAuth Authorization Server endpoints:
 * - GET /.well-known/oauth-authorization-server (metadata)
 * - POST /oauth/register (DCR)
 * - GET /oauth/authorize (authorization)
 * - POST /oauth/token (token exchange)
 * - POST /oauth/code (internal: generate auth code after user completes auth)
 */
import { Hono } from 'hono'
import { getOAuthMetadata } from '../oauth/metadata'
import { registerClient, type RegistrationRequest } from '../oauth/dcr'
import {
  startAuthorization,
  completeAuthorization,
  getPendingAuthorization,
  type AuthorizationRequest,
} from '../oauth/authorize'
import { processTokenRequest, isTokenError, type TokenRequest } from '../oauth/token'

export function createOAuthRoutes(getPublicUrl: () => string) {
  const app = new Hono()

  // ============================================================================
  // Metadata Endpoint (RFC 8414)
  // ============================================================================

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const metadata = getOAuthMetadata(getPublicUrl())
    return c.json(metadata)
  })

  // Also serve at the standard path without leading slash
  app.get('/oauth-authorization-server', (c) => {
    const metadata = getOAuthMetadata(getPublicUrl())
    return c.json(metadata)
  })

  // ============================================================================
  // Dynamic Client Registration (RFC 7591)
  // ============================================================================

  app.post('/oauth/register', async (c) => {
    try {
      const body = await c.req.json() as RegistrationRequest
      const response = registerClient(body)
      return c.json(response, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return c.json({ error: 'invalid_client_metadata', error_description: message }, 400)
    }
  })

  // ============================================================================
  // Authorization Endpoint
  // ============================================================================

  app.get('/oauth/authorize', (c) => {
    const query = c.req.query()

    const request: AuthorizationRequest = {
      client_id: query.client_id || '',
      redirect_uri: query.redirect_uri || '',
      response_type: query.response_type || 'code',
      state: query.state,
      scope: query.scope,
      code_challenge: query.code_challenge,
      code_challenge_method: query.code_challenge_method,
    }

    // Validate the authorization request
    const result = startAuthorization(request)

    if ('error' in result) {
      // If we have a redirect_uri, redirect with error
      if (request.redirect_uri) {
        const redirectUrl = new URL(request.redirect_uri)
        redirectUrl.searchParams.set('error', result.error)
        redirectUrl.searchParams.set('error_description', result.errorDescription)
        if (request.state) {
          redirectUrl.searchParams.set('state', request.state)
        }
        return c.redirect(redirectUrl.toString())
      }
      // Otherwise return JSON error
      return c.json({
        error: result.error,
        error_description: result.errorDescription,
      }, 400)
    }

    // Redirect to landing page with OAuth flow params
    const landingUrl = new URL(getPublicUrl())
    landingUrl.searchParams.set('oauth_flow', '1')
    landingUrl.searchParams.set('pending_id', result.pendingId)
    landingUrl.searchParams.set('client_id', request.client_id)
    if (request.state) {
      landingUrl.searchParams.set('state', request.state)
    }

    return c.redirect(landingUrl.toString())
  })

  // ============================================================================
  // Authorization Code Generation (Internal)
  // Called by frontend after user completes Claude/ChatGPT auth
  // ============================================================================

  app.post('/oauth/code', async (c) => {
    try {
      const body = await c.req.json() as {
        pending_id: string
        user_id: string
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
      }

      if (!body.pending_id) {
        return c.json({ error: 'Missing pending_id' }, 400)
      }

      if (!body.user_id) {
        return c.json({ error: 'Missing user_id' }, 400)
      }

      if (!body.providers || (!body.providers.claude && !body.providers.chatgpt)) {
        return c.json({ error: 'At least one provider must be authenticated' }, 400)
      }

      const result = completeAuthorization(
        body.pending_id,
        body.user_id,
        body.providers
      )

      if ('error' in result) {
        return c.json({ error: result.error }, 400)
      }

      return c.json({
        success: true,
        code: result.code,
        redirect_uri: result.redirectUri,
        state: result.state,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return c.json({ error: message }, 500)
    }
  })

  // Get pending authorization info (for frontend)
  app.get('/oauth/pending/:id', (c) => {
    const pendingId = c.req.param('id')
    const pending = getPendingAuthorization(pendingId)

    if (!pending) {
      return c.json({ error: 'Pending authorization not found or expired' }, 404)
    }

    return c.json({
      client_id: pending.clientId,
      scope: pending.scope,
    })
  })

  // ============================================================================
  // Token Endpoint
  // ============================================================================

  app.post('/oauth/token', async (c) => {
    try {
      // Support both JSON and form-urlencoded
      const contentType = c.req.header('content-type') || ''
      let body: TokenRequest

      if (contentType.includes('application/json')) {
        body = await c.req.json() as TokenRequest
      } else {
        // Parse form data
        const formData = await c.req.parseBody()
        body = {
          grant_type: String(formData.grant_type || ''),
          code: formData.code ? String(formData.code) : undefined,
          redirect_uri: formData.redirect_uri ? String(formData.redirect_uri) : undefined,
          client_id: formData.client_id ? String(formData.client_id) : undefined,
          client_secret: formData.client_secret ? String(formData.client_secret) : undefined,
          code_verifier: formData.code_verifier ? String(formData.code_verifier) : undefined,
          refresh_token: formData.refresh_token ? String(formData.refresh_token) : undefined,
        }
      }

      const result = processTokenRequest(body)

      if (isTokenError(result)) {
        return c.json(result, 400)
      }

      return c.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return c.json({
        error: 'server_error',
        error_description: message,
      }, 500)
    }
  })

  return app
}
