import type { Extracted, Link } from '../types.js'

const keyword =
  /\b(code|codes|otp|one[- ]time|passcode|pass code|pin|verification|verify|token|confirm|confirmation|login|sign[- ]in|2fa|two[- ]factor|security)\b/i
const digitCode = /(?<![\d-])(\d{3}[- ]\d{3}|\d{4,8})(?![\d-])/g
const alnumCode = /(?<![A-Z0-9])(?=[A-Z0-9]{6,8}(?![A-Z0-9]))(?=[A-Z0-9]*\d)[A-Z0-9]{6,8}/g
const urlPattern = /https?:\/\/[^\s<>"'`)\]]+/g
const windowBefore = 80
const windowAfter = 40

const anchorPattern = /<a\b([^<>]*)>((?:(?!<a\b)[\s\S])*?)(?:<\/a\s*>|(?=<a\b)|$)/gi
const hrefPattern = /(?:^|[\s"'/])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const imageExtensions = /\.(png|jpe?g|gif|svg|webp|bmp|ico)(\?|$)/i

function codePoint(value: number, entity: string): string {
  return value <= 0x10ffff ? String.fromCodePoint(value) : entity
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (entity, n: string) => codePoint(Number(n), entity))
    .replace(/&#x([0-9a-f]+);/gi, (entity, n: string) => codePoint(parseInt(n, 16), entity))
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|td|th)>/gi, '\n')
      .replace(/<[a-z!/?][^>]*(?:>|$)/gi, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function trimUrl(url: string): string {
  return url.replace(/(?<![.,;:!?])[.,;:!?]+$/, '')
}

function isYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token)
}

function looksLikePhone(text: string, index: number, token: string): boolean {
  const before = text.slice(Math.max(0, index - 4), index)
  const after = text.slice(index + token.length, index + token.length + 4)
  return /[\d)]\s?[-.\s]?$/.test(before) || /^\s?[-.\s]?\d/.test(after) || /\+\d*$/.test(before)
}

function nearKeyword(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - windowBefore), index)
  const after = text.slice(index + length, index + length + windowAfter)
  return keyword.test(before) || keyword.test(after)
}

function findCodes(text: string): string[] {
  const masked = text.replace(urlPattern, (m) => ' '.repeat(m.length))
  const found: { index: number; token: string }[] = []
  for (const match of masked.matchAll(digitCode)) {
    const token = match[0]
    if (isYear(token)) continue
    if (looksLikePhone(masked, match.index, token)) continue
    if (!nearKeyword(masked, match.index, token.length)) continue
    found.push({ index: match.index, token })
  }
  for (const match of masked.matchAll(alnumCode)) {
    const token = match[0]
    if (/^\d+$/.test(token)) continue
    if (!nearKeyword(masked, match.index, token.length)) continue
    found.push({ index: match.index, token })
  }
  found.sort((a, b) => a.index - b.index)
  return [...new Set(found.map((f) => f.token))]
}

function findLinks(html: string | null, text: string | null): Link[] {
  const links: Link[] = []
  const seen = new Set<string>()
  const push = (href: string, label: string) => {
    const clean = trimUrl(decodeEntities(href.trim()))
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    links.push({ href: clean, text: label.trim() })
  }
  if (html) {
    for (const match of html.matchAll(anchorPattern)) {
      const href = match[1]?.match(hrefPattern)
      if (href) push(href[1] ?? href[2] ?? href[3] ?? '', htmlToText(match[2] ?? ''))
    }
  }
  if (text) {
    for (const match of text.matchAll(urlPattern)) push(match[0], '')
  }
  return links
}

function isPrimaryLink(link: Link): boolean {
  const href = link.href.toLowerCase()
  if (href.startsWith('mailto:') || href.startsWith('tel:')) return false
  if (imageExtensions.test(href)) return false
  if (href.includes('unsubscribe') || link.text.toLowerCase().includes('unsubscribe')) return false
  return true
}

const codeKeys = ['code', 'otp', 'token', 'passcode', 'pin', 'verification_code', 'verificationcode']
const linkKeys = ['url', 'link', 'magic_link', 'magiclink', 'verify_url', 'verifyurl', 'action_url', 'actionurl']

function fromVariables(variables: Record<string, unknown>): { code: string | null; link: string | null; values: string[] } {
  let code: string | null = null
  let link: string | null = null
  const values: string[] = []
  const visit = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      const name = key.toLowerCase()
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>)
        continue
      }
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const str = String(value)
      values.push(str)
      if (!code && codeKeys.includes(name) && str.length >= 4) code = str
      if (!link && linkKeys.includes(name) && /^https?:\/\//.test(str)) link = str
    }
  }
  visit(variables)
  return { code, link, values }
}

export interface ExtractInput {
  subject: string
  text: string | null
  html: string | null
  variables?: Record<string, unknown> | undefined
}

export function bodyText(message: { text: string | null; html: string | null }): string {
  return message.text ?? (message.html ? htmlToText(message.html) : '')
}

export function extract(input: ExtractInput): Extracted {
  const text = bodyText(input)
  let codes = [...new Set([...findCodes(input.subject), ...findCodes(text)])]
  const links = findLinks(input.html, input.text)
  let link = links.find(isPrimaryLink)?.href ?? null
  if (input.variables && !text && !input.html) {
    const found = fromVariables(input.variables)
    if (found.code) codes = [found.code, ...codes.filter((c) => c !== found.code)]
    if (codes.length === 0) codes = findCodes(found.values.join('\n'))
    if (found.link) link = found.link
    const seen = new Set(links.map((l) => l.href))
    for (const value of found.values) {
      for (const m of value.matchAll(urlPattern)) {
        const href = trimUrl(m[0])
        if (!seen.has(href)) links.push({ href, text: '' })
        seen.add(href)
      }
    }
    if (!link) link = links.find(isPrimaryLink)?.href ?? null
  }
  return { code: codes[0] ?? null, codes, link, links }
}

export function matchesPattern(message: { subject: string; text: string | null; html: string | null }, pattern: RegExp): string | null {
  const haystack = [message.subject, bodyText(message)].join('\n')
  const match = haystack.match(pattern)
  if (!match) return null
  return match[1] ?? match[0]
}
