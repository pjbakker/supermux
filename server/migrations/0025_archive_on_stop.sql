-- migrations/0023_archive_on_stop.sql
-- Auto-archive-on-stop for scheduler-booted sessions.
--
-- schedules.archive_on_stop: per-schedule preference (boot kind only). When 1,
-- the runner stamps the spawned session so it archives itself the moment it
-- stops (explicit Stop, or a Claude SessionEnd). Defaults to 0 so every EXISTING
-- schedule keeps today's behavior; "default on" for NEW boot schedules lives in
-- the create handler, not here.
--
-- sessions.archive_on_stop: the disposable marker copied onto the spawned row.
-- Read by the stop hook. Defaults to 0 so manual / board / team sessions are
-- never auto-archived.

ALTER TABLE schedules ADD COLUMN archive_on_stop INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions  ADD COLUMN archive_on_stop INTEGER NOT NULL DEFAULT 0;
