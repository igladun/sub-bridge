interface OAuthCredentials {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

async function get(): Promise<OAuthCredentials | null> {
  return null
}

async function set(): Promise<boolean> {
  return false
}

async function remove(): Promise<boolean> {
  return false
}

async function getAll(): Promise<Record<string, OAuthCredentials>> {
  return {}
}

async function getAccessToken(): Promise<string | null> {
  console.error('OAuth is disabled. Provide tokens via Cursor API Key instead.')
  console.error('Run `claude setup-token` or `codex login` to get a token.')
  return null
}

export { get, set, remove, getAll, getAccessToken }
