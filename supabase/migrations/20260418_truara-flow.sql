-- supabase/migrations/20260418_truara-flow.sql

-- ─────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- Enum types
-- ─────────────────────────────────────────────────────────────
create type truara_question_type as enum (
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'rating',
  'number',
  'email',
  'date',
  'yes_no',
  'statement',
  'file_upload',
  'ranking',
  'nps',
  'calculator'
);

create type truara_flow_status as enum (
  'draft',
  'published',
  'archived',
  'paused'
);

create type truara_submission_status as enum (
  'in_progress',
  'completed',
  'abandoned'
);

create type truara_agent_task as enum (
  'question_suggestion',
  'tone_analysis',
  'branch_optimization',
  'follow_up_generation',
  'insight_summary',
  'swarm_refinement'
);

create type truara_agent_status as enum (
  'queued',
  'running',
  'completed',
  'failed'
);

-- ─────────────────────────────────────────────────────────────
-- Founders (maps 1-to-1 with auth.users)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_founders (
  id            uuid primary key default uuid_generate_v4(),
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  display_name  text,
  avatar_url    text,
  calm_mode     boolean not null default true,
  complexity_cap integer not null default 20
                  check (complexity_cap between 1 and 100),
  timezone      text not null default 'UTC',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Flows  (the "living form" entity)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_flows (
  id            uuid primary key default uuid_generate_v4(),
  founder_id    uuid not null references truara_founders (id) on delete cascade,
  title         text not null,
  description   text,
  status        truara_flow_status not null default 'draft',
  calm_mode     boolean not null default true,
  -- LangGraph thread identifier – used by PostgresSaver
  lg_thread_id  text unique,
  -- Weighted complexity score (0–100) enforced by AI co-pilot
  complexity_score integer not null default 0
                    check (complexity_score between 0 and 100),
  branding      jsonb not null default '{}'::jsonb,
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Questions inside a flow
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_questions (
  id            uuid primary key default uuid_generate_v4(),
  flow_id       uuid not null references truara_flows (id) on delete cascade,
  position      integer not null,
  question_type truara_question_type not null default 'short_text',
  title         text not null,
  description   text,
  placeholder   text,
  required      boolean not null default false,
  -- JSON payload: choices[], range, calculator_formula, etc.
  config        jsonb not null default '{}'::jsonb,
  -- Tone hint injected by calm-mode (e.g. "supportive", "curious")
  tone_hint     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (flow_id, position)
);

-- ─────────────────────────────────────────────────────────────
-- Logic branches / jump rules
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_branch_rules (
  id              uuid primary key default uuid_generate_v4(),
  flow_id         uuid not null references truara_flows (id) on delete cascade,
  source_question_id uuid not null references truara_questions (id) on delete cascade,
  -- null target = end of flow
  target_question_id uuid references truara_questions (id) on delete set null,
  condition_op    text not null default 'eq'
                    check (condition_op in ('eq','neq','gt','gte','lt','lte','contains','not_contains','is_empty','is_not_empty')),
  condition_value text,
  priority        integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Variables / scoring
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_variables (
  id          uuid primary key default uuid_generate_v4(),
  flow_id     uuid not null references truara_flows (id) on delete cascade,
  name        text not null,
  initial_value numeric not null default 0,
  description text,
  unique (flow_id, name)
);

-- ─────────────────────────────────────────────────────────────
-- Respondents  (privacy-first – no PII unless respondent provides)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_respondents (
  id            uuid primary key default uuid_generate_v4(),
  -- optional link to auth.users if respondent is also a Truara user
  auth_user_id  uuid references auth.users (id) on delete set null,
  -- hashed fingerprint for anonymous tracking (no plain PII stored here)
  fingerprint   text,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Submissions  (one per respondent × flow interaction)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_submissions (
  id              uuid primary key default uuid_generate_v4(),
  flow_id         uuid not null references truara_flows (id) on delete cascade,
  respondent_id   uuid not null references truara_respondents (id) on delete cascade,
  status          truara_submission_status not null default 'in_progress',
  -- LangGraph checkpoint thread for this respondent session
  lg_thread_id    text,
  -- Encrypted JSON of all answers (pgp_sym_encrypt)
  answers_enc     bytea,
  -- Calculated variable values snapshot
  variable_snapshot jsonb not null default '{}'::jsonb,
  -- Emotional tone detected by calm-mode AI (e.g. "neutral","stressed")
  detected_tone   text,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  updated_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Individual answer rows (per question, per submission)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_answers (
  id              uuid primary key default uuid_generate_v4(),
  submission_id   uuid not null references truara_submissions (id) on delete cascade,
  question_id     uuid not null references truara_questions (id) on delete cascade,
  -- Encrypted raw answer value
  value_enc       bytea,
  -- Non-sensitive numeric score (safe to store plaintext)
  score           numeric,
  answered_at     timestamptz not null default now(),
  unique (submission_id, question_id)
);

-- ─────────────────────────────────────────────────────────────
-- Memory threads  (longitudinal – per respondent × flow)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_memory_threads (
  id              uuid primary key default uuid_generate_v4(),
  flow_id         uuid not null references truara_flows (id) on delete cascade,
  respondent_id   uuid not null references truara_respondents (id) on delete cascade,
  -- Ordered list of submission IDs contributing to this thread
  submission_ids  uuid[] not null default '{}',
  -- Encrypted summary built by LangGraph over time
  summary_enc     bytea,
  last_active_at  timestamptz not null default now(),
  unique (flow_id, respondent_id)
);

-- ─────────────────────────────────────────────────────────────
-- LangGraph PostgresSaver checkpoints
-- (mirrors the schema expected by @langchain/langgraph-checkpoint-postgres)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_lg_checkpoints (
  thread_id   text   not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type        text,
  checkpoint  jsonb  not null default '{}'::jsonb,
  metadata    jsonb  not null default '{}'::jsonb,
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists truara_lg_checkpoint_writes (
  thread_id     text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id       text not null,
  idx           integer not null,
  channel       text not null,
  type          text,
  value         jsonb not null default '{}'::jsonb,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- ─────────────────────────────────────────────────────────────
-- Swarm agent tasks  (AI background tasks per submission)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_swarm_tasks (
  id              uuid primary key default uuid_generate_v4(),
  flow_id         uuid not null references truara_flows (id) on delete cascade,
  submission_id   uuid references truara_submissions (id) on delete set null,
  task_type       truara_agent_task not null,
  status          truara_agent_status not null default 'queued',
  -- Encrypted input context for the agent
  input_enc       bytea,
  -- Encrypted agent output (suggestions, follow-ups, insights)
  output_enc      bytea,
  error_message   text,
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

-- ─────────────────────────────────────────────────────────────
-- AI-generated follow-up micro-flows
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_follow_up_flows (
  id              uuid primary key default uuid_generate_v4(),
  parent_flow_id  uuid not null references truara_flows (id) on delete cascade,
  respondent_id   uuid not null references truara_respondents (id) on delete cascade,
  swarm_task_id   uuid references truara_swarm_tasks (id) on delete set null,
  -- Serialised mini-flow JSON generated by the swarm
  flow_json       jsonb not null default '{}'::jsonb,
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Integrations / automations (webhook + native)
-- ─────────────────────────────────────────────────────────────
create table if not exists truara_integrations (
  id            uuid primary key default uuid_generate_v4(),
  flow_id       uuid not null references truara_flows (id) on delete cascade,
  provider      text not null,   -- e.g. 'webhook', 'slack', 'notion', 'email'
  trigger_event text not null default 'submission.completed',
  -- Encrypted config: URLs, tokens, field mappings
  config_enc    bytea,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- updated_at auto-update trigger helper
-- ─────────────────────────────────────────────────────────────
create or replace function truara_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'truara_founders',
    'truara_flows',
    'truara_questions',
    'truara_submissions',
    'truara_integrations'
  ] loop
    execute format(
      'create trigger set_updated_at before update on %I
       for each row execute function truara_set_updated_at()',
      t
    );
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────
create index if not exists idx_truara_flows_founder on truara_flows (founder_id);
create index if not exists idx_truara_questions_flow on truara_questions (flow_id, position);
create index if not exists idx_truara_submissions_flow on truara_submissions (flow_id);
create index if not exists idx_truara_submissions_respondent on truara_submissions (respondent_id);
create index if not exists idx_truara_answers_submission on truara_answers (submission_id);
create index if not exists idx_truara_swarm_tasks_flow on truara_swarm_tasks (flow_id, status);
create index if not exists idx_truara_lg_checkpoints_thread on truara_lg_checkpoints (thread_id);
create index if not exists idx_truara_memory_thread on truara_memory_threads (flow_id, respondent_id);

-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────

-- Enable RLS on every table
alter table truara_founders          enable row level security;
alter table truara_flows             enable row level security;
alter table truara_questions         enable row level security;
alter table truara_branch_rules      enable row level security;
alter table truara_variables         enable row level security;
alter table truara_respondents       enable row level security;
alter table truara_submissions       enable row level security;
alter table truara_answers           enable row level security;
alter table truara_memory_threads    enable row level security;
alter table truara_lg_checkpoints    enable row level security;
alter table truara_lg_checkpoint_writes enable row level security;
alter table truara_swarm_tasks       enable row level security;
alter table truara_follow_up_flows   enable row level security;
alter table truara_integrations      enable row level security;

-- ── Helper: resolve current auth user's founder id ─────────────
create or replace function truara_current_founder_id()
returns uuid language sql stable security definer as $$
  select id from truara_founders
  where auth_user_id = auth.uid()
  limit 1;
$$;

-- ── truara_founders ────────────────────────────────────────────
create policy "founders_select_own"   on truara_founders for select using (auth_user_id = auth.uid());
create policy "founders_insert_own"   on truara_founders for insert with check (auth_user_id = auth.uid());
create policy "founders_update_own"   on truara_founders for update using (auth_user_id = auth.uid());
create policy "founders_delete_own"   on truara_founders for delete using (auth_user_id = auth.uid());

-- ── truara_flows ───────────────────────────────────────────────
create policy "flows_select_own"  on truara_flows for select
  using (founder_id = truara_current_founder_id());

create policy "flows_insert_own"  on truara_flows for insert
  with check (founder_id = truara_current_founder_id());

create policy "flows_update_own"  on truara_flows for update
  using (founder_id = truara_current_founder_id());

create policy "flows_delete_own"  on truara_flows for delete
  using (founder_id = truara_current_founder_id());

-- Public read for published flows (respondents don't need an account)
create policy "flows_select_published" on truara_flows for select
  using (status = 'published');

-- ── truara_questions ───────────────────────────────────────────
create policy "questions_founder_all" on truara_questions for all
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

create policy "questions_public_read" on truara_questions for select
  using (
    flow_id in (select id from truara_flows where status = 'published')
  );

-- ── truara_branch_rules ────────────────────────────────────────
create policy "branches_founder_all" on truara_branch_rules for all
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

create policy "branches_public_read" on truara_branch_rules for select
  using (
    flow_id in (select id from truara_flows where status = 'published')
  );

-- ── truara_variables ───────────────────────────────────────────
create policy "variables_founder_all" on truara_variables for all
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

-- ── truara_respondents ─────────────────────────────────────────
-- Respondents can see their own row; founders cannot see PII rows they did not create
create policy "respondents_select_own" on truara_respondents for select
  using (auth_user_id = auth.uid() or auth_user_id is null);

create policy "respondents_insert_anon" on truara_respondents for insert
  with check (true);

-- ── truara_submissions ─────────────────────────────────────────
-- Founders see submissions on their own flows
create policy "submissions_founder_select" on truara_submissions for select
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

-- Respondents see their own submissions
create policy "submissions_respondent_select" on truara_submissions for select
  using (respondent_id in (
    select id from truara_respondents where auth_user_id = auth.uid()
  ));

create policy "submissions_insert_any" on truara_submissions for insert
  with check (true);

create policy "submissions_update_respondent" on truara_submissions for update
  using (respondent_id in (
    select id from truara_respondents where auth_user_id = auth.uid()
  ));

-- ── truara_answers ─────────────────────────────────────────────
create policy "answers_founder_select" on truara_answers for select
  using (
    submission_id in (
      select s.id from truara_submissions s
      join truara_flows f on f.id = s.flow_id
      where f.founder_id = truara_current_founder_id()
    )
  );

create policy "answers_respondent_select" on truara_answers for select
  using (
    submission_id in (
      select s.id from truara_submissions s
      join truara_respondents r on r.id = s.respondent_id
      where r.auth_user_id = auth.uid()
    )
  );

create policy "answers_insert_any" on truara_answers for insert
  with check (true);

-- ── truara_memory_threads ──────────────────────────────────────
create policy "memory_founder_select" on truara_memory_threads for select
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

create policy "memory_respondent_select" on truara_memory_threads for select
  using (respondent_id in (
    select id from truara_respondents where auth_user_id = auth.uid()
  ));

create policy "memory_insert_any" on truara_memory_threads for insert
  with check (true);

create policy "memory_update_any" on truara_memory_threads for update
  using (true);

-- ── truara_lg_checkpoints ──────────────────────────────────────
-- The server-side LangGraph worker uses the service-role key so it bypasses RLS.
-- Auth users may only view checkpoints for threads they own via submissions.
create policy "lg_checkpoints_server_only" on truara_lg_checkpoints for all
  using (
    thread_id in (
      select lg_thread_id from truara_submissions
      where respondent_id in (
        select id from truara_respondents where auth_user_id = auth.uid()
      )
    )
  );

create policy "lg_checkpoint_writes_server_only" on truara_lg_checkpoint_writes for all
  using (
    thread_id in (
      select lg_thread_id from truara_submissions
      where respondent_id in (
        select id from truara_respondents where auth_user_id = auth.uid()
      )
    )
  );

-- ── truara_swarm_tasks ─────────────────────────────────────────
create policy "swarm_founder_all" on truara_swarm_tasks for all
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

-- ── truara_follow_up_flows ─────────────────────────────────────
create policy "followup_founder_select" on truara_follow_up_flows for select
  using (
    parent_flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );

create policy "followup_respondent_select" on truara_follow_up_flows for select
  using (respondent_id in (
    select id from truara_respondents where auth_user_id = auth.uid()
  ));

-- ── truara_integrations ────────────────────────────────────────
create policy "integrations_founder_all" on truara_integrations for all
  using (
    flow_id in (
      select id from truara_flows where founder_id = truara_current_founder_id()
    )
  );
