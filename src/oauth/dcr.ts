/**
 * Dynamic Client Registration (RFC 7591)
 *
 * Allows MCP clients to register themselves without manual setup.
 * Client registrations are stored in-memory (local-only deployment).
 */
import { generateClientId, generateClientSecret } from './crypto'

// ============================================================================
// Types
// ============================================================================

export interface ClientRegistration {
  client_id: string
  client_secret?: string
  client_name?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  created_at: number
}

export interface RegistrationRequest {
  client_name?: string
  redirect_uris?: string[]
  grant_types?: string[]
  response_types?: string[]
  token_endpoint_auth_method?: string
}

export interface RegistrationResponse {
  client_id: string
  client_secret?: string
  client_name?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  client_id_issued_at: number
}

// ============================================================================
// Client Storage (In-Memory)
// ============================================================================

const clients = new Map<string, ClientRegistration>()

/**
 * Register a new OAuth client.
 */
export function registerClient(request: RegistrationRequest): RegistrationResponse {
  const clientId = generateClientId()
  const clientSecret = request.token_endpoint_auth_method === 'none'
    ? undefined
    : generateClientSecret()

  const now = Math.floor(Date.now() / 1000)

  const registration: ClientRegistration = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: request.client_name,
    redirect_uris: request.redirect_uris || [],
    grant_types: request.grant_types || ['authorization_code'],
    response_types: request.response_types || ['code'],
    token_endpoint_auth_method: request.token_endpoint_auth_method || 'client_secret_post',
    created_at: now,
  }

  clients.set(clientId, registration)

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: registration.client_name,
    redirect_uris: registration.redirect_uris,
    grant_types: registration.grant_types,
    response_types: registration.response_types,
    token_endpoint_auth_method: registration.token_endpoint_auth_method,
    client_id_issued_at: now,
  }
}

/**
 * Get a registered client by ID.
 */
export function getClient(clientId: string): ClientRegistration | undefined {
  return clients.get(clientId)
}

/**
 * Validate client credentials for token endpoint.
 */
export function validateClient(
  clientId: string,
  clientSecret?: string
): ClientRegistration | null {
  const client = clients.get(clientId)
  if (!client) return null

  // For public clients (no secret required)
  if (client.token_endpoint_auth_method === 'none') {
    return client
  }

  // For confidential clients, verify secret
  if (client.client_secret && client.client_secret === clientSecret) {
    return client
  }

  return null
}

/**
 * Validate redirect URI against registered URIs.
 */
export function validateRedirectUri(
  clientId: string,
  redirectUri: string
): boolean {
  const client = clients.get(clientId)
  if (!client) return false

  // If no redirect URIs registered, allow any (for development)
  if (client.redirect_uris.length === 0) return true

  return client.redirect_uris.includes(redirectUri)
}
