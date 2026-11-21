import { webhookEvents } from '../providers/types.js'

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

const webhookDelivery = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    projectId: { type: 'string' },
    messageId: { type: 'integer' },
    provider: { type: 'string' },
    event: { type: 'string', enum: [...webhookEvents] },
    recipient: { type: 'string' },
    url: { type: 'string' },
    delivered: { type: 'boolean' },
    appStatus: { type: 'integer', nullable: true },
    appBody: { type: 'string' },
    durationMs: { type: 'integer' },
    error: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
}

const faultRule = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    projectId: { type: 'string' },
    provider: { type: 'string', nullable: true },
    to: { type: 'string', nullable: true },
    status: { type: 'integer' },
    body: {},
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    delayMs: { type: 'integer' },
    remaining: { type: 'integer', nullable: true },
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
      title: 'nid read API',
      version,
      description:
        'Reads the mail your app sent to nid. The CLI, the MCP endpoint and the client SDKs are thin wrappers over these routes.',
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
            param('code_pattern', { type: 'string' }, 'A regex run over subject, text and HTML turned into text at read time. Its first group, or the whole match, becomes the code.'),
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
        delete: {
          summary: 'Delete one message.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'Deleted',
              content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } } },
            },
            '404': { description: 'No such message' },
          },
        },
      },
      '/api/messages/{id}/html': {
        get: {
          summary: 'Sandboxed HTML preview with inline cid: attachments resolved.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': { description: 'HTML preview' },
            '404': { description: 'No such message or no HTML body' },
          },
        },
      },
      '/api/messages/{id}/events': {
        get: {
          summary: 'List webhook delivery attempts for a message.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'Webhook delivery attempts',
              content: { 'application/json': { schema: { type: 'object', properties: { events: { type: 'array', items: webhookDelivery } } } } },
            },
            '404': { description: 'No such message' },
          },
        },
        post: {
          summary: "Send the provider's signed webhook for this message to your app, and return your app's answer.",
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: [...webhookEvents] },
                    recipient: { type: 'string' },
                    url: { type: 'string' },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The webhook was sent. delivered is true when your app answered 2xx.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      url: { type: 'string' },
                      delivered: { type: 'boolean' },
                      appStatus: { type: 'integer', nullable: true },
                      appBody: { type: 'string' },
                      durationMs: { type: 'integer' },
                      error: { type: 'string', description: 'Why nid could not reach your app.' },
                    },
                  },
                },
              },
            },
            '400': { description: 'Unknown type, no webhook URL or secret set, or mail sent over SMTP' },
            '404': { description: 'No such message' },
            '415': { description: 'The body was not sent as application/json' },
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
        delete: {
          summary: 'Delete rejections for one address, or everything.',
          parameters: [param('to', { type: 'string' }, 'Clear only this address.')],
          responses: {
            '200': {
              description: 'How many were deleted',
              content: { 'application/json': { schema: { type: 'object', properties: { deleted: { type: 'integer' } } } } },
            },
          },
        },
      },
      '/api/faults': {
        get: {
          summary: 'List active fault rules.',
          responses: {
            '200': {
              description: 'Fault rules',
              content: { 'application/json': { schema: { type: 'object', properties: { faults: { type: 'array', items: faultRule } } } } },
            },
          },
        },
        post: {
          summary: 'Add a fault or latency injection rule.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string' },
                    to: { type: 'string' },
                    status: { type: 'integer' },
                    body: {},
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                    delayMs: { type: 'integer' },
                    count: { type: 'integer', nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created fault rule',
              content: { 'application/json': { schema: { type: 'object', properties: { fault: faultRule } } } },
            },
            '400': queryError,
          },
        },
        delete: {
          summary: 'Clear all fault rules.',
          responses: {
            '200': {
              description: 'Cleared count',
              content: { 'application/json': { schema: { type: 'object', properties: { cleared: { type: 'integer' } } } } },
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
          summary: 'The provider APIs this server answers, SMTP port, and configured webhook providers.',
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
    components: { schemas: { Message: message, Rejection: rejection, WebhookDelivery: webhookDelivery, FaultRule: faultRule } },
  }
}
