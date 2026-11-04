import { extract as extractFrom } from '../extract/index.js'
import type { Store } from '../store/types.js'
import type { AuthHook, Credential, Limits, LimitsHook, NewMessage, NewRejection, Project } from '../types.js'
import type { Ingest } from './types.js'

export type { Ingest } from './types.js'

export const defaultProject: Project = { projectId: 'default', plan: 'local' }

export const defaultLimits: Limits = { maxBodyBytes: 50 * 1024 * 1024, retentionHours: null }

export interface IngestOptions {
  store: Store
  auth?: AuthHook | undefined
  limits?: LimitsHook | undefined
  onMessage?: ((message: Awaited<ReturnType<Store['insertMessage']>>) => void) | undefined
}

export function createIngest(options: IngestOptions): Ingest {
  const auth: AuthHook = options.auth ?? (() => defaultProject)
  const limits: LimitsHook = options.limits ?? (() => defaultLimits)
  return {
    async resolveProject(credential: Credential) {
      return auth(credential)
    },
    async limitsFor(project) {
      return limits(project)
    },
    extract(message: NewMessage) {
      return extractFrom({
        subject: message.subject,
        text: message.text,
        html: message.html,
        variables: message.meta.variables as Record<string, unknown> | undefined,
      })
    },
    async accept(project, message) {
      const extracted = this.extract(message)
      const current = await limits(project)
      const expiresAt =
        current.retentionHours === null
          ? null
          : new Date(Date.now() + current.retentionHours * 3600_000).toISOString()
      const stored = await options.store.insertMessage(project.projectId, message, extracted, expiresAt)
      options.onMessage?.(stored)
      return stored
    },
    async reject(project, rejection: NewRejection) {
      return options.store.insertRejection(project.projectId, rejection)
    },
  }
}
