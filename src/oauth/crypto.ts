/**
 * Cryptographic utilities for MCP OAuth token encryption
 *
 * Uses AES-256-GCM for authenticated encryption of upstream credentials.
 * Server secret is generated on first run and stored locally.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ============================================================================
// Configuration
// ============================================================================

const SECRET_DIR = path.join(os.homedir(), '.sub-bridge')
const SECRET_FILE = path.join(SECRET_DIR, 'secret.key')
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM recommended IV length
const TAG_LENGTH = 16 // GCM auth tag length

// ============================================================================
// Server Secret Management
// ============================================================================

let cachedSecret: Buffer | null = null

/**
 * Get or generate the server encryption secret.
 * Secret is 32 bytes (256 bits) for AES-256.
 */
export function getServerSecret(): Buffer {
  if (cachedSecret) return cachedSecret

  // Try to read existing secret
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const secret = fs.readFileSync(SECRET_FILE)
      if (secret.length === 32) {
        cachedSecret = secret
        return cachedSecret
      }
    }
  } catch {
    // Will generate new secret
  }

  // Generate new secret
  const secret = crypto.randomBytes(32)

  // Ensure directory exists
  if (!fs.existsSync(SECRET_DIR)) {
    fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 })
  }

  // Write secret with restrictive permissions
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  cachedSecret = secret
  return cachedSecret
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * Encrypt data using AES-256-GCM.
 * Returns base64url-encoded string: IV + ciphertext + authTag
 */
export function encrypt(data: string): string {
  const secret = getServerSecret()
  const iv = crypto.randomBytes(IV_LENGTH)

  const cipher = crypto.createCipheriv(ALGORITHM, secret, iv)
  const encrypted = Buffer.concat([
    cipher.update(data, 'utf8'),
    cipher.final()
  ])
  const authTag = cipher.getAuthTag()

  // Combine: IV (12) + encrypted + authTag (16)
  const combined = Buffer.concat([iv, encrypted, authTag])
  return combined.toString('base64url')
}

/**
 * Decrypt data encrypted with encrypt().
 * Throws on invalid/tampered data.
 */
export function decrypt(encryptedData: string): string {
  const secret = getServerSecret()
  const combined = Buffer.from(encryptedData, 'base64url')

  if (combined.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short')
  }

  const iv = combined.subarray(0, IV_LENGTH)
  const authTag = combined.subarray(combined.length - TAG_LENGTH)
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH)

  const decipher = crypto.createDecipheriv(ALGORITHM, secret, iv)
  decipher.setAuthTag(authTag)

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ])
    return decrypted.toString('utf8')
  } catch {
    throw new Error('Decryption failed: invalid or tampered data')
  }
}

// ============================================================================
// JWT-like Token Operations
// ============================================================================

export interface SubBridgeTokenPayload {
  iss: 'sub-bridge'
  sub: string // User identifier
  aud: string // Client ID
  exp: number // Expiration timestamp
  iat: number // Issued at timestamp
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

/**
 * Create an encrypted access token containing upstream credentials.
 * Format: sb1.<encrypted_payload>
 *
 * The "sb1" prefix identifies this as a Sub Bridge v1 token.
 */
export function createAccessToken(payload: SubBridgeTokenPayload): string {
  const json = JSON.stringify(payload)
  const encrypted = encrypt(json)
  return `sb1.${encrypted}`
}

/**
 * Decode and validate an access token.
 * Returns null if token is invalid or expired.
 */
export function decodeAccessToken(token: string): SubBridgeTokenPayload | null {
  if (!token.startsWith('sb1.')) {
    return null
  }

  try {
    const encrypted = token.slice(4) // Remove "sb1." prefix
    const json = decrypt(encrypted)
    const payload = JSON.parse(json) as SubBridgeTokenPayload

    // Validate required fields
    if (payload.iss !== 'sub-bridge') return null
    if (!payload.sub || !payload.aud) return null
    if (!payload.exp || !payload.iat) return null

    // Check expiration
    if (Date.now() > payload.exp * 1000) return null

    return payload
  } catch {
    return null
  }
}

/**
 * Generate a random authorization code.
 */
export function generateAuthCode(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Generate a random client ID for DCR.
 */
export function generateClientId(): string {
  return `sb_${crypto.randomBytes(16).toString('hex')}`
}

/**
 * Generate a random client secret for DCR.
 */
export function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}
