-- Let `bar_weight` express "no explicit bar" (LIFT-1387).
--
-- `Exercise.barWeight` lives in the user's DISPLAY unit (LIFT-1211): a kg user
-- stores a 20, a lbs user stores a 45. The column knew nothing about that, and
-- neither did its default:
--
--   bar_weight real NOT NULL DEFAULT 45   -- 20260404200000_add_plate_loaded.sql
--
-- The client deliberately omits the column when the user has set no explicit
-- bar, so Postgres applied that default on every insert and the read path
-- adopted it unconditionally (it has no notion of a unit). Every exercise a kg
-- user synced without touching the bar setting therefore came back holding an
-- explicit 45 — a 45 kg bar, 99 lb — and `defaultBarWeight('kg')` (20) became
-- unreachable for those rows. Signing in was enough to trigger it.
--
-- That is not just a display bug: `weightToPlates(100, 45, KG_PLATES)` says
-- 27.5 per side where the real 20 kg bar wants 40. It decomposes cleanly, so
-- there is no null, no empty state, and nothing on screen suggesting the bar is
-- wrong. It also voided the premise `convertBarWeightsForUnitChange` is written
-- on ("exercises with no explicit bar are skipped — they fall through to the
-- unit-aware default"), since after one sync essentially no row had one.
--
-- "No explicit bar" is a real state the client already relies on, so the
-- storage model should be able to hold it. Dropping the default is what makes
-- the client's `bar_weight: null` (see `_buildExerciseUpsert`) round-trip as an
-- absent `barWeight` through `mapRemoteExercise`'s finite-number guard.
--
-- `input_mode text NOT NULL DEFAULT 'numpad'` in the same original migration has
-- the identical shape but is left alone on purpose: 'numpad' IS the client's own
-- default and nothing distinguishes it from an absent value, so materializing it
-- changes nothing. `bar_weight` is the only column whose default means a
-- different physical thing in the two units.
alter table exercises alter column bar_weight drop default;
alter table exercises alter column bar_weight drop not null;

-- Repair the rows the default already materialized.
--
-- A stored 45 is genuinely ambiguous — it is both the column default and a
-- legitimate explicit lbs bar — but clearing it is lossless in BOTH units, which
-- is why this can be a blanket backfill rather than one scoped to kg accounts
-- (which would leave every lbs user broken the moment they toggled to kg):
--
--   * 45 IS `defaultBarWeight('lbs')`, so an lbs user falls back to the number
--     they already had.
--   * `convertBarWeight(45, 'lbs', 'kg')` snaps to 20, which IS
--     `defaultBarWeight('kg')` — so a later unit toggle lands on the same value
--     whether the bar was stored or defaulted. The round trip back is likewise
--     `convertBarWeight(20, 'kg', 'lbs')` = 45.
--
-- The one case this cannot preserve is a kg user who deliberately typed 45 kg
-- (a 99 lb bar, which no real equipment is); they fall back to 20 kg. That is
-- the same value the overwhelmingly more likely reading — a materialized
-- default — is being repaired to.
--
-- The updated_at trigger is suppressed for the backfill — WHERE IT EXISTS.
--
-- The suppression itself is unchanged in intent: bumping every repaired
-- exercise's timestamp would hand the server the win in the next
-- last-write-wins merge for rows where a device still holds an unflushed
-- offline edit, reverting it.
--
-- It is GUARDED because production does not have that trigger (LIFT-1397).
-- This migration first shipped issuing a bare
-- `alter table exercises disable trigger trg_exercises_updated_at`, and
-- `supabase db push` answered SQLSTATE 42704 — "trigger ... does not exist".
-- `20250401000000_add_updated_at_columns.sql` creates it and prod's migration
-- history records that file as applied, so prod's SCHEMA HAS DRIFTED FROM THE
-- HISTORY: those early files were reconstructed from hand-run scripts
-- ("Original: migration-004-updated-at.sql"), and the columns landed where the
-- triggers did not. A fresh database built from this directory has the trigger;
-- the one database that matters does not, and no test can see the difference
-- (the scheduled Integration Tests workflow builds its DB from these files).
--
-- The cost of assuming it was there was not a skipped statement. `db push`
-- applies each migration in one transaction, so the failure rolled back the
-- WHOLE file: the column stayed `NOT NULL` while the shipping client had
-- already begun sending `bar_weight: null` (23502 on every affected upsert,
-- RESOLVED rather than rejected — LIFT-1321 — so silent), and the red job
-- wedged every later schema push behind it as well as smoke-test-production
-- and notify-deploy, which need it (LIFT-1167). The rule this leaves behind:
-- **a migration may not assume any object it does not itself create.**
--
-- Disable, backfill and restore share one `DO` block so the two halves cannot
-- disagree about what was found. `tgenabled = 'O'` is "enabled the ordinary
-- way", so a trigger somebody had deliberately disabled is left exactly as it
-- was found rather than switched on by a data repair.
--
-- Residual, stated rather than papered over: if prod carries an updated_at
-- trigger under some other name, this skips it and the backfill bumps the rows
-- it repairs. That is a degraded outcome on a narrow set of rows; the bare
-- statement's outcome was the outage above.
--
-- One correction to the note this replaces, which claimed the cleared value
-- "propagates to local state on its own" because the server's stamp leads the
-- client's. It does not. `mapRemoteExercise` adopts the server's `updated_at`
-- verbatim, so a synced row sits at an exact TIE, and `mergeEntities` scores a
-- tie as a LOCAL win (LIFT-1399) — the device re-upserts the 45 it is still
-- holding and undoes the repair (LIFT-1398). With no updated_at trigger on
-- prod that tie is permanent. So this backfill's job is only to stop the server
-- handing a fresh 45 to the next device that signs in; the client-side repair
-- in LIFT-1398 is what reaches the devices that already hold one.
do $$
declare
  suppressed boolean := false;
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.exercises'::regclass
      and tgname = 'trg_exercises_updated_at'
      and not tgisinternal
      and tgenabled = 'O'
  ) then
    alter table public.exercises disable trigger trg_exercises_updated_at;
    suppressed := true;
  end if;

  update public.exercises set bar_weight = null where bar_weight = 45;

  if suppressed then
    alter table public.exercises enable trigger trg_exercises_updated_at;
  end if;
end;
$$;
