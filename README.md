# n8n-nodes-lettr

This package provides a verified-style n8n community node for [Lettr](https://docs.lettr.com).

## Logo

- Source logo file (edit this): `assets/logo.svg`
- n8n node icon file (auto-generated from source on build): `nodes/Lettr/lettr.svg`

To apply your custom SVG logo:

```bash
npm run sync:logo
npm run build
```

## Supported resources and operations

- **Email**
  - Send
  - Get
- **Domain**
  - Get Many
- **Template**
  - Get Many
- **Webhook**
  - Get Many
- **Campaign**
  - Get Many, Get, Get Events, Send, Schedule, Unschedule
- **Audience Contact**
  - Get Many, Get, Create, Create Many, Update, Delete, Attach/Detach List, Bulk Attach/Detach Lists, Subscribe/Unsubscribe Topic, Bulk Subscribe/Unsubscribe Topics
- **Audience List**
  - Get Many, Get, Create, Update, Delete, Delete Many
- **Audience Topic**
  - Get Many, Get, Create, Update, Delete
- **Audience Property**
  - Get Many, Get, Create, Update, Delete
- **Audience Segment**
  - Get Many, Get, Create, Update, Delete

## Bulk contact import

**Audience Contact → Create Many** has two input modes.

**Email List** (default) sends one list of addresses, with the same lists, topics
and properties applied to everyone. This is the original behaviour — workflows
built before per-contact rows existed keep sending the identical payload.

**Per-Contact Rows** takes a JSON array where each contact carries its own data:

```json
[
  {
    "email": "cara@example.com",
    "properties": { "plan": "pro" },
    "list_ids": ["01h-vip"],
    "topics": [{ "id": "01h-newsletter", "subscription": "opt_in" }]
  },
  { "email": "dan@example.com" }
]
```

Row values stack on top of anything in **Batch Options**, with one exception: a
row-level topic `opt_out` beats a batch-level `opt_in`. That is the point of
`opt_out` — a topic configured to auto-subscribe new contacts can be suppressed
for specific people in the same request, instead of a second cleanup call.

**Update Existing** (off by default) controls only whether properties are merged
into contacts that already exist. Existing contacts are attached to the requested
lists and topics either way.

### Reading the response

The node returns the API response as-is. Two things to watch:

- **A successful run does not mean every row landed.** The API answers `201` even
  when rows were skipped. Check `data.error_count` and `data.errors[]` — each
  error carries `index` (zero-based into the rows you submitted), `email`,
  `error_code` and `error`. Branch on `error_count` with an If node if partial
  failure should stop the workflow.
- **`already_existed` and `updated` overlap.** They answer different questions —
  "was it already there?" and "did we change it?" — so they do not sum to the row
  count. A contact that existed and got attached to a list is counted in both.

`data.contacts[]` gives back `{ id, email, created }` for every contact in
submission order, so a follow-up node can use the IDs without a lookup.

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
- [Get email request](https://docs.lettr.com/api-reference/emails/get-email-request-details)
- [List domains](https://docs.lettr.com/api-reference/domains/get-sending-domains)
- [List templates](https://docs.lettr.com/api-reference/templates/get-all-email-templates)
- [List webhooks](https://docs.lettr.com/api-reference/webhooks/get-all-webhooks)
- [Audience API](https://docs.lettr.com/api-reference/introduction)
