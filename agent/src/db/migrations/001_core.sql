-- NEARAuth agent — core schema (v1)
-- Every user-owned table carries user_id and is protected by row-level security keyed on the per-transaction
-- setting app.user_id. FORCE ROW LEVEL SECURITY makes the policies apply to the table owner too.
-- No table stores passwords, master passwords, vault keys, provider API keys or message bodies.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agent_users (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{2,64}$'),
  display_name  text NOT NULL,
  agent_enabled boolean NOT NULL DEFAULT true,          -- kill switch for agentic functionality
  memory_opt_out boolean NOT NULL DEFAULT false,        -- learned-memory opt-out
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
  token_hash    text PRIMARY KEY,                       -- SHA-256 of the bearer token; the token itself is never stored
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX agent_sessions_user ON agent_sessions(user_id);

-- Aliases the user owns. Exact relational lookup only; never resolved by similarity.
CREATE TABLE user_aliases (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  alias_email   text NOT NULL,
  service_name  text NOT NULL,
  service_domain text NOT NULL,
  provider_id   text NOT NULL CHECK (provider_id IN ('mock', 'simplelogin', 'addy', 'demo')),
  remote_id     text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz,
  credential_status text NOT NULL DEFAULT 'unknown' CHECK (credential_status IN ('unknown', 'none', 'generated-not-stored', 'vault-encrypted')),
  UNIQUE (user_id, alias_email)
);
CREATE INDEX user_aliases_user ON user_aliases(user_id);

CREATE TABLE sender_observations (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  alias_id      text NOT NULL REFERENCES user_aliases(id) ON DELETE CASCADE,
  sender_address text NOT NULL,
  sender_domain text NOT NULL,
  sender_display_name text,                             -- untrusted text: displayed escaped, never used as instructions
  remote_contact_id text,
  blocked       boolean NOT NULL DEFAULT false,
  classification text,
  confidence    text,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_id, sender_address)
);
CREATE INDEX sender_observations_user ON sender_observations(user_id, alias_id);

CREATE TABLE privacy_workflows (
  thread_id     text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  request_text  text NOT NULL,
  intent        text,
  status        text NOT NULL CHECK (status IN ('planned', 'awaiting_approval', 'running', 'requested', 'verified', 'failed', 'unsupported', 'denied', 'declined', 'expired', 'completed', 'needs_target', 'cancelled')),
  mode          text NOT NULL CHECK (mode IN ('simulation', 'real')),
  path          jsonb NOT NULL DEFAULT '[]',            -- executed nodes, for the visualisation
  summary       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_workflows_user ON privacy_workflows(user_id, created_at DESC);

CREATE TABLE action_proposals (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  thread_id     text NOT NULL REFERENCES privacy_workflows(thread_id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('block_sender', 'unblock_sender', 'pause_alias', 'resume_alias', 'unsubscribe', 'credential_rotation')),
  alias_id      text REFERENCES user_aliases(id) ON DELETE CASCADE,
  sender_id     text REFERENCES sender_observations(id) ON DELETE CASCADE,
  provider_id   text NOT NULL,
  risk_tier     text NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high')),
  reversible    boolean NOT NULL,
  action_hash   text NOT NULL,                          -- SHA-256 of the canonical action description
  explanation   jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_proposals_thread ON action_proposals(user_id, thread_id);

CREATE TABLE action_approvals (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  thread_id     text NOT NULL REFERENCES privacy_workflows(thread_id) ON DELETE CASCADE,
  proposal_id   text NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  action_hash   text NOT NULL,
  mac           text NOT NULL,                          -- HMAC-SHA-256 binding id, user, thread, action hash, expiry
  status        text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'consumed')),
  decided_by_session text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  decided_at    timestamptz,
  consumed_at   timestamptz
);
CREATE UNIQUE INDEX action_approvals_one_pending ON action_approvals(thread_id, action_hash) WHERE status = 'pending';

CREATE TABLE tool_receipts (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  thread_id     text NOT NULL REFERENCES privacy_workflows(thread_id) ON DELETE CASCADE,
  proposal_id   text REFERENCES action_proposals(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  tool          text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('simulation', 'real')),
  status        text NOT NULL CHECK (status IN ('running', 'requested', 'verified', 'failed', 'unsupported', 'already_done')),
  attempts      integer NOT NULL DEFAULT 0,
  sanitized_input jsonb NOT NULL,
  sanitized_output jsonb,
  error_code    text,
  commitment    text,                                   -- local SHA-256 commitment; NOT an on-chain record
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX tool_receipts_thread ON tool_receipts(user_id, thread_id);

CREATE TABLE privacy_policies (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('always_require_approval', 'auto_approve')),
  action        text NOT NULL,
  alias_id      text REFERENCES user_aliases(id) ON DELETE CASCADE,  -- auto_approve must name an alias
  sender_domain text,                                                -- auto_approve must name a sender domain
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'auto_approve' OR (alias_id IS NOT NULL AND sender_domain IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX privacy_policies_user ON privacy_policies(user_id);

CREATE TABLE incident_summaries (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  alias_id      text REFERENCES user_aliases(id) ON DELETE CASCADE,
  sender_id     text REFERENCES sender_observations(id) ON DELETE CASCADE,
  summary       text NOT NULL,                          -- non-secret, generated from classification evidence
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Non-secret documents only. user_id NULL = shared playbook / policy text.
-- `embedding` has no fixed dimension so local models of any size work; search is exact (sequential) by model,
-- which is fine at this scale and avoids silently mixing vector spaces.
CREATE TABLE privacy_embeddings (
  id            text PRIMARY KEY,
  user_id       text REFERENCES agent_users(id) ON DELETE CASCADE,
  doc_type      text NOT NULL CHECK (doc_type IN ('playbook', 'policy_text', 'incident_summary', 'memory', 'service_name')),
  ref_id        text,
  content       text NOT NULL,
  model         text NOT NULL,
  embedding     vector NOT NULL,
  approved_by_user boolean NOT NULL DEFAULT false,      -- user-approved context memory
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_embeddings_user ON privacy_embeddings(user_id, doc_type, model);

CREATE TABLE audit_events (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES agent_users(id) ON DELETE CASCADE,
  thread_id     text,
  kind          text NOT NULL,
  label         text NOT NULL,                          -- sanitized; masked aliases only
  commitment    text NOT NULL,                          -- SHA-256(canonical event || nonce), compatible with merkle.js leaves
  nonce         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user ON audit_events(user_id, created_at);

-- Row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_sessions','user_aliases','sender_observations','privacy_workflows','action_proposals',
                           'action_approvals','tool_receipts','privacy_policies','incident_summaries','audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (user_id = current_setting(''app.user_id'', true)) WITH CHECK (user_id = current_setting(''app.user_id'', true))', t);
  END LOOP;
END $$;

ALTER TABLE privacy_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON privacy_embeddings FOR SELECT USING (user_id IS NULL OR user_id = current_setting('app.user_id', true));
CREATE POLICY tenant_write ON privacy_embeddings FOR ALL USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
-- Shared (user_id NULL) documents are seeded by the migration role with app.user_id = '__system__'.
CREATE POLICY system_seed ON privacy_embeddings FOR ALL USING (current_setting('app.user_id', true) = '__system__') WITH CHECK (current_setting('app.user_id', true) = '__system__');

ALTER TABLE agent_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_users FORCE ROW LEVEL SECURITY;
CREATE POLICY self_only ON agent_users USING (id = current_setting('app.user_id', true) OR current_setting('app.user_id', true) = '__system__')
  WITH CHECK (id = current_setting('app.user_id', true) OR current_setting('app.user_id', true) = '__system__');
-- Session lookup happens before the user is known: allow the system context to read sessions by token hash.
CREATE POLICY session_lookup ON agent_sessions FOR SELECT USING (current_setting('app.user_id', true) = '__system__');
CREATE POLICY session_issue ON agent_sessions FOR INSERT WITH CHECK (current_setting('app.user_id', true) = '__system__');
