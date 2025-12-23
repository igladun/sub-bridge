import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

interface IngressRule {
  hostname?: string
  service?: string
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^https?:\/\//, '').split('/')[0]?.trim() || ''
}

function parseIngressRules(content: string): IngressRule[] {
  const entries: IngressRule[] = []
  const lines = content.split(/\r?\n/)
  let inIngress = false
  let current: IngressRule | null = null

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (!inIngress) {
      if (trimmed === 'ingress:' || trimmed.startsWith('ingress:')) {
        inIngress = true
      }
      continue
    }

    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent === 0 && !trimmed.startsWith('-')) {
      break
    }

    if (trimmed.startsWith('-')) {
      if (current && (current.hostname || current.service)) entries.push(current)
      current = {}
      const afterDash = trimmed.slice(1).trim()
      if (afterDash.startsWith('hostname:')) {
        current.hostname = stripQuotes(afterDash.slice('hostname:'.length))
      } else if (afterDash.startsWith('service:')) {
        current.service = stripQuotes(afterDash.slice('service:'.length))
      }
      continue
    }

    if (!current) continue

    if (trimmed.startsWith('hostname:')) {
      current.hostname = stripQuotes(trimmed.slice('hostname:'.length))
      continue
    }
    if (trimmed.startsWith('service:')) {
      current.service = stripQuotes(trimmed.slice('service:'.length))
      continue
    }
  }

  if (current && (current.hostname || current.service)) entries.push(current)
  return entries
}

function serviceMatchesPort(service: string, port: number): boolean {
  if (!service || service.startsWith('http_status:')) return false

  try {
    const url = new URL(service)
    const protocol = url.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return false

    const resolvedPort = url.port
      ? Number(url.port)
      : (protocol === 'https:' ? 443 : 80)
    if (resolvedPort !== port) return false

    const host = url.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

export async function getCloudflaredHostnames(port: number): Promise<string[]> {
  const home = os.homedir()
  const configPaths = [
    path.join(home, '.cloudflared', 'config.yml'),
    path.join(home, '.cloudflared', 'config.yaml'),
  ]

  const hostnames = new Set<string>()

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf8')
      const rules = parseIngressRules(content)
      for (const rule of rules) {
        if (!rule.hostname || !rule.service) continue
        if (!serviceMatchesPort(rule.service, port)) continue
        const normalized = normalizeHostname(rule.hostname)
        if (normalized) hostnames.add(normalized)
      }
    } catch {
      continue
    }
  }

  return Array.from(hostnames)
}
