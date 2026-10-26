# Al-Soyyagh Family Tree API

Backend REST API for the **Al-Soyyagh family tree** website. It stores and serves two
family trees (`EGYPT` and `JORDAN`), manages member records and relationships, and
provides a role-based approval workflow for joining the site and changing family data.

The project is a standalone API; the frontend is maintained separately.

- **Runtime:** Node.js 20+ (ES modules)
- **Framework:** Express 5
- **Database:** PostgreSQL (tested with Neon serverless Postgres)
- **Authentication:** JWT bearer tokens
- **Imported data:** 1,148 members (EGYPT: 974, JORDAN: 174) from `data/family.xlsx`

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Tech Stack](#tech-stack)
4. [Architecture](#architecture)
5. [Project Structure](#project-structure)
6. [Domain Model](#domain-model)
7. [Roles and Permissions](#roles-and-permissions)
8. [Access Control](#access-control)
9. [API Reference](#api-reference)
10. [Data Model](#data-model)
11. [Excel Import](#excel-import)
12. [Getting Started](#getting-started)
13. [Environment Variables](#environment-variables)
14. [Available Scripts](#available-scripts)
15. [Testing](#testing)
16. [Deployment](#deployment)
17. [Security Notes](#security-notes)
18. [Troubleshooting](#troubleshooting)
19. [License](#license)

---

## Overview

The API powers a private family-tree website with the following goals:

- Publish a large, hierarchical family tree that can be browsed, searched, and
  expanded branch by branch.
- Restrict who may view each country tree (`EGYPT`, `JORDAN`) and require approval
  before a user gets access to the other tree.
- Let family members request to join, then give administrators a controlled way to
  approve them, assign a role, and grant tree access.
- Let trusted contributors suggest edits and additions without giving them direct
  write access; administrators review and apply those changes.
- Preserve provenance of the original Excel data, including source cells and a list of
  items that need human review.
- Keep an audit trail of sensitive actions.

---

## Key Features

- **Two independent trees** (`EGYPT`, `JORDAN`) with configurable per-user access.
- **Hierarchical members** identified by serial numbers such as `1-6-1-6-1`, with
  parent/child links, depth, and deterministic ordering.
- **Spouse records**, including spouses who are also numbered family members.
- **Father/mother links** where known, plus free-text parent names when the parent is
  not a numbered member.
- **Cross-tree linking** of the same person appearing in both trees.
- **Tree browsing endpoints:** overview (roots + direct children), recursive branch,
  search, ancestors, children, member card, and full member details.
- **Approval workflows:**
  - Join requests (public submission, super-admin approval).
  - Access requests for the other country tree.
  - Change requests for member edits and new children (contributor submission,
    admin approval).
- **Role hierarchy** with guarded user management.
- **First-login password change** enforcement using temporary passwords.
- **Profile avatars** uploaded at join time and stored in the database.
- **Excel importer** that reads the source workbook without modifying it and produces a
  review report.
- **Security middleware:** Helmet, CORS allow-list, rate limiting, Zod validation,
  centralized error handling, magic-byte image validation.
- **Audit log** of authentication, user-management, access, and member changes.
- **Health endpoint** that also wakes a suspended cloud database.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js >= 20, native ES modules |
| HTTP framework | Express 5 |
| Database | PostgreSQL, `pg` connection pool |
| Authentication | `jsonwebtoken` (JWT), `bcryptjs` |
| Validation | `zod` |
| File uploads | `multer` (in-memory, max 2 MB) |
| Excel import | `exceljs` |
| Security | `helmet`, `cors`, `express-rate-limit` |
| Configuration | `dotenv` (plus native `--env-file`) |
| Testing | Node.js built-in test runner (`node:test`) |

No ORM is used. All database access is through parameterized SQL queries.

---

## Architecture

```
Client
  |
  |  HTTPS / JSON (+ multipart for join requests)
  v
Express app (src/app.js)
  |-- Helmet
  |-- CORS allow-list
  |-- JSON body parser (100 kB limit)
  |-- Global rate limiter (300 requests / minute / IP)
  |-- Routes (/api/...)
  |     |-- Validation (Zod schemas)
  |     |-- Authentication + authorization middleware
  |     |-- Controllers / route handlers
  |     |-- Business services (member read/write logic)
  |     `-- Audit logging
  `-- Central error handler
        |
        v
PostgreSQL (connection pool, max 8, transactions via tx())
```

Requests are handled with `async` route functions. Express 5 forwards rejected promises
to the error middleware automatically, so a global error handler produces a consistent
JSON error envelope.

---

## Project Structure

```
alsoyyagh-family-api/
├── data/
│   ├── family.xlsx              # Source workbook (read-only during import)
│   └── import-report.json       # Latest import statistics and warnings
├── db/
│   └── schema.sql               # Idempotent PostgreSQL schema
├── scripts/
│   ├── migrate.js               # Applies db/schema.sql
│   ├── import-excel.js          # Imports family.xlsx
│   └── seed-superadmin.js       # Creates the first super admin
├── src/
│   ├── app.js                   # Express app, middleware, route mounting
│   ├── server.js                # HTTP server and graceful shutdown
│   ├── config/
│   │   ├── db.js                # pg Pool, query helper, transaction helper
│   │   └── env.js               # Environment parsing and validation
│   ├── middleware/
│   │   ├── auth.js              # JWT auth, role checks, tree access checks
│   │   └── error.js             # 404 and centralized error handling
│   ├── routes/
│   │   ├── auth/
│   │   ├── joinRequests/
│   │   ├── users/
│   │   ├── accessRequests/
│   │   ├── changeRequests/
│   │   ├── trees/
│   │   ├── members/
│   │   └── admin/
│   ├── services/
│   │   └── members.js           # Member read/write domain logic
│   └── utils/
│       ├── audit.js             # Audit-log writer
│       ├── constants.js         # Roles, role ranks, tree codes
│       ├── errors.js            # HttpError helpers
│       ├── parseSheet.js        # Excel cell and hierarchy parser
│       ├── password.js          # Hashing and temporary passwords
│       ├── schemas.js           # Zod request schemas
│       └── upload.js            # Image upload and MIME detection
├── test/
│   └── api.test.js              # Smoke test (health endpoint)
├── .env.example
├── package.json
└── README.md
```

---

## Domain Model

### Trees

There are exactly two trees:

| Code | Description |
| --- | --- |
| `EGYPT` | Egyptian branch. Root is the grandfather with serial `0` and eight numbered children. |
| `JORDAN` | Jordanian branch. Has multiple root ancestors (serials `1` and `2` in the source sheet). |

A user with `ADMIN` or `SUPER_ADMIN` role can access both trees automatically. Other
users need an explicit `user_tree_access` grant.

### Members

A member belongs to one tree and is identified by:

- **`serial`** — human-readable hierarchy path, e.g. `1-1-3-2` (stored exactly as in the
  source data; the root of the Egypt tree uses `0`).
- **`serial_parts`** — integer array `{1,1,3,2}` used for correct numeric ordering.
- **`depth`** — number of ancestors above the member.
- **`parent_id`** — structural tree parent (the branch a person is displayed under).
- **`father_id` / `mother_id`** — actual parents when known.
- **`father_name` / `mother_name`** — names when the parent is not a numbered member.
- **`linked_member_id`** — the same person in the other tree, when linked.

Members also store optional biographical data, gender, dates, places, occupation,
photo URL, notes, source provenance, and a `needs_review` list produced by the importer.

### Spouses

`member_spouses` supports multiple spouses per member. A spouse may be:

- another numbered member (`spouse_member_id` set), or
- only a name (`spouse_name`), optionally with a nickname.

### Family-name flag

`carries_family_name` indicates whether a person carries the `ALSOYYAGH` family name.
During import it is computed by following the ancestor chain: a person carries the name
when the whole chain is male; a woman is born with it, but her children do not inherit
it through her.

---

## Roles and Permissions

Roles are ordered: `USER` < `CONTRIBUTOR` < `ADMIN` < `SUPER_ADMIN`.

| Capability | USER | CONTRIBUTOR | ADMIN | SUPER_ADMIN |
| --- | :---: | :---: | :---: | :---: |
| Log in, change own password | Yes | Yes | Yes | Yes |
| View granted trees, search, browse members | Yes | Yes | Yes | Yes |
| Access both trees automatically | No | No | Yes | Yes |
| Request access to the other tree | Yes | Yes | - | - |
| Submit member edit / add-child request | No | Yes | - | - |
| View own change requests | - | Yes | Yes | Yes |
| View all change requests | No | No | Yes | Yes |
| Approve / reject change requests | No | No | Yes | Yes |
| View join requests | No | No | Yes | Yes |
| Approve / reject join requests | No | No | No | Yes |
| View all access requests | No | No | Yes | Yes |
| Approve / reject access requests | No | No | Yes | Yes |
| List users | No | No | Yes | Yes |
| Change user role / status | No | No | Limited | Yes |
| Grant / replace tree access | No | No | Yes | Yes |
| Reset another user's password | No | No | No | Yes |
| View admin dashboard summary | No | No | Yes | Yes |

**User-management safeguards**

- Nobody can change their own role or status.
- An `ADMIN` may manage only `CONTRIBUTOR` and `USER` accounts, and cannot promote
  anyone to `ADMIN` or `SUPER_ADMIN`.
- The last active `SUPER_ADMIN` cannot be demoted.
- Join-request approval can assign only `ADMIN`, `CONTRIBUTOR`, or `USER` (never
  `SUPER_ADMIN`).

**First-login enforcement**

Users created by join-request approval or by super-admin seeding receive a temporary
password and `must_change_password = true`. All protected routes reject such users with
HTTP `403` and code `PASSWORD_CHANGE_REQUIRED` until they call the change-password
endpoint.

---

## Access Control

Authentication uses `Authorization: Bearer <JWT>`. Tokens are signed with `JWT_SECRET`
and expire after `JWT_EXPIRES_IN` (default `12h`). On every request the user is reloaded
from the database, so role changes, disabling, and password-change flags take effect
immediately.

Tree access is evaluated as follows:

1. `ADMIN` and `SUPER_ADMIN` can access every tree.
2. Other roles can access a tree only if a matching row exists in `user_tree_access`.
3. Tree-specific member routes verify the target member belongs to a tree the user may
   access.

Access to the other tree is requested through `POST /api/access-requests` and granted by
an admin.

---

## API Reference

### Base URL

```
http://localhost:4000
```

All endpoints are under `/api`. Requests and responses use JSON, except join-request
submission, which uses `multipart/form-data`.

### Authentication header

```
Authorization: Bearer <token>
```

### Response conventions

- IDs: UUID for users and requests; integer for members and spouses.
- Timestamps: ISO 8601 strings from PostgreSQL (`TIMESTAMPTZ`).
- Field names in JSON are `camelCase`; database columns are `snake_case`.
- Pagination is not implemented; list endpoints return up to 200 rows.

### Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid.",
    "details": [
      { "field": "email", "message": "Invalid email" }
    ]
  }
}
```

Common error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Invalid input or operation |
| `BAD_JSON` | 400 | Malformed JSON body |
| `VALIDATION_ERROR` | 400 | Zod validation failed |
| `UPLOAD_ERROR` | 400 | Upload too large or invalid |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token |
| `INVALID_CREDENTIALS` | 401 | Wrong e-mail or password |
| `FORBIDDEN` | 403 | Insufficient role |
| `PASSWORD_CHANGE_REQUIRED` | 403 | First-login password change pending |
| `TREE_ACCESS_REQUIRED` | 403 | No access to this tree |
| `NOT_FOUND` | 404 | Route or resource not found |
| `CONFLICT` | 409 | Duplicate or already-reviewed request |
| `TOO_MANY_ATTEMPTS` | 429 | Login rate limit hit |
| `TOO_MANY_REQUESTS` | 429 | Join-request rate limit hit |
| `SERVER_ERROR` | 500 | Unhandled server error |

### Status codes used

| Status | Use |
| --- | --- |
| `200` | Successful read or immediate update |
| `201` | Resource created (join request, access request, child member) |
| `202` | Change accepted for approval (contributor edit/add) |
| `400` | Validation or business rule failure |
| `401` | Not authenticated |
| `403` | Not authorized / password change required |
| `404` | Resource not found |
| `409` | Conflict |
| `429` | Rate limited |
| `500` | Server error |

### Rate limits

| Scope | Limit |
| --- | --- |
| All routes | 300 requests per minute per IP |
| `POST /api/auth/login` | 20 failed attempts per 15 minutes (successful logins do not count) |
| `POST /api/join-requests` | 10 requests per hour per IP |

### Health and root

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | Public | Basic API identity and status |
| `GET` | `/api/health` | Public | Runs `SELECT 1`, returns `{ ok, time }`; also wakes a suspended database |

### Authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | Public | Log in with e-mail and password |
| `GET` | `/api/auth/me` | Bearer | Current user and accessible trees |
| `POST` | `/api/auth/change-password` | Bearer | Change password (required on first login) |

**Login**

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "Secret123"
}
```

Response:

```json
{
  "token": "<jwt>",
  "mustChangePassword": false,
  "user": {
    "id": "uuid",
    "name": "Name",
    "email": "user@example.com",
    "phone": "+20...",
    "relation": "...",
    "role": "USER",
    "mustChangePassword": false
  }
}
```

**Current user**

```json
{
  "user": { "...": "..." },
  "trees": ["EGYPT"]
}
```

**Change password**

```json
{
  "oldPassword": "Temp-1234-Abc",
  "newPassword": "NewSecret123"
}
```

Password rule: 8–100 characters, must contain at least one letter and one digit, and the
new password must differ from the old one. Returns a fresh token with
`mustChangePassword: false`.

### Join requests

A public visitor asks to join the site. Submission is rate-limited and accepts an
optional JPG/PNG/WEBP image (max 2 MB) as `multipart/form-data` field `image`.

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| `POST` | `/api/join-requests` | Public | - | Submit a join request |
| `GET` | `/api/join-requests?status=` | Bearer | ADMIN+ | List requests (optional `PENDING`, `APPROVED`, `REJECTED`; max 200) |
| `GET` | `/api/join-requests/:id/image` | Bearer | ADMIN+ | Fetch the submitted image |
| `POST` | `/api/join-requests/:id/approve` | Bearer | SUPER_ADMIN | Create the user account and grant tree access |
| `POST` | `/api/join-requests/:id/reject` | Bearer | SUPER_ADMIN | Reject with an optional reason |

**Submit**

Fields: `name`, `phone`, `email`, `relation`, optional `image`.

A user with the same e-mail cannot already exist, and only one `PENDING` request per
e-mail is allowed.

**Approve**

```json
{
  "role": "CONTRIBUTOR",
  "trees": ["EGYPT"],
  "password": "OptionalTemp123"
}
```

`role` must be `ADMIN`, `CONTRIBUTOR`, or `USER`. `trees` must contain one or two tree
codes. If `password` is omitted, the server generates a readable temporary password.
The response shows the temporary password **once**:

```json
{
  "ok": true,
  "user": { "id": "uuid", "name": "Name", "email": "...", "role": "CONTRIBUTOR" },
  "temporaryPassword": "Olive-4821-Nile",
  "trees": ["EGYPT"]
}
```

The submitted avatar is copied to the new user account. The new user must change the
temporary password at first login.

**Reject**

```json
{ "reason": "Not a family member" }
```

### Users

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| `GET` | `/api/users` | Bearer | ADMIN+ | List all users with tree grants |
| `GET` | `/api/users/:id/avatar` | Bearer | Self or ADMIN+ | Fetch a user avatar |
| `PATCH` | `/api/users/:id` | Bearer | ADMIN+ | Change role and/or status |
| `PUT` | `/api/users/:id/trees` | Bearer | ADMIN+ | Replace tree grants |
| `POST` | `/api/users/:id/reset-password` | Bearer | SUPER_ADMIN | Set or generate a temporary password |

**Update role/status**

```json
{ "role": "CONTRIBUTOR", "status": "ACTIVE" }
```

At least one of `role` or `status` is required. `status` is `ACTIVE` or `DISABLED`.

**Replace tree grants**

```json
{ "trees": ["EGYPT", "JORDAN"] }
```

This deletes all existing grants and inserts the supplied ones (an empty array removes
all grants).

**Reset password**

```json
{ "password": "OptionalTemp123" }
```

If omitted, a temporary password is generated and returned. The target user must change
it at next login.

### Access requests

Requests to open the other country tree. Requires a logged-in user whose password change
is complete.

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| `POST` | `/api/access-requests` | Bearer | Any | Request access to a tree |
| `GET` | `/api/access-requests/mine` | Bearer | Any | Own request history |
| `GET` | `/api/access-requests?status=` | Bearer | ADMIN+ | List all requests |
| `POST` | `/api/access-requests/:id/approve` | Bearer | ADMIN+ | Approve and grant access |
| `POST` | `/api/access-requests/:id/reject` | Bearer | ADMIN+ | Reject |

**Create**

```json
{ "tree": "JORDAN" }
```

Only one `PENDING` request per user/tree is allowed. Requesting a tree you already have
access to returns `409`.

Approval inserts a `user_tree_access` row (idempotent) inside a transaction.

### Change requests

Contributors propose member edits or new children; admins review and apply them.

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| `GET` | `/api/change-requests?status=&mine=` | Bearer | CONTRIBUTOR+ | List requests |
| `GET` | `/api/change-requests/:id` | Bearer | CONTRIBUTOR+ | Get one request |
| `POST` | `/api/change-requests/:id/approve` | Bearer | ADMIN+ | Apply the change |
| `POST` | `/api/change-requests/:id/reject` | Bearer | ADMIN+ | Reject with optional note |

- Contributors see and open only their own requests.
- Admins see all requests; `mine=true` restricts an admin to their own.
- Optional `status` filter: `PENDING`, `APPROVED`, `REJECTED`.
- Request types: `EDIT_MEMBER`, `ADD_CHILD`.
- Editing stores a snapshot (`before_data`) for diff display.
- Approval applies the change and records `result_member_id`.
- Review bodies accept an optional `note` (max 500 characters).

**Request shape**

```json
{
  "id": "uuid",
  "type": "EDIT_MEMBER",
  "tree": "EGYPT",
  "memberId": 123,
  "memberName": "Name",
  "memberSerial": "1-2-3",
  "payload": { "...": "..." },
  "before": { "...": "..." },
  "status": "PENDING",
  "requestedBy": { "id": "uuid", "name": "Contributor" },
  "reviewedBy": null,
  "reviewedAt": null,
  "reviewNote": null,
  "resultMemberId": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

**Approve / reject**

```json
{ "note": "Verified with the family" }
```

### Trees

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/trees` | Bearer | List trees with member counts, access, and pending request state |
| `GET` | `/api/trees/:tree/overview` | Bearer | Roots plus their direct children and descendant counts |
| `GET` | `/api/trees/:tree/branch/:memberId?depth=` | Bearer | Recursive branch below a member |
| `GET` | `/api/trees/:tree/search?q=` | Bearer | Search member names/nicknames in one tree |

`:tree` must be `EGYPT` or `JORDAN` (case-insensitive). All tree routes require access
to that tree.

**Tree list response**

```json
{
  "items": [
    {
      "tree": "EGYPT",
      "memberCount": 974,
      "hasAccess": true,
      "accessRequestPending": false
    }
  ]
}
```

**Overview**

Returns each root with its summary, spouse names, and direct children. Each child
includes its spouse names and total `descendantsCount` (computed recursively).

**Branch**

- `depth` defaults to `50`, minimum `1`, maximum `50`.
- Returns a nested `branch` object: the member plus a `children` array, each node with
  `childrenCount`, spouse names, and summary fields.

**Search**

- `q` must be at least 2 characters.
- Matches `name` or `nickname` case-insensitively with `ILIKE`.
- `%`, `_`, and `\` are escaped in the query.
- Maximum 30 results, ordered by depth and serial.

### Members

All member routes require login, a completed password change, and access to the member's
tree.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/members/:id` | Bearer | Short card: summary, spouses, children count |
| `GET` | `/api/members/:id/details` | Bearer | Full details: bio, parents, siblings, children, spouses, links |
| `GET` | `/api/members/:id/children` | Bearer | Direct children |
| `GET` | `/api/members/:id/ancestors` | Bearer | Path from top ancestor down to this member |
| `PATCH` | `/api/members/:id` | Bearer, CONTRIBUTOR+ | Edit member |
| `POST` | `/api/members/:id/children` | Bearer, CONTRIBUTOR+ | Add a child |

**Write behavior**

| Actor | `PATCH` member | `POST` child |
| --- | --- | --- |
| `ADMIN` / `SUPER_ADMIN` | Applied immediately, `200` | Created immediately, `201` |
| `CONTRIBUTOR` | Stored as `EDIT_MEMBER` change request, `202` | Stored as `ADD_CHILD` change request, `202` |

**Editable member fields**

`name`, `nickname`, `gender` (`M`, `F`, `U`), `carriesFamilyName`, `dateOfBirth`,
`dateOfDeath`, `isDeceased`, `bio`, `birthPlace`, `residence`, `occupation`, `photoUrl`,
`notes`, `spouses`.

Dates accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` (or empty/null). `photoUrl` must be a
valid URL. `spouses` is an array (max 10) of:

```json
{ "name": "Spouse", "nickname": "Alias", "memberId": 456 }
```

If `memberId` is supplied, that member must exist; otherwise a name is required.

**Add-child payload**

Same fields as edit, plus required `name` and optional `otherParentSpouseId`. The server:

- generates the next serial under the parent (e.g. `1-2-3` → `1-2-4`),
- sets depth and sort index,
- determines father/mother from the parent's gender and spouse information,
- inherits `carriesFamilyName` according to the parent/gender rule,
- sets `isDeceased` when a death date is provided.

**Details response (selected fields)**

Includes summary fields plus `bio`, `birthPlace`, `residence`, `occupation`, `notes`,
`father`, `mother`, `parent`, `spouses`, `children`, `siblings`, `linkedMember`,
`needsReview`, `sourceCell`, `createdAt`, and `updatedAt`.

### Admin

| Method | Path | Auth | Role | Description |
| --- | --- | --- | --- | --- |
| `GET` | `/api/admin/summary` | Bearer | ADMIN+ | Pending counts, user count, and members per tree |

Response:

```json
{
  "pendingJoinRequests": 0,
  "pendingChangeRequests": 0,
  "pendingAccessRequests": 0,
  "users": 12,
  "members": { "EGYPT": 974, "JORDAN": 174 }
}
```

### Quick examples

```bash
# Health
curl http://localhost:4000/api/health

# Login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"Secret123"}'

# Authenticated request
curl http://localhost:4000/api/trees \
  -H "Authorization: Bearer <token>"

# Public join request with an image
curl -X POST http://localhost:4000/api/join-requests \
  -F "name=Full Name" \
  -F "phone=+201234567890" \
  -F "email=person@example.com" \
  -F "relation=Grandson of ..." \
  -F "image=@photo.jpg"
```

---

## Data Model

The schema lives in `db/schema.sql` and is safe to run repeatedly (`IF NOT EXISTS`).
There is no migration-version framework; apply the full schema with `npm run db:migrate`.

### `users`

User accounts and roles.

Key columns: `id` (UUID), `name`, `email` (unique, case-insensitive index), `phone`,
`relation`, `role`, `status`, `password_hash`, `must_change_password`, `avatar` (BYTEA),
`avatar_mime`, `approved_by`, `last_login_at`, timestamps.

Role values: `SUPER_ADMIN`, `ADMIN`, `CONTRIBUTOR`, `USER`.
Status values: `ACTIVE`, `DISABLED`.

### `user_tree_access`

Which trees a non-admin user may open.

Key columns: `user_id`, `tree` (`EGYPT`/`JORDAN`), `granted_by`, `granted_at`.
Primary key: `(user_id, tree)`.

### `join_requests`

Public requests to join the site.

Key columns: `id`, `name`, `phone`, `email`, `relation`, `image` (BYTEA),
`image_mime`, `status`, `reviewed_by`, `reviewed_at`, `reject_reason`,
`created_user_id`, `created_at`.

A partial unique index allows only one `PENDING` request per lower-cased e-mail.

### `access_requests`

Requests for access to the other tree.

Key columns: `id`, `user_id`, `tree`, `status`, `reviewed_by`, `reviewed_at`,
`created_at`. A partial unique index allows one `PENDING` request per user/tree.

### `members`

Family members.

Key columns: `id` (serial integer), `tree`, `serial`, `serial_parts`, `depth`,
`sort_index`, `parent_id`, `name`, `nickname`, `gender`, `carries_family_name`,
`date_of_birth`, `date_of_death`, `is_deceased`, `bio`, `birth_place`, `residence`,
`occupation`, `photo_url`, `notes`, `father_id`, `mother_id`, `father_name`,
`mother_name`, `linked_member_id`, `source_cell`, `source_text`, `needs_review`,
`created_by`, `updated_by`, timestamps.

Indexes support lookup by tree/serial, parent/serial parts, and name.

### `member_spouses`

Multiple spouses per member.

Key columns: `id`, `member_id`, `spouse_member_id` (nullable), `spouse_name`,
`spouse_nickname`, `sort_order`.

### `change_requests`

Pending edits and additions.

Key columns: `id`, `type` (`EDIT_MEMBER`/`ADD_CHILD`), `tree`, `member_id`, `payload`
(JSONB), `before_data` (JSONB), `status`, `requested_by`, `reviewed_by`, `reviewed_at`,
`review_note`, `result_member_id`, `created_at`.

### `audit_log`

Append-only record of sensitive actions.

Key columns: `id`, `user_id`, `action`, `entity`, `entity_id`, `details` (JSONB),
`created_at`.

Recorded actions include: `PASSWORD_CHANGED`, `JOIN_APPROVED`, `JOIN_REJECTED`,
`USER_UPDATED`, `USER_TREES_SET`, `PASSWORD_RESET`, `ACCESS_APPROVED`,
`ACCESS_REJECTED`, `CHANGE_APPROVED`, `CHANGE_REJECTED`, `MEMBER_EDITED`,
`MEMBER_ADDED`.

Audit writes never break the main request; failures are logged to the console.

### Entity relationships

```
users 1---* user_tree_access
users 1---* join_requests (approver / created user)
users 1---* access_requests
users 1---* change_requests (requester / reviewer)
users 1---* members (creator / updater)
users 1---* audit_log

members 1---* members (parent_id)
members 1---* member_spouses
members *---1 members (father_id, mother_id, linked_member_id)
members 1---* change_requests
```

---

## Excel Import

The source workbook `data/family.xlsx` is the canonical seed for the trees. The importer
**only reads** it and never modifies it.

### Worksheets

| Worksheet | Tree | Notes |
| --- | --- | --- |
| `Egypt` | `EGYPT` | Cell `B2` is the head of the tree and has no serial in the sheet; it is stored as serial `0`. |
| `Jordan` | `JORDAN` | Serial-based roots (e.g. `1`, `2`). |

### Cell grammar

Each non-empty, non-merged cell is treated as one person:

```
Name (optional-nickname SERIAL) [*] [+ Spouse Name (SERIAL) [*]] [+ another spouse ...]
```

- `SERIAL` looks like `1-1-3-2` and describes hierarchy position.
- `*` marks a female.
- Text after `+` describes a spouse; a spouse may also carry a serial if they are a
  numbered member.
- A nickname is text inside the first `(...)` that is not the serial.
- Merged cells are read only from their master (top-left) cell.
- Arabic tatweel and diacritics are removed; whitespace is normalized.
- A missing opening bracket before a serial (e.g. `Name 5-2-1-4 )`) is tolerated and
  flagged.

### Hierarchy resolution

- A person's parent is derived from the serial with the last segment removed
  (`1-1-3` → `1-1`).
- If an intermediate parent is missing, the importer attaches the person to the nearest
  existing ancestor and flags `PARENT_MISSING_IN_SHEET`.
- If two different people share a serial, both are kept (the second receives an internal
  `#2` key) and both are flagged `DUPLICATE_SERIAL`.
- The `carries_family_name` flag is computed from the ancestor chain as described above.
- Spouses that reference a serial are resolved to the corresponding member and
  back-linked.
- `Jordan` serial `1-1` is linked to the `Egypt` head when its note mentions Egypt.

### Report

Every run writes `data/import-report.json`, containing per-tree statistics and warnings.

Current data snapshot:

| Tree | Members | Female | Carrying family name | Max depth | Root people | Flagged for review |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| `EGYPT` | 974 | 469 | 434 | 8 | `0 Faraj Mikhail Hanna` | 11 |
| `JORDAN` | 174 | 73 | 107 | 6 | `1 ...`, `2 ...` | 1 |
| **Total** | **1,148** | **542** | **541** | - | - | **12** |

The latest report lists 8 warnings (missing serials, duplicate serials with different
names, a tolerated typo, and a missing intermediate parent). Review these in the source
data or via the `needs_review` field on affected members.

### Import commands

```bash
# Read-only analysis: parses the workbook and writes the report, no database writes
npm run db:import:dry

# Import into an empty members table
npm run db:import

# Wipe members and import again (destructive)
node scripts/import-excel.js --reset

# Import a different workbook
node scripts/import-excel.js path/to/other.xlsx
```

The real import refuses to run if `members` already contains rows, unless `--reset` is
supplied. The import runs inside a single transaction; on failure nothing is saved.

---

## Getting Started

### Prerequisites

- Node.js 20 or newer
- A PostgreSQL database (local or cloud, e.g. Neon)
- npm

### 1. Install dependencies

```bash
npm install
```

### 2. Create the environment file

```bash
cp .env.example .env
```

Then edit `.env`:

- Set a valid `DATABASE_URL` and `DATABASE_SSL=true` for cloud Postgres.
- Set a strong `JWT_SECRET` of at least 32 characters.
- Set `CORS_ORIGINS` to your frontend origin(s), comma-separated.
- Set the `SUPERADMIN_*` values used by the seed script.

See [Environment Variables](#environment-variables) for the full list.

> The committed `.env.example` may contain sample credentials. Treat any values in it as
> placeholders and never commit a real `.env`.

### 3. Create the database schema

```bash
npm run db:migrate
```

### 4. Import the family data

```bash
npm run db:import:dry   # inspect first
npm run db:import       # then import
```

### 5. Create the first super admin

```bash
npm run seed:admin
```

The super admin is created only if no `SUPER_ADMIN` exists. The account starts with
`must_change_password = true`.

### 6. Run the server

```bash
# Development: restarts on file changes, loads .env
npm run dev

# Production
npm start
```

The API listens on `PORT` (default `4000`). Verify:

```bash
curl http://localhost:4000/api/health
```

### First-run sequence

1. Seed a super admin.
2. Start the API.
3. Log in and change the temporary password.
4. Optionally import the Excel data.
5. Approve join requests to create the remaining accounts.

---

## Environment Variables

The application reads configuration in `src/config/env.js`. Required variables cause the
process to exit when missing.

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `JWT_SECRET` | Yes | - | Signing secret, minimum 32 characters |
| `NODE_ENV` | No | `development` | Set to `production` in production |
| `PORT` | No | `4000` | HTTP listening port |
| `DATABASE_SSL` | No | `false` | Set to `true` to enable TLS to the database |
| `JWT_EXPIRES_IN` | No | `12h` | Token lifetime (accepted by `jsonwebtoken`) |
| `CORS_ORIGINS` | No | empty (blocks browser origins) | Comma-separated allowed origins, e.g. `https://app.example.com` |
| `SUPERADMIN_NAME` | No | `Super Admin` | Seed script only |
| `SUPERADMIN_EMAIL` | Yes* | - | Seed script only |
| `SUPERADMIN_PHONE` | No | `-` | Seed script only |
| `SUPERADMIN_PASSWORD` | Yes* | - | Seed script only |

\* Required only when running `npm run seed:admin`.

Notes:

- `CORS_ORIGINS` is the name read by the code. Some example files use the singular
  `CORS_ORIGIN`; rename it to `CORS_ORIGINS` if CORS does not behave as expected.
- Requests without an `Origin` header (curl, Postman, server-to-server) are always
  allowed; only browser origins are checked against the allow-list.
- The following variables appear in `.env.example` but are **not currently read** by the
  application; they are reserved for future use:
  `HOST`, `REFRESH_TOKEN_SECRET`, `REFRESH_TOKEN_EXPIRES_IN`, `MAX_UPLOAD_MB`,
  `UPLOAD_DIR`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`.
- Image uploads are capped at 2 MB in code, not by `MAX_UPLOAD_MB`. JSON bodies are capped
  at 100 kB. Rate limits are fixed in code and not read from the environment.

---

## Available Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the API with `node src/server.js` |
| `npm run dev` | Start with `node --watch` and load `.env` |
| `npm run db:migrate` | Apply `db/schema.sql` (idempotent) |
| `npm run db:import` | Import `data/family.xlsx` into an empty database |
| `npm run db:import:dry` | Parse the workbook and write the report without touching the DB |
| `npm run seed:admin` | Create the first super admin if none exists |
| `npm test` | Run the test suite with the built-in Node test runner |

`npm run dev` and `npm test` use Node's native `--env-file=.env`. `npm start` relies on
`dotenv/config` inside `src/config/env.js`.

---

## Testing

The test suite currently contains a smoke test that:

- creates an HTTP server on an ephemeral port,
- calls `GET /api/health`,
- asserts HTTP `200` and `{ ok: true }`.

```bash
npm test
```

`test/api.test.js` imports the real database configuration, so a reachable database is
required. The suite uses `--env-file=.env`. There is no separate test database or mocked
database layer.

Manual verification of authenticated flows requires a seeded super admin or an approved
user account.

---

## Deployment

The API is designed to run as a standard Node.js service (for example on Render) with a
managed PostgreSQL database such as Neon.

Checklist:

1. Set all required environment variables in the hosting provider.
2. Set `NODE_ENV=production`, `DATABASE_SSL=true` for cloud Postgres, and a strong
   `JWT_SECRET`.
3. Set `CORS_ORIGINS` to the deployed frontend origin(s).
4. Run `npm run db:migrate` against the production database.
5. Run `npm run seed:admin` once.
6. Start with `npm start`.
7. Verify `/api/health`.

Operational notes:

- The app enables `trust proxy`, so the real client IP is used for rate limiting behind a
  reverse proxy.
- Graceful shutdown closes the HTTP server and the database pool on `SIGTERM`/`SIGINT`.
- The health endpoint performs a query and can wake a suspended serverless database; the
  pool uses a 15-second connection timeout for this reason.
- The database pool is capped at 8 connections, suitable for small serverless plans.

---

## Security Notes

- Passwords are hashed with bcrypt (cost 12).
- Login uses a dummy hash for unknown e-mails so response timing does not reveal whether
  an account exists.
- Login, join-request, and global rate limits protect against brute force and abuse.
- JWTs are short-lived (default 12 hours). There is no refresh-token endpoint; the
  refresh-token variables in `.env.example` are reserved and unused.
- Users are reloaded from the database on each request, so disabling an account or
  changing a role takes effect immediately.
- Uploaded images are validated by magic bytes (JPG, PNG, WEBP), not by file extension.
- All SQL uses parameterized queries.
- Request bodies are validated and strict in most schemas; unknown fields are rejected
  where `.strict()` is used.
- Audit logging records sensitive administrative actions.
- Never commit `.env` or real credentials. `.env` is ignored by git; `.env.example` should
  contain placeholders only.
- The API stores family personal data (names, phone numbers, e-mail addresses, photos,
  relationships). Apply appropriate access control, database encryption, backups, and
  data-retention policies.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Process exits with `Missing environment variable: DATABASE_URL` | `.env` missing or not loaded | Create `.env`; use `npm run dev` or ensure `dotenv` can find it |
| `JWT_SECRET must be at least 32 characters long` | Secret too short | Generate a longer secret |
| `password authentication failed` | Wrong database credentials | Check `DATABASE_URL` |
| TLS/SSL error connecting to Neon | SSL setting mismatch | Set `DATABASE_SSL=true` |
| CORS errors in the browser | Origin not allow-listed | Add it to `CORS_ORIGINS` (plural), no trailing slash |
| `PASSWORD_CHANGE_REQUIRED` on every route | First-login password not changed | Call `POST /api/auth/change-password` |
| `TREE_ACCESS_REQUIRED` | User lacks a grant for that tree | Request access or have an admin grant it |
| Import says the database already has members | Non-empty `members` table | Use `node scripts/import-excel.js --reset` |
| Import fails with worksheet not found | Workbook lacks `Egypt`/`Jordan` sheets | Rename sheets or adapt `SHEETS` in the import script |
| Login returns `429` | Too many failed attempts | Wait 15 minutes |
| Join request returns `429` | More than 10 submissions per hour from the IP | Wait or submit from another network |
| `npm test` fails to connect | No reachable database or missing `.env` | Start the database and configure `.env` |

---

## License

`UNLICENSED` — private project. All rights reserved.
