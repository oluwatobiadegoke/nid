import { test as base } from '@playwright/test'
import { Inbox, type InboxOptions } from './index.js'

export interface InboxFixtures {
  inbox: Inbox
}

export interface InboxWorkerOptions {
  inboxOptions: InboxOptions
}

export const test = base.extend<InboxFixtures, InboxWorkerOptions>({
  inboxOptions: [{}, { option: true, scope: 'worker' }],
  inbox: async ({ inboxOptions }, use) => {
    const inbox = new Inbox(inboxOptions)
    await inbox.start()
    await use(inbox)
  },
})

export { expect } from '@playwright/test'
export { Inbox, InboxError, InboxTimeoutError, createInbox } from './index.js'
export type { Email, FullEmail, InboxOptions, ListOptions, Rejection, WaitOptions } from './index.js'
