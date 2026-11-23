import { patch } from './store'
export function openSecurity(hostId: string): void { patch({ securityHost: hostId, paletteOpen: false }) }
