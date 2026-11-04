export { createServer, defaultHost, defaultPort, defaultSmtpPort } from './server.js'
export type { ServerOptions, ListenOptions, Listening, TestinboxServer } from './server.js'
export { createSqliteStore, KyselyStore, NodeSqliteDialect } from './store/index.js'
export type { Store, MessageQuery, RejectionQuery, Database, SqliteStoreOptions } from './store/index.js'
export { providers, resend, brevo, SendError } from './providers/index.js'
export type { Provider, ProviderRoute, SendRoute, ReadRoute, IncomingRequest, ProviderReply } from './providers/index.js'
export { extract, htmlToText, matchesPattern } from './extract/index.js'
export type { ExtractInput } from './extract/index.js'
export { defaultLimits, defaultProject } from './ingest/index.js'
export type { Ingest } from './ingest/index.js'
export { hostAllowed } from './security/host.js'
export { serializeMessage, serializeRejection } from './api/serialize.js'
export type { SerializedMessage, SerializedRejection } from './api/serialize.js'
export { version } from './version.js'
export type {
  Attachment,
  AttachmentInfo,
  AuthHook,
  Credential,
  Extracted,
  Limits,
  LimitsHook,
  Link,
  Message,
  NewMessage,
  NewRejection,
  Project,
  Recipient,
  RecipientKind,
  Rejection,
} from './types.js'
