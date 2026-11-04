import { brevo } from './brevo.js'
import { resend } from './resend.js'
import type { Provider } from './types.js'

export type { IncomingRequest, Provider, ProviderReply, ProviderRoute, ReadRoute, SendRoute } from './types.js'
export { SendError } from './types.js'
export { resend, brevo }

export const providers: Provider[] = [resend, brevo]
