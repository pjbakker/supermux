-- migrations/0025_archive_on_stop.sql
-- Auto-archive-on-stop: the disposable-session marker.
--
-- sessions.archive_on_stop: when 1, the stop hook archives this session the
-- moment it settles to `stopped` (explicit Stop, a Claude SessionEnd, or a
-- failed boot). Opt-in per session: defaults to 0 so manual / board / team
-- sessions are never auto-archived, and every existing row keeps today's
-- behavior. Writers: `POST /api/sessions` (the disposable-spawn pattern) and
-- the workflows create/patch plumbing, which stamps a workflow's target
-- session on request.
--
-- NUMBERING. This file fills the 0025 gap that 0027_session_mark_pin.sql and
-- 0028_session_notif.sql left open for feat/schedule-archive-on-stop by name.
-- The branch's original second column (schedules.archive_on_stop) does not
-- exist here: the schedules table's successor, workflows (0038), targets a
-- persistent session that already exists at save time, so the per-workflow
-- preference is expressed by stamping this sessions column directly instead
-- of storing a second copy that could disagree with it.

ALTER TABLE sessions ADD COLUMN archive_on_stop INTEGER NOT NULL DEFAULT 0;
