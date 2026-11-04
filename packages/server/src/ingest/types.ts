import type { Extracted, Limits, Message, NewMessage, NewRejection, Project, Rejection } from '../types.js'

export interface Ingest {
  resolveProject(credential: { kind: 'http' | 'smtp'; provider: string; value: string }): Promise<Project | null>
  limitsFor(project: Project): Promise<Limits>
  accept(project: Project, message: NewMessage): Promise<Message>
  reject(project: Project, rejection: NewRejection): Promise<Rejection>
  extract(message: NewMessage): Extracted
}
