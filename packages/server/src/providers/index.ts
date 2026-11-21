import { brevo } from './brevo.js'
import { mailgun } from './mailgun.js'
import { postmark } from './postmark.js'
import { resend } from './resend.js'
import { sendgrid } from './sendgrid.js'
import { ses } from './ses.js'
import type { Provider } from './types.js'

export type {
  IncomingRequest,
  Provider,
  ProviderReply,
  ProviderRoute,
  ReadRoute,
  SendRoute,
  WebhookEvent,
  WebhookInput,
  WebhookRequest,
} from './types.js'
export { SendError } from './types.js'
export { sendgridWebhookPublicKey } from './sendgrid.js'
export { resend, brevo, sendgrid, postmark, mailgun, ses }

export const providers: Provider[] = [resend, brevo, sendgrid, postmark, mailgun, ses]
