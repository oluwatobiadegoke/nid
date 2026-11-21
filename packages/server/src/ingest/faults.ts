export interface FaultInput {
  provider?: string | undefined
  to?: string | undefined
  status?: number | undefined
  body?: unknown
  headers?: Record<string, string> | undefined
  delayMs?: number | undefined
  count?: number | null | undefined
}

export interface FaultRule {
  id: number
  projectId: string
  provider: string | null
  to: string | null
  status: number
  body: unknown
  headers: Record<string, string>
  delayMs: number
  remaining: number | null
  createdAt: string
}

export interface FaultStore {
  add(projectId: string, input: FaultInput): FaultRule
  list(projectId: string): FaultRule[]
  clear(projectId: string): number
  consume(projectId: string, provider: string, recipients: string[]): FaultRule | null
}

export type MagicAction = 'ratelimit' | 'bounced' | 'deferred' | 'complained'

export interface MagicMatch {
  action: MagicAction
  recipient: string
}

const magicDomain = 'inbox.test'

const magicNames: Array<[RegExp, MagicAction]> = [
  [/^ratelimit(?:\+|$)/, 'ratelimit'],
  [/^bounce(?:\+|$)/, 'bounced'],
  [/^defer(?:\+|$)/, 'deferred'],
  [/^complain(?:\+|$)/, 'complained'],
]

function magicMatch(address: string): MagicMatch | null {
  const recipient = address.trim().toLowerCase()
  const at = recipient.lastIndexOf('@')
  if (recipient.slice(at + 1) !== magicDomain) return null
  const action = magicNames.find(([pattern]) => pattern.test(recipient.slice(0, at)))?.[1]
  return action ? { action, recipient } : null
}

export function magicMatchFor(recipients: string[]): MagicMatch | null {
  const matches = recipients.map(magicMatch).filter((m) => m !== null)
  return matches.find((m) => m.action === 'ratelimit') ?? matches[0] ?? null
}

export function magicActionFor(recipients: string[]): MagicAction | null {
  return magicMatchFor(recipients)?.action ?? null
}

export function createFaultStore(): FaultStore {
  const rulesByProject = new Map<string, FaultRule[]>()
  let nextId = 0

  return {
    add(projectId, input) {
      const delayMs = input.delayMs ?? 0
      const status = input.status ?? (delayMs > 0 ? 200 : 500)
      const rule: FaultRule = {
        id: ++nextId,
        projectId,
        provider: input.provider ? input.provider.trim().toLowerCase() : null,
        to: input.to ? input.to.trim().toLowerCase() : null,
        status,
        body: input.body,
        headers: { ...(input.headers ?? {}) },
        delayMs,
        remaining: input.count === undefined ? 1 : input.count,
        createdAt: new Date().toISOString(),
      }
      const list = rulesByProject.get(projectId) ?? []
      list.push(rule)
      rulesByProject.set(projectId, list)
      return rule
    },

    list(projectId) {
      return [...(rulesByProject.get(projectId) ?? [])]
    },

    clear(projectId) {
      const list = rulesByProject.get(projectId)
      if (!list) return 0
      const count = list.length
      rulesByProject.delete(projectId)
      return count
    },

    consume(projectId, provider, recipients) {
      const list = rulesByProject.get(projectId)
      if (!list || list.length === 0) return null
      const providerKey = provider.trim().toLowerCase()
      const recipientKeys = recipients.map((r) => r.trim().toLowerCase())
      for (let i = 0; i < list.length; i++) {
        const rule = list[i]!
        if (rule.provider !== null && rule.provider !== providerKey) continue
        if (rule.to !== null && !recipientKeys.includes(rule.to)) continue
        if (rule.remaining !== null) {
          rule.remaining -= 1
          if (rule.remaining <= 0) list.splice(i, 1)
        }
        return rule
      }
      return null
    },
  }
}
