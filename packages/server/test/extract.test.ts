import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extract, htmlToText, matchesPattern } from '../src/extract/index.js'

test('finds a digit code near the word code', () => {
  const result = extract({ subject: 'Your sign-in code', text: 'Your code is 482913. It expires in 10 minutes.', html: null })
  assert.equal(result.code, '482913')
  assert.deepEqual(result.codes, ['482913'])
})

test('prefers the subject over the body', () => {
  const result = extract({ subject: '7731 is your Clinid code', text: 'Enter 7731 to continue. Sent in 2026.', html: null })
  assert.equal(result.code, '7731')
})

test('skips years and phone numbers', () => {
  const result = extract({
    subject: 'Welcome',
    text: 'Copyright 2026. Call +1 555 123 4567 or 0803-555-1212 for help. Verification code: 55512',
    html: null,
  })
  assert.equal(result.code, '55512')
  assert.equal(result.codes.length, 1)
})

test('finds upper-case alphanumeric codes and dashed codes', () => {
  assert.equal(extract({ subject: 'Confirm', text: 'Your verification code is X7K2PQ9', html: null }).code, 'X7K2PQ9')
  assert.equal(extract({ subject: 'Confirm', text: 'Enter code 123-456 to continue', html: null }).code, '123-456')
})

test('ignores digits inside URLs and digits with no keyword nearby', () => {
  const result = extract({
    subject: 'Receipt',
    text: 'Order 88213 shipped. Track at https://x.co/t/4421991 anytime.',
    html: null,
  })
  assert.equal(result.code, null)
})

test('extracts links from html with their text, skipping unsubscribe and images', () => {
  const html = `
    <p>Hi</p>
    <a href="https://app.acme.com/img/logo.png"><img src="x"></a>
    <a href="https://app.acme.com/verify?token=abc&amp;x=1">Verify <b>email</b></a>
    <a href="https://app.acme.com/unsubscribe">Unsubscribe</a>
    <a href='mailto:help@acme.com'>Help</a>`
  const result = extract({ subject: 'Verify', text: null, html })
  assert.equal(result.link, 'https://app.acme.com/verify?token=abc&x=1')
  assert.deepEqual(
    result.links.map((l) => l.href),
    ['https://app.acme.com/img/logo.png', 'https://app.acme.com/verify?token=abc&x=1', 'https://app.acme.com/unsubscribe', 'mailto:help@acme.com'],
  )
  assert.equal(result.links[1]?.text, 'Verify email')
})

test('finds bare urls in text and trims trailing punctuation', () => {
  const result = extract({ subject: 'Invite', text: 'Join here: https://app.acme.com/invite/9f2k.', html: null })
  assert.equal(result.link, 'https://app.acme.com/invite/9f2k')
})

test('reads a code from the html when there is no text', () => {
  assert.equal(htmlToText('<p>Your <b>OTP</b> is <span>915</span></p>'), 'Your OTP is 915')
  assert.equal(extract({ subject: 'Code', text: null, html: '<p>Your OTP is <b>915204</b></p>' }).code, '915204')
  assert.equal(extract({ subject: 'Code', text: null, html: '<p>Your OTP is <span>915 </span>204</p>' }).code, '915 204')
})

test('uses template variables when a send has no body', () => {
  const result = extract({
    subject: '',
    text: null,
    html: null,
    variables: { name: 'Ada', otp: '557812', verify_url: 'https://app.acme.com/v/1' },
  })
  assert.equal(result.code, '557812')
  assert.equal(result.link, 'https://app.acme.com/v/1')
})

test('code_pattern runs over subject and text and returns the first group', () => {
  const message = { subject: 'Welcome', text: 'Your access key is ACME-77-ZED', html: null }
  assert.equal(matchesPattern(message, /access key is ([A-Z0-9-]+)/), 'ACME-77-ZED')
  assert.equal(matchesPattern(message, /nothing/), null)
})
