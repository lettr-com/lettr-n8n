# n8n-nodes-lettr

This package provides a verified-style n8n community node for [Lettr](https://docs.lettr.com).

## Supported resources and operations

- **Email**
  - Send
  - Get
  - Get Many
- **Domain**
  - Get Many
- **Template**
  - Get Many
- **Webhook**
  - Get Many

## Credentials

Use a Lettr API key from your Lettr account.

- Credential type: `Lettr API`
- Auth header: `Authorization: Bearer <api_key>`

## Build

```bash
npm install
npm run build
```

## Local n8n install

```bash
npm install /absolute/path/to/n8n-nodes-lettr
```

Then restart n8n.

## Notes for community verification

- Uses official Lettr REST endpoints at `https://app.lettr.com/api`
- Includes credential test call (`GET /domains`)
- Includes pagination controls for list operations
- Runtime has no third-party dependencies

## API references used

- [Lettr API introduction](https://docs.lettr.com/api-reference/introduction)
- [Send email](https://docs.lettr.com/api-reference/emails/send-email)
- [List email requests](https://docs.lettr.com/api-reference/emails/get-email-requests)
- [Get email request](https://docs.lettr.com/api-reference/emails/get-email-request-details)
- [List domains](https://docs.lettr.com/api-reference/domains/get-sending-domains)
- [List templates](https://docs.lettr.com/api-reference/templates/get-all-email-templates)
- [List webhooks](https://docs.lettr.com/api-reference/webhooks/get-all-webhooks)
