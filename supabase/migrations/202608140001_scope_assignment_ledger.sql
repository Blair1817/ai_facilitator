-- Scope allocation uniqueness to one persistent Tajriba ledger. Existing
-- assignments are retained as one legacy ledger; no research rows are deleted.
alter table research.game_assignments
  add column if not exists runtime_ledger_id text;

update research.game_assignments
set runtime_ledger_id = 'legacy'
where runtime_ledger_id is null;

alter table research.game_assignments
  alter column runtime_ledger_id set not null;

alter table research.game_assignments
  drop constraint if exists game_assignments_allocation_number_key,
  drop constraint if exists game_assignments_allocation_block_id_allocation_position_key,
  drop constraint if exists game_assignments_allocation_block_id_sequence_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ga_runtime_ledger_allocation_number_key'
      and conrelid = 'research.game_assignments'::regclass
  ) then
    alter table research.game_assignments
      add constraint ga_runtime_ledger_allocation_number_key
      unique (runtime_ledger_id, allocation_number);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ga_runtime_ledger_block_position_key'
      and conrelid = 'research.game_assignments'::regclass
  ) then
    alter table research.game_assignments
      add constraint ga_runtime_ledger_block_position_key
      unique (runtime_ledger_id, allocation_block_id, allocation_position);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'ga_runtime_ledger_block_sequence_key'
      and conrelid = 'research.game_assignments'::regclass
  ) then
    alter table research.game_assignments
      add constraint ga_runtime_ledger_block_sequence_key
      unique (runtime_ledger_id, allocation_block_id, sequence_id);
  end if;
end
$$;

notify pgrst, 'reload schema';
