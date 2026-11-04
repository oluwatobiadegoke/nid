export type RecipientKind = 'to' | 'cc' | 'bcc'

export interface Recipient {
  address: string
  name: string | null
  kind: RecipientKind
}

export interface Attachment {
  filename: string
  contentType: string
  contentId: string | null
  content: Uint8Array
}

export interface AttachmentInfo {
  n: number
  filename: string
  contentType: string
  contentId: string | null
  size: number
}

export interface Link {
  href: string
  text: string
}

export interface Extracted {
  code: string | null
  codes: string[]
  link: string | null
  links: Link[]
}

export interface NewMessage {
  provider: string
  providerId: string
  from: string
  replyTo: string[]
  recipients: Recipient[]
  subject: string
  text: string | null
  html: string | null
  headers: Record<string, string>
  attachments: Attachment[]
  raw: string
  meta: Record<string, unknown>
  idempotencyKey: string | null
}

export interface Message extends Omit<NewMessage, 'attachments'> {
  id: number
  projectId: string
  attachments: AttachmentInfo[]
  extracted: Extracted
  createdAt: string
  expiresAt: string | null
}

export interface NewRejection {
  provider: string
  to: string[]
  status: number
  error: string
  raw: string
}

export interface Rejection extends NewRejection {
  id: number
  projectId: string
  createdAt: string
}

export interface Project {
  projectId: string
  plan: string
}

export interface Limits {
  maxBodyBytes: number
  retentionHours: number | null
}

export interface Credential {
  kind: 'http' | 'smtp'
  provider: string
  value: string
}

export type AuthHook = (credential: Credential) => Promise<Project | null> | Project | null

export type LimitsHook = (project: Project) => Promise<Limits> | Limits
