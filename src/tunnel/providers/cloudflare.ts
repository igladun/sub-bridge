// ============================================================================
// Cloudflare Tunnel Provider
// ============================================================================

import { Tunnel } from 'cloudflared'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TunnelProvider, TunnelInstance, NamedTunnelInfo } from '../types'

function getCloudflaredConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || os.homedir(), '.cloudflared')
  }
  return path.join(os.homedir(), '.cloudflared')
}

export class CloudflareTunnelProvider implements TunnelProvider {
  id = 'cloudflare'
  name = 'Cloudflare'
  supportsNamedTunnels = true

  async isAvailable(): Promise<boolean> {
    // The cloudflared npm package auto-installs the binary
    return true
  }

  async isAuthenticated(): Promise<boolean> {
    const certPath = path.join(getCloudflaredConfigDir(), 'cert.pem')
    try {
      await fs.access(certPath)
      return true
    } catch {
      return false
    }
  }

  async listTunnels(): Promise<NamedTunnelInfo[]> {
    if (!await this.isAuthenticated()) {
      return []
    }

    try {
      // Run cloudflared tunnel list and parse output
      const output = await this.runCloudflaredCommand(['tunnel', 'list', '--output', 'json'])
      const tunnels = JSON.parse(output) as Array<{ id: string; name: string }>

      // Get DNS routes for each tunnel
      const results: NamedTunnelInfo[] = []
      for (const tunnel of tunnels) {
        const hostname = await this.getTunnelHostname(tunnel.id)
        results.push({
          id: tunnel.id,
          name: tunnel.name,
          hostname,
        })
      }
      return results
    } catch {
      return []
    }
  }

  private async getTunnelHostname(tunnelId: string): Promise<string | undefined> {
    try {
      // Check config.yml for ingress rules
      const configPath = path.join(getCloudflaredConfigDir(), 'config.yml')
      const config = await fs.readFile(configPath, 'utf-8')

      // Simple regex to extract hostname from ingress rules
      const hostnameMatch = config.match(/hostname:\s*(\S+)/)
      if (hostnameMatch) {
        return hostnameMatch[1]
      }
    } catch {
      // Config file doesn't exist or is unreadable
    }
    return undefined
  }

  private runCloudflaredCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => { stdout += data.toString() })
      proc.stderr.on('data', (data) => { stderr += data.toString() })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr || `cloudflared exited with code ${code}`))
        }
      })

      proc.on('error', reject)
    })
  }

  async start(localPort: number, namedUrl?: string): Promise<TunnelInstance> {
    if (namedUrl) {
      return this.startNamedTunnel(localPort, namedUrl)
    }
    return this.startQuickTunnel(localPort)
  }

  private async startNamedTunnel(localPort: number, namedUrl: string): Promise<TunnelInstance> {
    // Check if authenticated
    if (!await this.isAuthenticated()) {
      throw new Error('Cloudflare authentication required. Run: cloudflared tunnel login')
    }

    // Find the tunnel info
    const tunnels = await this.listTunnels()
    const tunnel = tunnels.find(t =>
      t.name === namedUrl ||
      t.hostname === namedUrl ||
      t.id === namedUrl
    )

    if (!tunnel) {
      throw new Error(`Tunnel not found: ${namedUrl}. Available: ${tunnels.map(t => t.name).join(', ') || 'none'}`)
    }

    if (!tunnel.hostname) {
      throw new Error(`Tunnel "${tunnel.name}" has no DNS route configured. Configure one in Cloudflare dashboard.`)
    }

    // Create temp config with the requested port
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-bridge-cloudflared-'))
    const credentialsFile = path.join(getCloudflaredConfigDir(), `${tunnel.id}.json`)

    const configContent = `tunnel: ${tunnel.id}
credentials-file: ${credentialsFile}
protocol: http2
ingress:
  - hostname: ${tunnel.hostname}
    service: http://localhost:${localPort}
  - service: http_status:404
`
    const configPath = path.join(tmpDir, 'config.yml')
    await fs.writeFile(configPath, configContent)

    // Spawn cloudflared tunnel run
    const proc = spawn('cloudflared', ['tunnel', 'run', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    // Wait for connection
    const publicUrl = `https://${tunnel.hostname}`

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('Named tunnel connection timeout (60s)'))
      }, 60000)

      let lastError = ''

      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString()
        if (line.includes('Registered tunnel connection')) {
          clearTimeout(timeout)
          resolve()
        }
        if (line.includes('ERR') || line.includes('error')) {
          lastError = line.trim()
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(lastError || `cloudflared exited with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    return {
      providerId: this.id,
      publicUrl,
      stop: () => {
        proc.kill()
        void fs.rm(tmpDir, { recursive: true, force: true })
      }
    }
  }

  private async startQuickTunnel(localPort: number): Promise<TunnelInstance> {
    // Anonymous tunnel using cloudflared npm package
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-bridge-cloudflared-'))
    const configPath = path.join(tmpDir, 'config.yml')
    await fs.writeFile(configPath, 'no-autoupdate: true\n')
    // Use HTTP/2 protocol for more reliable connections
    const tunnel = Tunnel.quick(`http://localhost:${localPort}`, { '--config': configPath, '--protocol': 'http2' })

    // Wait for URL event, then wait for connection to be established
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tunnel.stop()
        reject(new Error('Tunnel timeout (60s)'))
      }, 60000)
      let tunnelUrl: string | null = null
      let lastError: string | null = null

      const checkReady = () => {
        if (tunnelUrl) {
          clearTimeout(timeout)
          resolve(tunnelUrl)
        }
      }

      // Capture stderr for error messages (rate limiting, etc.)
      tunnel.on('stderr', (data: string) => {
        if (data.includes('ERR') || data.includes('error')) {
          // Extract meaningful error message
          if (data.includes('Too Many Requests') || data.includes('1015')) {
            lastError = 'Cloudflare rate limit exceeded. Please wait a few minutes and try again.'
          } else if (data.includes('failed to unmarshal')) {
            lastError = data.split('\n').find(line => line.includes('failed'))?.trim() || data
          } else {
            const errMatch = data.match(/ERR\s+(.+?)(?:\s+error=|$)/)
            if (errMatch) lastError = errMatch[1].trim()
          }
        }
      })

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

      // Handle process exit (e.g., rate limiting causes immediate exit)
      tunnel.once('exit', (code: number | null) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout)
          reject(new Error(lastError || `Cloudflare tunnel exited with code ${code}`))
        }
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
