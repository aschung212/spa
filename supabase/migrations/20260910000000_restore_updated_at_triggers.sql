-- Restore the `updated_at` machinery last-write-wins depends on (LIFT-1401).
--
-- LIFT-1397 established one fact about production: `supabase db push` answered
--
--   ERROR: trigger "trg_exercises_updated_at" for table "exercises"
--          does not exist (SQLSTATE 42704)
--
-- `20250401000000_add_updated_at_columns.sql` creates that trigger and two
-- siblings in ONE transaction, so a commit that installed the columns and
-- skipped the triggers is not a state Postgres can reach: that file never ran
-- on production. Its version was baselined into
-- `supabase_migrations.schema_migrations` while the schema it describes arrived
-- some other way — its own header says `Original: migration-004-updated-at.sql`,
-- i.e. a hand-run script from before this repo tracked migrations.
--
-- The durable lesson is bigger than one statement: **production's schema is not
-- the migration history**. Every environment built from `supabase/migrations`
-- (local, CI, the scheduled Integration Tests database) agrees with the history
-- by construction, so the one database where it can be wrong is the only one
-- nothing looks at. This file therefore assumes NOTHING that 20250401000000
-- declares — not the triggers, not the trigger function, not the columns — and
-- every statement below is idempotent so it is a no-op wherever that file did
-- run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS A CORRECTNESS BUG, NOT BOOKKEEPING
--
-- No client upsert sends `updated_at` for these three tables.
-- `_buildExerciseUpsert`, `_enqueueSetUpsert` and `_enqueueEntryUpsert` each
-- enumerate their columns explicitly and the column is not among them.
-- (`user_preferences` and `user_progression` are deliberately different: those
-- rows are written whole and carry a client-stamped value, so they need no
-- trigger. That split is what `architecturalInvariants.test.ts` now pins.)
--
-- With no trigger, a row's `updated_at` is its INSERT-time `default now()` and
-- never moves again for the life of the row. `mapRemoteExercise` adopts the
-- server's stamp verbatim, and `mergeEntities` scores an exact tie as a LOCAL
-- win (`localTime >= remoteTime`). So on production:
--
--   1. Devices A and B both hold exercise X; both adopted `updated_at` = T0.
--   2. B renames it. B's local stamp becomes T1 and the upsert writes `name` —
--      but the server's `updated_at` stays at T0.
--   3. A fetches. Local T0 vs remote T0 → tie → A wins, keeps the OLD name and
--      re-upserts it. B's rename is reverted ON THE SERVER.
--   4. B fetches. T1 > T0 → B wins → B re-pushes the new name.
--
-- The name flaps with whoever synced last, and A never converges: it wins its
-- own merge every time, so it can never adopt B's value. The same applies to
-- every field the merge carries wholesale — tags, gyms, notes, bar weight,
-- archive state, and (per #1357) the winner's entire `sets` array. **A remote
-- edit can never win.**
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE TRIGGER RATHER THAN A CLIENT-SENT STAMP
--
-- The alternative — adding `updated_at: new Date().toISOString()` to the three
-- producers — makes the merge independent of server-side machinery, but it
-- moves the authority to the device clock on BOTH sides of the comparison. A
-- phone whose clock is skewed forward would then win every conflict it is party
-- to and one skewed back would lose every one, permanently, which is exactly
-- what a server-side `now()` avoids. The trigger keeps a single authoritative
-- answer to "when did the server accept this write", and because the server
-- stamps after the client did, a row that has round-tripped is always at or
-- ahead of the local copy — which is the property that makes the server the
-- convergence point rather than a third opinion.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TRANSITION
--
-- The first write to each row after this lands finally bumps `updated_at` past
-- every device's local stamp, so the REMOTE side starts winning where it has
-- been losing. That is the intended behaviour, but it means a local edit that
-- is still unflushed at that moment loses. Two things bound it: writes are
-- flushed before reads on every recovery path (`useSyncRecovery.run()` replays
-- the journal and flushes the queue BEFORE fetching, and `doInitStores` awaits
-- `syncQueue.rehydrate()` before the store fetches), and an edit that never
-- reached the server is retained in the durable journal (LIFT-1229) rather than
-- dropped. An edit made offline on a device that is then never opened again is
-- the residual case, and it is already lost today for other reasons.
--
-- `bodyweight_entries` needs its half of LIFT-1402 as well before a bodyweight
-- edit propagates: `mapRemoteBodyweightEntry` builds the merge timestamp out of
-- `created_at` and ignores the `updated_at` column entirely, so this trigger is
-- necessary but not sufficient there. Its sibling `mapRemoteExercise` reads the
-- right column, so exercises are fixed by this file alone.
--
-- ORDERING: this file sorts after 20260909000000_make_bar_weight_nullable.sql,
-- which is currently the migration failing on production (LIFT-1397). `db push`
-- applies in version order and stops at the first error, so nothing here
-- reaches production until that file applies. On a database that already has
-- the triggers, 20260909000000 suppresses this one around its backfill and
-- re-enables it; this file then recreates it either way.

-- ── Columns ───────────────────────────────────────────────────────────────────
-- Re-declared because "the triggers are missing" does not tell us the columns
-- are present — only that 20250401000000 did not run. `now()` is STABLE, so
-- Postgres evaluates the default once and takes the fast-default path rather
-- than rewriting the table.
alter table exercises          add column if not exists updated_at timestamptz not null default now();
alter table sets               add column if not exists updated_at timestamptz not null default now();
alter table bodyweight_entries add column if not exists updated_at timestamptz not null default now();

-- ── Trigger function ──────────────────────────────────────────────────────────
-- Byte-identical to 20250401000000's definition on purpose: `create or replace`
-- makes this a genuine no-op where that file ran, and the two copies cannot
-- drift into two different behaviours.
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ── Triggers ──────────────────────────────────────────────────────────────────
-- `drop ... if exists` + `create` rather than `create or replace trigger`: this
-- form is unconditional — the resulting trigger is enabled whatever state the
-- database was in, including the DISABLED state a migration that suppresses a
-- trigger around a backfill (as 20260909000000 does) would leave behind if it
-- failed to re-enable it. It also does not depend on `CREATE OR REPLACE
-- TRIGGER`'s PG14+ semantics for an object whose current state we cannot read.
-- `drop trigger if exists` is a no-op when the trigger is absent, so the file
-- is correct under both readings of production's catalog.
drop trigger if exists trg_exercises_updated_at on exercises;
create trigger trg_exercises_updated_at
  before update on exercises
  for each row execute function update_updated_at_column();

drop trigger if exists trg_sets_updated_at on sets;
create trigger trg_sets_updated_at
  before update on sets
  for each row execute function update_updated_at_column();

drop trigger if exists trg_bodyweight_entries_updated_at on bodyweight_entries;
create trigger trg_bodyweight_entries_updated_at
  before update on bodyweight_entries
  for each row execute function update_updated_at_column();

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Same reasoning as the columns: declared by the file that never ran, so they
-- may be absent. `if not exists` makes this free where they are present.
create index if not exists idx_exercises_updated_at on exercises(updated_at);
create index if not exists idx_sets_updated_at on sets(updated_at);
create index if not exists idx_bodyweight_entries_updated_at on bodyweight_entries(updated_at);
