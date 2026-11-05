import { randomBytes } from 'node:crypto'
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { SerializedMessage } from '../api/serialize.js'
import { htmlToText } from '../extract/index.js'
import { version } from '../version.js'

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

const instructions = `nid catches the email an app sends while you test it.
To test a sign-up or sign-in: call new_address, use the address in the app, then call wait_for_email with the address and the cursor new_address gave you. The result has the code and the links.
To wait for a second email to the same address, pass the id of the last email as after.`

function reply(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function problem(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function summary(m: SerializedMessage) {
  return { id: m.id, from: m.from, to: m.to, subject: m.subject, receivedAt: m.createdAt, code: m.extracted.code, link: m.extracted.link }
}

function detail(m: SerializedMessage) {
  const { id, from, to, ...rest } = summary(m)
  return { id, from, to, cc: m.cc, ...rest, links: m.extracted.links, text: m.text ?? (m.html ? htmlToText(m.html) : '') }
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value))
  return query.size > 0 ? `?${query}` : ''
}

class ApiError extends Error {}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>

const wrongUrl = "Check that nid's URL is its address, such as http://127.0.0.1:4400, without /mcp."

async function request<T>(api: ApiFetch, path: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await api(path, init)
  } catch (err) {
    if (init.signal?.aborted) throw err
    throw new ApiError(`Could not reach nid: ${(err as Error).message}. Is nid serve running?`)
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string; details?: string[]; timedOut?: boolean }) | null
  if (!body) throw new ApiError(`The server answered ${response.status} and not like nid. ${wrongUrl}`)
  if (response.ok || body.timedOut) return body
  const hint = response.status === 404 ? [wrongUrl] : []
  throw new ApiError([body.error ?? `nid answered ${response.status}`, ...(body.details ?? []), ...hint].join('. '))
}

function guarded<A>(api: ApiFetch, handler: (args: A, call: Call) => Promise<CallToolResult>) {
  return async (args: A, ctx: ServerContext) => {
    const call: Call = (path, init) => request(api, path, { ...init, signal: ctx.mcpReq.signal })
    try {
      return await handler(args, call)
    } catch (err) {
      if (err instanceof ApiError) return problem(err.message)
      throw err
    }
  }
}

async function latest(call: Call, to: string, hasCode?: boolean): Promise<SerializedMessage | undefined> {
  const body = await call<{ messages: SerializedMessage[] }>(`/api/messages${queryString({ to, has_code: hasCode, limit: 1 })}`)
  return body.messages[0]
}

const maxWaitSeconds = 55

const readOnly = { readOnlyHint: true }

const address = z.string().trim().min(1).describe('The email address the app sent to')

export function createMcpServer(api: ApiFetch): McpServer {
  const server = new McpServer({ name: 'nid', version }, { instructions })

  server.registerTool(
    'new_address',
    {
      description: 'Make a fresh, unique address to sign up with, and the cursor to pass to wait_for_email as after',
      inputSchema: z.object({ prefix: z.string().optional().describe('A word to start the address with, such as signup') }),
      annotations: readOnly,
    },
    guarded(api, async ({ prefix }, call) => {
      const tag = (prefix ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'test'
      const body = await call<{ cursor: number }>('/api/cursor')
      return reply({ address: `${tag}.${randomBytes(4).toString('hex')}@inbox.test`, cursor: body.cursor })
    }),
  )

  server.registerTool(
    'wait_for_email',
    {
      description:
        'Wait for an email to an address newer than after, and return it with its code, links and text. Without after it returns the first email ever sent to the address, so pass after to get a newer one, such as a resent code. If none comes, it explains why, including any send nid refused',
      inputSchema: z.object({
        to: address,
        after: z.number().int().min(0).optional().describe('Only return email newer than this id: the cursor from new_address, or the id of the last email you read'),
        subject: z.string().optional().describe('Only return email whose subject contains this'),
        has_code: z.boolean().optional().describe('Skip email that has no code'),
        code_pattern: z.string().optional().describe('A regular expression for the code, when nid guesses it wrong. Its first group is returned'),
        timeout: z.number().min(0).max(maxWaitSeconds).optional().describe(`Seconds to wait, up to ${maxWaitSeconds}. Default 30. Call again to keep waiting`),
      }),
      annotations: readOnly,
    },
    guarded(api, async ({ to, after, subject, has_code, code_pattern, timeout }, call) => {
      const query = queryString({ to, after, subject, has_code, code_pattern, timeout })
      const body = await call<{ message?: SerializedMessage; error?: string }>(`/api/wait${query}`)
      if (!body.message) return problem(body.error ?? `No email arrived for ${to}`)
      return reply(detail(body.message))
    }),
  )

  server.registerTool(
    'get_code',
    {
      description: 'Get the one-time code from the latest email to an address that has one',
      inputSchema: z.object({ to: address }),
      annotations: readOnly,
    },
    guarded(api, async ({ to }, call) => {
      const message = await latest(call, to, true)
      if (!message) return problem(`No email with a code has arrived for ${to}. Call wait_for_email to wait for one.`)
      return reply({ code: message.extracted.code, id: message.id, subject: message.subject })
    }),
  )

  server.registerTool(
    'get_links',
    {
      description: 'Get the links in the latest email to an address. link is the one a person would most likely click',
      inputSchema: z.object({ to: address }),
      annotations: readOnly,
    },
    guarded(api, async ({ to }, call) => {
      const message = await latest(call, to)
      if (!message) return problem(`No email has arrived for ${to}. Call wait_for_email to wait for one.`)
      return reply({ link: message.extracted.link, links: message.extracted.links, id: message.id, subject: message.subject })
    }),
  )

  server.registerTool(
    'list_messages',
    {
      description: 'List recent email, newest first, for one address or for every address',
      inputSchema: z.object({
        to: address.optional(),
        limit: z.number().int().min(1).max(100).optional().describe('How many to list. Default 20'),
      }),
      annotations: readOnly,
    },
    guarded(api, async ({ to, limit }, call) => {
      const body = await call<{ messages: SerializedMessage[] }>(`/api/messages${queryString({ to, limit: limit ?? 20 })}`)
      return reply(body.messages.map(summary))
    }),
  )

  server.registerTool(
    'clear',
    {
      description: 'Delete the email for one address, or all email when no address is given',
      inputSchema: z.object({ to: address.optional() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guarded(api, async ({ to }, call) => {
      const body = await call<{ deleted: number }>(`/api/messages${queryString({ to })}`, { method: 'DELETE' })
      return reply({ deleted: body.deleted })
    }),
  )

  return server
}
