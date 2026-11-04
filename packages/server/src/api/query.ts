import { z } from 'zod'

const address = z.string().trim().min(1)
const cursor = z.coerce.number().int().min(0)
const limit = z.coerce.number().int().min(1).max(500)
const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

export const waitQuery = z.strictObject({
  to: address,
  after: cursor.optional(),
  subject: z.string().optional(),
  provider: z.string().optional(),
  has_code: flag.optional(),
  code_pattern: z.string().optional(),
  timeout: z.coerce.number().min(0).max(120).optional(),
})

export const messagesQuery = z.strictObject({
  to: address.optional(),
  subject: z.string().optional(),
  provider: z.string().optional(),
  after: cursor.optional(),
  has_code: flag.optional(),
  limit: limit.optional(),
})

export const rejectionsQuery = z.strictObject({
  to: address.optional(),
  after: cursor.optional(),
  limit: limit.optional(),
})

export const deleteQuery = z.strictObject({
  to: address.optional(),
})

export const streamQuery = z.strictObject({
  after: cursor.optional(),
})

export type QueryIssue = { error: string; details: string[] }

export function parseQuery<T extends z.ZodType>(schema: T, params: URLSearchParams): z.infer<T> | QueryIssue {
  const result = schema.safeParse(Object.fromEntries(params.entries()))
  if (result.success) return result.data as z.infer<T>
  return {
    error: 'Invalid query',
    details: result.error.issues.map((i) => {
      const path = i.path.join('.')
      if (i.code === 'unrecognized_keys') return `Unknown parameter${i.keys.length > 1 ? 's' : ''}: ${i.keys.join(', ')}`
      return path ? `${path}: ${i.message}` : i.message
    }),
  }
}

export function isIssue(value: unknown): value is QueryIssue {
  return !!value && typeof value === 'object' && 'error' in value && 'details' in value
}

export function compilePattern(source: string | undefined): RegExp | null | QueryIssue {
  if (!source) return null
  try {
    return new RegExp(source, 'i')
  } catch (err) {
    return { error: 'Invalid query', details: [`code_pattern: ${(err as Error).message}`] }
  }
}
