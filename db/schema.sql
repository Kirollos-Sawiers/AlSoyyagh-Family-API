-- Al-Soyyagh family tree - database schema (PostgreSQL)
-- Safe to run many times: everything uses IF NOT EXISTS.

-- ───────────────────────── USERS ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT        NOT NULL,
  email                TEXT        NOT NULL,
  phone                TEXT        NOT NULL,
  relation             TEXT        NOT NULL,           -- "How are you related to the family"
  role                 TEXT        NOT NULL DEFAULT 'USER'
                         CHECK (role IN ('SUPER_ADMIN','ADMIN','CONTRIBUTOR','USER')),
  status               TEXT        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','DISABLED')),
  password_hash        TEXT        NOT NULL,
  must_change_password BOOLEAN     NOT NULL DEFAULT TRUE,
  avatar               BYTEA,
  avatar_mime          TEXT,
  approved_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email));

-- Which family trees a user may open (EGYPT / JORDAN). Admins & super admins see all trees automatically.
CREATE TABLE IF NOT EXISTS user_tree_access (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tree       TEXT NOT NULL CHECK (tree IN ('EGYPT','JORDAN')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tree)
);

-- ───────────────────────── JOIN REQUESTS ─────────────────────────
CREATE TABLE IF NOT EXISTS join_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT NOT NULL,
  relation        TEXT NOT NULL,
  image           BYTEA,
  image_mime      TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  created_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS join_requests_status_idx ON join_requests (status, created_at DESC);
-- only one PENDING request per e-mail
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_pending_email_uq
  ON join_requests (lower(email)) WHERE status = 'PENDING';

-- ───────────────────────── ACCESS TO THE OTHER COUNTRY ─────────────────────────
CREATE TABLE IF NOT EXISTS access_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tree        TEXT NOT NULL CHECK (tree IN ('EGYPT','JORDAN')),
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_uq
  ON access_requests (user_id, tree) WHERE status = 'PENDING';

-- ───────────────────────── FAMILY MEMBERS ─────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id                  SERIAL PRIMARY KEY,
  tree                TEXT    NOT NULL CHECK (tree IN ('EGYPT','JORDAN')),
  serial              TEXT    NOT NULL,        -- exactly as in the Excel sheet, e.g. 1-1-3-2
  serial_parts        INT[]   NOT NULL,        -- {1,1,3,2}  (used for correct ordering)
  depth               INT     NOT NULL DEFAULT 0,
  sort_index          INT     NOT NULL DEFAULT 0, -- order of appearance in the sheet
  parent_id           INT REFERENCES members(id) ON DELETE RESTRICT,
  name                TEXT    NOT NULL,
  nickname            TEXT,                    -- the name written in brackets in the sheet
  gender              TEXT    NOT NULL DEFAULT 'M' CHECK (gender IN ('M','F','U')),
  carries_family_name BOOLEAN NOT NULL DEFAULT TRUE,   -- carries the "ALSOYYAGH" family name
  date_of_birth       TEXT CHECK (date_of_birth ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  date_of_death       TEXT CHECK (date_of_death ~ '^\d{4}(-\d{2}(-\d{2})?)?$'),
  is_deceased         BOOLEAN NOT NULL DEFAULT FALSE,
  bio                 TEXT,                    -- description / brief about the person
  birth_place         TEXT,
  residence           TEXT,
  occupation          TEXT,
  photo_url           TEXT,
  notes               TEXT,                    -- free notes (e.g. "emigrated to Egypt")
  father_id           INT REFERENCES members(id) ON DELETE SET NULL,
  mother_id           INT REFERENCES members(id) ON DELETE SET NULL,
  father_name         TEXT,                    -- when the father is not a numbered member
  mother_name         TEXT,
  linked_member_id    INT REFERENCES members(id) ON DELETE SET NULL, -- same person in the other tree
  source_cell         TEXT,                    -- where it came from in the Excel sheet, e.g. Egypt!C2
  source_text         TEXT,                    -- the original text of the cell
  needs_review        TEXT[] NOT NULL DEFAULT '{}', -- problems found in the sheet during import
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS members_tree_serial_idx ON members (tree, serial);
CREATE INDEX IF NOT EXISTS members_parent_idx      ON members (parent_id, serial_parts);
CREATE INDEX IF NOT EXISTS members_name_idx        ON members (name);

-- A member can have several spouses. The spouse may also be a member (numbered) or just a name.
CREATE TABLE IF NOT EXISTS member_spouses (
  id               SERIAL PRIMARY KEY,
  member_id        INT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  spouse_member_id INT REFERENCES members(id) ON DELETE SET NULL,
  spouse_name      TEXT NOT NULL,
  spouse_nickname  TEXT,
  sort_order       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS member_spouses_member_idx ON member_spouses (member_id);
CREATE INDEX IF NOT EXISTS member_spouses_spouse_idx ON member_spouses (spouse_member_id);

-- ───────────────────────── EDIT / ADD REQUESTS (need admin approval) ─────────────────────────
CREATE TABLE IF NOT EXISTS change_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT NOT NULL CHECK (type IN ('EDIT_MEMBER','ADD_CHILD')),
  tree             TEXT NOT NULL CHECK (tree IN ('EGYPT','JORDAN')),
  member_id        INT  NOT NULL REFERENCES members(id) ON DELETE CASCADE, -- EDIT: the member / ADD_CHILD: the parent
  payload          JSONB NOT NULL,       -- the proposed data
  before_data      JSONB,                -- snapshot of the member when requested (to show a diff)
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by     UUID NOT NULL REFERENCES users(id),
  reviewed_by      UUID REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  review_note      TEXT,
  result_member_id INT REFERENCES members(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_requests_status_idx ON change_requests (status, created_at DESC);

-- ───────────────────────── AUDIT LOG ─────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);