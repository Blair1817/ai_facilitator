create schema if not exists research;
revoke all on schema research from public, anon, authenticated;
grant usage on schema research to service_role;

create table research.game_assignments (
  game_id text primary key,
  runtime_ledger_id text not null,
  sequence_id text not null check (sequence_id in ('S1', 'S2', 'S3', 'S4')),
  allocation_number bigint not null,
  allocation_block_id bigint not null,
  allocation_position smallint not null check (allocation_position between 1 and 4),
  allocation_claimed_at timestamptz not null,
  allocation_method text not null,
  ledger_key text not null,
  assignment_status text not null default 'confirmed',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (runtime_ledger_id, allocation_number),
  unique (runtime_ledger_id, allocation_block_id, allocation_position),
  unique (runtime_ledger_id, allocation_block_id, sequence_id)
);

create table research.participants (
  participant_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  participant_number smallint not null check (participant_number between 1 and 3),
  profile_slot smallint not null check (profile_slot between 0 and 2),
  participant_status text not null default 'assigned', joined_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (game_id, participant_number), unique (game_id, profile_slot)
);

create table research.rounds (
  round_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  task_index smallint not null check (task_index in (0, 1)),
  task_version text not null check (task_version in ('A', 'B')),
  facilitation text not null check (facilitation in ('static', 'adaptive')),
  round_status text not null default 'created', started_at timestamptz, ended_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (game_id, task_index), unique (game_id, task_version), unique (game_id, facilitation)
);

create table research.messages (
  message_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text not null references research.rounds(round_id),
  participant_id text references research.participants(participant_id),
  transcript_key text not null, sequence_position integer not null check (sequence_position >= 0),
  stage_name text not null, message_type text not null, speaker_type text not null,
  content text not null, occurred_at timestamptz not null, created_at timestamptz not null default now(),
  unique (game_id, transcript_key, sequence_position)
);

create table research.interventions (
  intervention_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text not null references research.rounds(round_id),
  trigger_message_id text references research.messages(message_id),
  published_message_id text references research.messages(message_id),
  checkpoint_index integer not null check (checkpoint_index >= 0),
  facilitation text not null check (facilitation in ('static', 'adaptive')),
  trigger_type text not null, routing_decision text, selected_role text, outcome text not null,
  rationale jsonb not null default '{}'::jsonb, remaining_seconds integer,
  occurred_at timestamptz not null, published_at timestamptz, created_at timestamptz not null default now(),
  unique (game_id, round_id, checkpoint_index)
);

create table research.llm_calls (
  llm_call_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text not null references research.rounds(round_id),
  intervention_id text references research.interventions(intervention_id),
  call_type text not null, attempt_number smallint not null default 1 check (attempt_number > 0), model text,
  prompt_metadata jsonb not null default '{}'::jsonb, request_payload jsonb,
  response_metadata jsonb not null default '{}'::jsonb, success boolean not null,
  latency_ms integer, error_code text, occurred_at timestamptz not null, created_at timestamptz not null default now(),
  unique (intervention_id, call_type, attempt_number)
);

create table research.responses (
  response_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text references research.rounds(round_id),
  participant_id text not null references research.participants(participant_id),
  response_type text not null, response_payload jsonb not null, submitted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (game_id, round_id, participant_id, response_type)
);

create table research.game_snapshots (
  snapshot_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text references research.rounds(round_id), snapshot_type text not null,
  runtime_status jsonb not null, occurred_at timestamptz not null, created_at timestamptz not null default now(),
  unique (game_id, round_id, snapshot_type, occurred_at)
);

create table research.feature_snapshots (
  feature_snapshot_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text not null references research.rounds(round_id),
  intervention_id text not null references research.interventions(intervention_id),
  checkpoint_index integer not null check (checkpoint_index >= 0),
  semantic_assessor jsonb not null default '{}'::jsonb,
  evidence_checker jsonb not null default '{}'::jsonb,
  gate_state jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null, created_at timestamptz not null default now(),
  unique (intervention_id)
);

create table research.evidence_relations (
  evidence_relation_id text primary key,
  game_id text not null references research.game_assignments(game_id),
  round_id text not null references research.rounds(round_id),
  intervention_id text not null references research.interventions(intervention_id),
  message_id text not null references research.messages(message_id),
  relation_type text not null check (relation_type in ('mentioned','attributed','evaluated','compared','countered','integrated')),
  relation_value boolean not null,
  option_key text, evidence_key text, detector_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null, created_at timestamptz not null default now(),
  unique (intervention_id, message_id, relation_type, option_key, evidence_key)
);

create index participants_game_id_idx on research.participants(game_id);
create index rounds_game_id_idx on research.rounds(game_id);
create index messages_round_time_idx on research.messages(round_id, occurred_at);
create index interventions_round_time_idx on research.interventions(round_id, occurred_at);
create index llm_calls_intervention_idx on research.llm_calls(intervention_id);
create index responses_participant_type_idx on research.responses(participant_id, response_type);
create index feature_snapshots_round_checkpoint_idx on research.feature_snapshots(round_id, checkpoint_index);
create index evidence_relations_message_idx on research.evidence_relations(message_id);

alter table research.game_assignments enable row level security;
alter table research.participants enable row level security;
alter table research.rounds enable row level security;
alter table research.messages enable row level security;
alter table research.interventions enable row level security;
alter table research.llm_calls enable row level security;
alter table research.responses enable row level security;
alter table research.game_snapshots enable row level security;
alter table research.feature_snapshots enable row level security;
alter table research.evidence_relations enable row level security;

revoke all on all tables in schema research from public, anon, authenticated;
grant select, insert, update on all tables in schema research to service_role;
alter default privileges in schema research revoke all on tables from public, anon, authenticated;
alter default privileges in schema research grant select, insert, update on tables to service_role;
