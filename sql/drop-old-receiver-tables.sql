-- Workstream G, last step. Drops the receiver's tables from the SHARED
-- Postgres (the one Paperclip uses) after they have lived on the client-data
-- database for at least 7 days and Petrus has said yes.
--
-- Do not run before all of these are true:
--   1. The receiver has run on CLIENT_DATABASE_URL for 7 days (/health says source: client-data).
--   2. `node scripts/migrate-client-db.mjs verify` matched on the switch day.
--   3. A manual backup of the shared Postgres was taken today (Railway, Backups tab).
--   4. Petrus's explicit yes for this file, today.
-- Run against the SHARED database only. Paperclip's own tables are not touched.
BEGIN;
DROP TABLE IF EXISTS pipeline_snapshots;
DROP TABLE IF EXISTS prompt_change_proposals;
DROP TABLE IF EXISTS interaction_scores;
DROP TABLE IF EXISTS econowind_leads;
DROP TABLE IF EXISTS bunker_prices;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS retell_events;
COMMIT;
