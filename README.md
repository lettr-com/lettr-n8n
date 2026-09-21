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
  - Send, Get, Get Events
  - Schedule, Get Scheduled, Get Many Scheduled, Cancel Scheduled
- **Domain**
  - Get Many, Get, Create, Delete, Verify
- **Project**
  - Get Many
- **Template**
  - Get Many, Get, Create, Update, Delete, Get HTML, Get Merge Tags
- **Folder**
  - Get Many
- **Webhook**
  - Get Many, Get, Create, Update, Delete
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

## Template purpose

A template is either **transactional** (the default — receipts, password resets, alerts) or **campaign** (marketing sent to an audience list). A campaign can only send a template whose purpose is `campaign`, and **the purpose cannot be changed after creation** — a newsletter created with the default has to be rebuilt.

Set it under *Additional Fields → Purpose* when creating a template. Template *Get Many* can filter by it, so `purpose = Campaign` lists exactly the templates a campaign is able to send.

## Folders

The **Folder** resource lists the folders templates are filed into, with each folder's purpose and template count. It is the only way to discover a folder ID: without it the choice is to leave *Folder ID* empty and accept whichever folder the API picks, or to hardcode an integer read out of an app URL.

A folder's purpose is independent of its templates'. Filing a template in a campaign folder does **not** make the template a campaign template.

Template *Get Many* accepts a **Folder ID** filter, which turns reconciling a bulk import into one call rather than a *Get* per template. A folder outside the resolved project is an error rather than an empty list, so a wrong ID cannot be mistaken for an empty folder.

## Preparation status

Imported templates render asynchronously, so a template can exist before it is sendable. Template responses carry `preparation_status` — `pending`, `ready` or `failed` — and the node passes it through untouched.

After an *update* the previous render keeps serving until the new one settles, so a `pending` template still sends; it just isn't serving the new content yet.

## Scheduled emails

Lettr owns the schedule and only hands the email to the sending provider when it
is due. Two consequences shape how the node is wired:

- **The ID you keep is `request_id`**, prefixed `sch_`. That is what *Get
  Scheduled* and *Cancel Scheduled* take, under the field labelled **Scheduled
  Email ID**. Its internal parameter name is still `transmissionId` for
  backwards compatibility with saved workflows — don't be alarmed by it in
  exported JSON.
- **`transmission_id` is the provider's ID and is `null` until the email is
  actually sent.** It is the value that appears on webhook events, so it is what
  you correlate a webhook against — but only after the fact. Reaching for it to
  cancel something will get you `null`.

`state` is one of `scheduled`, `sending`, `sent`, `cancelled` or `failed`.
*Cancel Scheduled* returns the cancelled email with `state` already flipped to
`cancelled`, so a downstream node can assert on it without a follow-up read.

*Get Many Scheduled* lists them, optionally filtered by state. Without it the
only way to find a scheduled email is an ID the workflow already captured, which
leaves anything scheduled elsewhere unreachable from n8n.

The window is **5 minutes to 30 days** ahead, enforced by the API.

## Idempotent sends

*Email → Send → Additional Fields → Idempotency Key* makes a send safe to retry. Reuse the same value and the API returns the original result instead of delivering a second email.

This matters in a workflow: an n8n retry after a timeout has no way of knowing whether the first attempt actually landed. Derive the key from what the send is about — an order ID, an invoice number — rather than from a timestamp or random value, which defeat the point on a retry. Keys are kept 24 hours and scoped per team and API key.

The field is shared with *Schedule* in the UI but only applies to *Send*: a scheduled email is created once and then cancelled by ID, so there is nothing to replay.

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
