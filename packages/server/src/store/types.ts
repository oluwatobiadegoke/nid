import type {
  Attachment,
  Extracted,
  Message,
  NewMessage,
  NewRejection,
  Rejection,
} from '../types.js'

export interface MessageQuery {
  to?: string | undefined
  subject?: string | undefined
  provider?: string | undefined
  after?: number | undefined
  hasCode?: boolean | undefined
  limit?: number | undefined
  order?: 'asc' | 'desc' | undefined
}

export interface RejectionQuery {
  to?: string | undefined
  after?: number | undefined
  since?: string | undefined
  limit?: number | undefined
}

export interface Store {
  migrate(): Promise<void>
  cursor(projectId: string): Promise<number>
  insertMessage(
    projectId: string,
    message: NewMessage,
    extracted: Extracted,
    expiresAt: string | null,
  ): Promise<Message>
  getMessage(projectId: string, id: number): Promise<Message | null>
  findByProviderId(projectId: string, provider: string, providerId: string): Promise<Message | null>
  findByIdempotencyKey(projectId: string, provider: string, key: string): Promise<Message | null>
  listMessages(projectId: string, query: MessageQuery): Promise<Message[]>
  getAttachment(projectId: string, messageId: number, n: number): Promise<Attachment | null>
  deleteMessages(projectId: string, to?: string): Promise<number>
  insertRejection(projectId: string, rejection: NewRejection): Promise<Rejection>
  listRejections(projectId: string, query: RejectionQuery): Promise<Rejection[]>
  deleteExpired(now: string): Promise<number>
  close(): Promise<void>
}
