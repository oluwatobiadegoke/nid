import type { Message, Rejection, WebhookDelivery } from '../types.js'

export type NidEvent =
  | { kind: 'message'; message: Message }
  | { kind: 'rejection'; rejection: Rejection }
  | { kind: 'webhook'; delivery: WebhookDelivery }

export type EventListener = (event: NidEvent) => void

export interface EventBus {
  emit(projectId: string, event: NidEvent): void
  subscribe(projectId: string, listener: EventListener): () => void
}

export function createMemoryEventBus(): EventBus {
  const listeners = new Map<string, Set<EventListener>>()
  return {
    emit(projectId, event) {
      const set = listeners.get(projectId)
      if (!set) return
      for (const listener of [...set]) listener(event)
    },
    subscribe(projectId, listener) {
      let set = listeners.get(projectId)
      if (!set) {
        set = new Set()
        listeners.set(projectId, set)
      }
      set.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        const current = listeners.get(projectId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(projectId)
      }
    },
  }
}
