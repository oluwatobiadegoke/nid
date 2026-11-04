const message = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    provider: { type: 'string' },
    providerId: { type: 'string' },
    from: { type: 'string' },
    replyTo: { type: 'array', items: { type: 'string' } },
    to: { type: 'array', items: { type: 'string' } },
    cc: { type: 'array', items: { type: 'string' } },
    bcc: { type: 'array', items: { type: 'string' } },
    recipients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          name: { type: 'string', nullable: true },
          kind: { type: 'string', enum: ['to', 'cc', 'bcc'] },
        },
      },
    },
    subject: { type: 'string' },
    text: { type: 'string', nullable: true },
    html: { type: 'string', nullable: true },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          filename: { type: 'string' },
          contentType: { type: 'string' },
          contentId: { type: 'string', nullable: true },
          size: { type: 'integer' },
          url: { type: 'string' },
        },
      },
    },
    extracted: {
      type: 'object',
      properties: {
        code: { type: 'string', nullable: true },
        codes: { type: 'array', items: { type: 'string' } },
        link: { type: 'string', nullable: true },
        links: {
          type: 'array',
          items: { type: 'object', properties: { href: { type: 'string' }, text: { type: 'string' } } },
        },
      },
    },
    meta: { type: 'object' },
    raw: { type: 'string', description: 'Only on GET /api/messages/{id}: the request body or MIME as received.' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
  },
}

const rejection = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    provider: { type: 'string' },
    to: { type: 'array', items: { type: 'string' } },
    status: { type: 'integer' },
    error: { type: 'string' },
    raw: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const queryError = {
  description: 'A parameter is unknown or malformed.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'string' }, details: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
}

const param = (name: string, schema: Record<string, unknown>, description: string, required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
})

export function openapi(version: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'testinbox read API',
      version,
      description:
        'Reads the mail your app sent to testinbox. The CLI, the MCP endpoint and the client SDKs are thin wrappers over these routes.',
    },
    paths: {
      '/api/cursor': {
        get: {
          summary: 'Newest message id. Take it before triggering an email.',
          responses: {
            '200': {
              description: 'The cursor',
              content: { 'application/json': { schema: { type: 'object', properties: { cursor: { type: 'integer' } } } } },
            },
          },
        },
      },
      '/api/wait': {
        get: {
          summary: 'Hold the request open until the first matching message after the cursor arrives.',
          parameters: [
            param('to', { type: 'string' }, 'Recipient address. The inbox is the address.', true),
            param('after', { type: 'integer' }, 'Only messages with an id greater than this.'),
            param('subject', { type: 'string' }, 'Case-insensitive substring of the subject.'),
            param('provider', { type: 'string' }, 'Only mail that came in through this provider.'),
            param('has_code', { type: 'boolean' }, 'Skip mail with no extracted code.'),
            param('code_pattern', { type: 'string' }, 'A regex run over subject and text at read time. Its first group, or the whole match, becomes the code.'),
            param('timeout', { type: 'number', maximum: 120, default: 30 }, 'Seconds to wait.'),
          ],
          responses: {
            '200': {
              description: 'The message',
              content: { 'application/json': { schema: { type: 'object', properties: { message } } } },
            },
            '400': queryError,
            '404': {
              description: 'Nothing matched before the timeout. Includes what did arrive and recent rejections.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      timedOut: { type: 'boolean' },
                      error: { type: 'string' },
                      messages: { type: 'array', items: message },
                      recent_rejections: { type: 'array', items: rejection },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/messages': {
        get: {
          summary: 'List messages, newest first.',
          parameters: [
            param('to', { type: 'string' }, 'Recipient address.'),
            param('subject', { type: 'string' }, 'Case-insensitive substring of the subject.'),
            param('provider', { type: 'string' }, 'Provider name.'),
            param('after', { type: 'integer' }, 'Only messages with an id greater than this.'),
            param('has_code', { type: 'boolean' }, 'Only mail with an extracted code.'),
            param('limit', { type: 'integer', maximum: 500, default: 50 }, 'How many.'),
          ],
          responses: {
            '200': {
              description: 'Messages',
              content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: message } } } } },
            },
            '400': queryError,
          },
        },
        delete: {
          summary: 'Clear one address, or everything.',
          parameters: [param('to', { type: 'string' }, 'Clear only this address.')],
          responses: {
            '200': {
              description: 'How many were deleted',
              content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'integer' } } } } },
            },
          },
        },
      },
      '/api/messages/{id}': {
        get: {
          summary: 'One message in full, with the raw request.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': { description: 'The message', content: { 'application/json': { schema: { type: 'object', properties: { message } } } } },
            '404': { description: 'No such message' },
          },
        },
      },
      '/api/messages/{id}/attachments/{n}': {
        get: {
          summary: 'Download an attachment.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'n', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { '200': { description: 'The file' }, '404': { description: 'No such attachment' } },
        },
      },
      '/api/rejections': {
        get: {
          summary: 'Sends the server refused, newest first, with the exact error.',
          parameters: [
            param('to', { type: 'string' }, 'Only rejections addressed to this address.'),
            param('after', { type: 'integer' }, 'Only rejections with an id greater than this.'),
            param('limit', { type: 'integer', maximum: 500, default: 50 }, 'How many.'),
          ],
          responses: {
            '200': {
              description: 'Rejections',
              content: { 'application/json': { schema: { type: 'object', properties: { rejections: { type: 'array', items: rejection } } } } },
            },
          },
        },
      },
      '/api/stream': {
        get: {
          summary: 'Server-sent events: message and rejection events as they arrive.',
          parameters: [param('after', { type: 'integer' }, 'Start after this message id instead of now.')],
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/api/providers': {
        get: {
          summary: 'The provider APIs this server answers, with the setting that points each SDK at it.',
          responses: { '200': { description: 'Providers' } },
        },
      },
      '/healthz': {
        get: {
          summary: '200 and the server version once ready.',
          responses: { '200': { description: 'Ready' } },
        },
      },
    },
    components: { schemas: { Message: message, Rejection: rejection } },
  }
}
