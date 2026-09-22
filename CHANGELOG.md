# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-09-22

Follows the API's scheduled-email rework (TPL-2621). Lettr used to hand a
scheduled email straight to SparkPost, which made the provider's transmission
the real object; SparkPost then retired per-transmission GET and DELETE, so
Lettr now holds the schedule itself and only hands the email over when it is
due. That moves the identity of a scheduled email, which is what most of this
release is about.

### Added

- **Email → Get Many Scheduled**, with an optional status filter over the five
  states (`scheduled`, `sending`, `sent`, `cancelled`, `failed`) and the usual
  Return All / Limit / Simplify controls. Until now a scheduled email could only
  be fetched by an ID the workflow had already captured, so anything scheduled
  by another system — or by a run whose output was not stored — was invisible
  from n8n. Page-based like the other list operations, capped at the API's
  `per_page` maximum of 100 per request.

### Changed

- **"Transmission ID" is now "Scheduled Email ID"** on Get Scheduled and Cancel
  Scheduled. The value to paste is Lettr's own `request_id` (prefixed `sch_`);
  the provider's `transmission_id` is a *different* field that stays `null`
  until the email is actually sent and is the one that turns up on webhook
  events. The old label pointed at the wrong field, and on a still-scheduled
  email that field is empty. **The internal parameter name is deliberately left
  as `transmissionId`** — it is persisted in every saved workflow, so renaming
  it would blank the field on upgrade.
- **The scheduling window is 5 minutes to 30 days**, up from 3 days. Only the
  field description changed; the API does the enforcing.
- Cancel Scheduled now emits the cancelled email, with `state` flipped to
  `cancelled`, where the endpoint used to answer with no content. This needed no
  node change — the response has always been passed through as-is — but it is
  worth knowing that the operation now produces something to branch on.

### Fixed

- The `User-Agent` version constant was left at `0.6.0` when 0.7.0 shipped, so
  every request has been under-reporting the node version. Back in sync.

## [0.7.0] - 2026-09-11

Brings the node level with the SDKs: template purpose, the folders endpoint,
preparation status, folder filtering and idempotent sends (TPL-2459, TPL-2539).
Everything here is additive — existing workflows keep working untouched and send
the exact same payloads.

### Added

- **Purpose on template create** — `transactional` (the default) or `campaign`,
  under Additional Fields. This is the one that matters: a campaign can only
  send a template whose purpose is `campaign`, and the purpose cannot be changed
  after creation, so a newsletter built with the default had to be recreated
  from scratch. The field description explains the split rather than naming the
  enum, because nothing else in the UI tells you a campaign needs a marketing
  template.
- **Folder resource** with Get Many, filterable by project and purpose. Nothing
  else in the API returns a folder ID, so before this the options were to leave
  Folder ID empty and accept whichever folder the API picked, or to hardcode an
  integer read out of an app URL.
- **Purpose and Folder ID filters on template Get Many.** Filtering by folder
  turns reconciling a bulk import into one call rather than a Get per template,
  each dragging the full HTML payload against the same rate limit. A folder
  outside the resolved project is an error rather than an empty list, so a wrong
  ID cannot be mistaken for an empty folder.
- **Idempotency Key on Email → Send.** Reuse the same value on a retry and the
  API returns the original result instead of delivering a second email — which
  is exactly the gap an n8n retry after a timeout falls into, with no way of
  knowing whether the first attempt landed. The key is yours; the node never
  invents one, since a generated key would differ on the retry and defeat the
  mechanism.

### Notes

- `preparation_status` on template responses needs no node change — responses
  pass through untouched — but it is now documented. An imported template
  renders asynchronously, so it can exist before it is sendable.
- The Idempotency Key field is shared with Schedule in the UI but applies only
  to Send. A scheduled transmission is created once and then cancelled or edited
  by ID, so there is nothing to replay.

## [0.6.0] - 2026-08-14

Covers the reworked bulk contact import (TPL-2105) and the duplicate-create fix.
Everything here is additive — existing workflows keep working untouched and send
the exact same payloads.

### Added
- **Per-contact bulk import.** *Audience Contact → Create Many* gains an **Input
  Mode** field. The new **Per-Contact Rows** mode takes a JSON array where each
  contact carries its own `properties`, `list_ids` and `topics`, as an
  alternative to the flat **Emails** list. **Email List** stays the default, so
  saved workflows send an unchanged request body.
- **Batch Options** on *Create Many*: **List IDs** (`list_ids`, max 50),
  **Topics** (`topics`, max 50) and **Update Existing** (`update_existing`).
  These apply to every contact in the batch; per-row values stack on top, except
  that a row-level topic `opt_out` beats a batch-level `opt_in`.
- **Bulk Subscribe to Topics** and **Bulk Unsubscribe From Topics** operations on
  *Audience Contact*, covering `POST` and `DELETE /audience/contacts/topics/bulk`
  over the cartesian product of contact IDs × topic IDs (max 1000 × 50).

### Changed
- The *Create Many* response now carries `updated`, `error_count`, `errors[]` and
  `contacts[]` alongside `created` and `already_existed`. The node passes the
  response through unchanged, so these appear automatically once the API returns
  them; the README explains how to read them.
- Creating a contact whose email already exists now fails with HTTP `409` and
  `error_code: resource_already_exists`, instead of the misleading HTTP `500`
  `send_error`. Node error messages surface the new code, and the node's
  *Continue On Fail* path reports it as the API sent it.

### Documentation
- README: new "Bulk contact import" section covering the two input modes, the
  `opt_out` precedence rule, and two response traps — a `201` does not mean every
  row landed (check `error_count` / `errors[]`), and `already_existed` and
  `updated` overlap by design so they do not sum to the row count.

## [0.5.0] - 2026-06-03

### Changed
- Node version is now reported to the API via a hardcoded build-time constant
  instead of reading `package.json` at runtime, so the compiled node no longer
  references `fs`/`path`/`__dirname` (required for n8n Cloud compatibility).

### Fixed
- ESLint no longer fails to parse the JS config files (`.eslintrc.js`,
  `gulpfile.js`, `index.js`); they are linted without the type-aware parser.

### CI
- Added `npx @n8n/node-cli lint` to the CI workflow so every pull request and
  push to `main` runs the n8n community node linter.

## [0.4.0] - 2026-05-30

### Added
- **Campaign** resource covering all `/campaigns` endpoints:
  - **Get Many** — list campaigns with an optional status filter and pagination
    (Return All / Limit / Simplify).
  - **Get** — retrieve a single campaign, including its rendered HTML content.
  - **Get Events** — list engagement events (open, click, bounce, etc.) with
    cursor-based pagination and optional event type, email, and date filters.
  - **Send** — dispatch a draft campaign immediately.
  - **Schedule** / **Unschedule** — schedule a campaign for future delivery or
    cancel a scheduled send.

## [0.3.0] - 2026-05-26

### Added
- **Audience API support** as five new resources, covering all audience
  endpoints except the public `audience/confirm/{token}` link:
  - **Audience Contact** — Get Many, Get, Create, Create Many, Update, Delete,
    Attach/Detach to List, Bulk Attach/Detach Lists, Subscribe/Unsubscribe to Topic
  - **Audience List** — Get Many, Get, Create, Update, Delete, Delete Many
  - **Audience Topic** — Get Many, Get, Create, Update, Delete
  - **Audience Property** — Get Many, Get, Create, Update, Delete
  - **Audience Segment** — Get Many, Get, Create, Update, Delete
- Contact properties entered via a name/value builder; double opt-in via a
  structured field set (creates contacts as `unverified` and sends a
  confirmation email).
- Segment conditions accepted as JSON (`groups → conditions → field/operator/value`),
  with validation on malformed input.
- Pagination controls (Return All, Limit, Page) and Simplify on audience list
  operations, consistent with the Template and Project resources.

## [0.2.0] - 2026-05-13

### Added
- Expanded operations across the Email, Domain, Template, Webhook, and Project
  resources.

## [0.1.3] - 2026-02-17

### Changed
- Maintenance and fixes.

## [0.1.1] - 2026-02-16

### Added
- Initial release: transactional email operations.
