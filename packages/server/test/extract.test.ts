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

test('a script or data link in an email never becomes a link to click', () => {
  const result = extract({
    subject: 'Verify your email',
    text: null,
    html: [
      '<a href=" JaVa&#x09;Script:alert(1)">Verify</a>',
      '<a href="data:text/html;base64,PGI+aGk8L2I+">Open</a>',
      '<a href="VBScript:msgbox(1)">Verify</a>',
      '<a href="https://app.acme.com/verify?t=1">Verify</a>',
      '<a href="acme://sign-in?token=abc">Open the app</a>',
    ].join(''),
  })
  assert.equal(result.link, 'https://app.acme.com/verify?t=1')
  assert.deepEqual(result.links.map((l) => l.href), ['https://app.acme.com/verify?t=1', 'acme://sign-in?token=abc'])
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

test('broken or hostile html is read quickly and still gives the code and link', () => {
  const start = '<p>Your code is 482913</p><a class="btn" data-href="x" href="https://app.acme.com/verify?t=1">Verify</a>'
  const codes = Array.from({ length: 40_000 }, (_, i) => `<p>code ${1_000_000 + i}</p>`).join('')
  const junk = ['<'.repeat(200_000), '<a '.repeat(70_000), '<script'.repeat(30_000), `<a href="https://a${'.'.repeat(200_000)}x">x</a>`, codes]
  for (const tail of junk) {
    const began = performance.now()
    const result = extract({ subject: 'Sign in', text: null, html: start + tail })
    assert.ok(performance.now() - began < 1000, `took ${Math.round(performance.now() - began)}ms`)
    assert.equal(result.code, '482913')
    assert.equal(result.link, 'https://app.acme.com/verify?t=1')
  }
  const urls = Array.from({ length: 25_000 }, (_, i) => `https://app.acme.com/r/${i}`).join(' ')
  const began = performance.now()
  const templated = extract({ subject: 'Welcome', text: null, html: null, variables: { code: '482913', urls } })
  assert.ok(performance.now() - began < 1000, `took ${Math.round(performance.now() - began)}ms`)
  assert.equal(templated.links.length, 25_000)
  assert.equal(htmlToText('<p>Code 1234</p><script>track("5678")'), 'Code 1234')
})

test('links and codes survive the html quirks real templates produce', () => {
  const result = extract({
    subject: 'Sign in',
    text: null,
    html: [
      '<a class="btn"href="https://app.acme.com/verify?t=1">Verify</a>',
      '<p>Expires in <10 min. Your code &#99999999; is 482913</p>',
      "<a href=https://app.acme.com/o'neil/help>Help",
      '<a href="https://app.acme.com/more">More</a>',
    ].join(''),
  })
  assert.deepEqual(result.codes, ['482913'])
  assert.equal(result.link, 'https://app.acme.com/verify?t=1')
  assert.deepEqual(result.links.map((l) => l.href), ['https://app.acme.com/verify?t=1', "https://app.acme.com/o'neil/help", 'https://app.acme.com/more'])
})

test('a closing tag with a space and a last link left open still end where a browser ends them', () => {
  const spaced = extract({
    subject: 'Sign in',
    text: null,
    html: '<a href="https://app.acme.com/verify?t=1">Verify</a ><p>Not you? Unsubscribe from these emails. Code &#x110000; 482913</p>',
  })
  assert.equal(spaced.link, 'https://app.acme.com/verify?t=1')
  assert.deepEqual(spaced.codes, ['482913'])
  const open = extract({ subject: 'Sign in', text: null, html: '<p>Code 482913</p><a href="https://app.acme.com/verify?t=1">Verify' })
  assert.equal(open.link, 'https://app.acme.com/verify?t=1')
  assert.equal(htmlToText('<p>Code 1234</p><script>track("5678")</script ><p>bye</p>'), 'Code 1234\n bye')
})
