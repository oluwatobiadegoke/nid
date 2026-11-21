import { installInterceptor } from './intercept-core.js'

export { installInterceptor, shouldInterceptHost } from './intercept-core.js'

if (process.env.NID_URL && process.env.NID_INTERCEPT !== '0') {
  installInterceptor(process.env.NID_URL)
}
