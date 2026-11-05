import { brevo } from './brevo.js'
import { mailgun } from './mailgun.js'
import { postmark } from './postmark.js'
import { resend } from './resend.js'
import { sendgrid } from './sendgrid.js'
import type { Provider } from './types.js'

export type { IncomingRequest, Provider, ProviderReply, ProviderRoute, ReadRoute, SendRoute } from './types.js'
export { SendError } from './types.js'
export { resend, brevo, sendgrid, postmark, mailgun }

export const providers: Provider[] = [resend, brevo, sendgrid, postmark, mailgun]
