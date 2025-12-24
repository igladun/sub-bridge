// ============================================================================
// Tunnel Types
// ============================================================================

export interface NamedTunnelInfo {
  id: string
  name: string
  hostname?: string
}

export interface TunnelProvider {
  id: string
  name: string
  supportsNamedTunnels: boolean
  isAvailable(): Promise<boolean>
  isAuthenticated(): Promise<boolean>
  listTunnels(): Promise<NamedTunnelInfo[]>
  start(localPort: number, namedUrl?: string): Promise<TunnelInstance>
}

export interface TunnelInstance {
  providerId: string
  publicUrl: string
  stop(): void
}

export interface TunnelStatus {
  active: boolean
  providerId?: string
  publicUrl?: string
  startedAt?: string
  error?: string
}

export interface ProviderInfo {
  id: string
  name: string
  available: boolean
  supportsNamedTunnels: boolean
  authenticated?: boolean
  namedTunnels?: NamedTunnelInfo[]
}
