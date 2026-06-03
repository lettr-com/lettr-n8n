# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
