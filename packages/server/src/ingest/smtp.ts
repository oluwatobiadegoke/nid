import type { AddressInfo } from 'node:net'
import { SMTPServer, type SMTPServerSession } from 'smtp-server'
import type { NewMessage, Project } from '../types.js'
import { fromMime } from '../providers/mime.js'
import type { Ingest } from './types.js'

export interface SmtpOptions {
  ingest: Ingest
  maxBodyBytes: number
  onError?: ((err: Error) => void) | undefined
}

async function toMessage(raw: Buffer, session: SMTPServerSession): Promise<NewMessage> {
  const rcptTo = session.envelope.rcptTo.map((r) => r.address)
  const message = await fromMime(raw, rcptTo, 'smtp')
  message.meta = { envelope: { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : null, to: rcptTo } }
  return message
}

export function createSmtpServer(options: SmtpOptions): SMTPServer {
  const projects = new WeakMap<SMTPServerSession, Project>()
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    size: options.maxBodyBytes,
    disableReverseLookup: true,
    onAuth(auth, session, callback) {
      options.ingest
        .resolveProject({ kind: 'smtp', provider: 'smtp', value: auth.username ?? '' })
        .then((project) => {
          if (!project) return callback(new Error('Invalid username or password'))
          projects.set(session, project)
          callback(null, { user: project.projectId })
        })
        .catch((err: Error) => callback(err))
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          const err = Object.assign(new Error('Message exceeds the size limit'), { responseCode: 552 })
          return callback(err)
        }
        const raw = Buffer.concat(chunks)
        const resolve = projects.get(session)
          ? Promise.resolve(projects.get(session) as Project)
          : options.ingest.resolveProject({ kind: 'smtp', provider: 'smtp', value: '' })
        resolve
          .then(async (project) => {
            if (!project) throw Object.assign(new Error('Authentication required'), { responseCode: 530 })
            const message = await toMessage(raw, session)
            await options.ingest.accept(project, message)
            callback()
          })
          .catch((err: Error) => {
            options.onError?.(err)
            callback(err)
          })
      })
    },
  })
  server.on('error', (err) => options.onError?.(err))
  return server
}

export function listenSmtp(server: SMTPServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve((server.server.address() as AddressInfo).port)
    })
  })
}
