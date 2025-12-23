// ============================================================================
// Cloudflare Tunnel Provider
// ============================================================================

import { Tunnel } from 'cloudflared'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TunnelProvider, TunnelInstance } from '../types'

export class CloudflareTunnelProvider implements TunnelProvider {
  id = 'cloudflare'
  name = 'Cloudflare'
  supportsNamedTunnels = true

  async isAvailable(): Promise<boolean> {
    // The cloudflared npm package auto-installs the binary
    return true
  }

  async start(localPort: number, namedUrl?: string): Promise<TunnelInstance> {
    if (namedUrl) {
      // Named tunnel: user provides their own tunnel hostname
      // They need to configure this in Cloudflare dashboard and run cloudflared separately
      return {
        providerId: this.id,
        publicUrl: namedUrl.startsWith('https://') ? namedUrl : `https://${namedUrl}`,
        stop: () => {}
      }
    }

    // Anonymous tunnel using cloudflared npm package
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-bridge-cloudflared-'))
    const configPath = path.join(tmpDir, 'config.yml')
    await fs.writeFile(configPath, 'no-autoupdate: true\n')
    // Use HTTP/2 protocol for more reliable connections
    const tunnel = Tunnel.quick(`http://localhost:${localPort}`, { '--config': configPath, '--protocol': 'http2' })

    // Wait for URL event, then wait for connection to be established
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tunnel timeout (60s)')), 60000)
      let tunnelUrl: string | null = null

      const checkReady = () => {
        if (tunnelUrl) {
          clearTimeout(timeout)
          resolve(tunnelUrl)
        }
      }

      tunnel.once('url', (url: string) => {
        tunnelUrl = url
        // Wait for connected event or timeout after 15s
        const connectTimeout = setTimeout(checkReady, 15000)
        tunnel.once('connected', () => {
          clearTimeout(connectTimeout)
          checkReady()
        })
      })

      tunnel.once('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    return {
      providerId: this.id,
      publicUrl: url,
      stop: () => {
        tunnel.stop()
        void fs.rm(tmpDir, { recursive: true, force: true })
      }
    }
  }
}
