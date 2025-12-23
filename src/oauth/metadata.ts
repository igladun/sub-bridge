/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414)
 *
 * Provides the /.well-known/oauth-authorization-server endpoint
 * that MCP clients use to discover OAuth endpoints.
 */

export interface OAuthMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported: string[]
  response_types_supported: string[]
  grant_types_supported: string[]
  token_endpoint_auth_methods_supported: string[]
  code_challenge_methods_supported: string[]
  service_documentation?: string
}

/**
 * Generate OAuth metadata for the given issuer URL.
 */
export function getOAuthMetadata(issuerUrl: string): OAuthMetadata {
  // Ensure no trailing slash
  const baseUrl = issuerUrl.replace(/\/$/, '')

  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    scopes_supported: ['openid', 'profile', 'offline_access'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    service_documentation: 'https://github.com/anthropics/sub-bridge',
  }
}
