# Moving the receiver's data to its own database ("client-data")

Written 3 Nov 2026 for Petrus. Workstream G. Every step says who clicks, what you should see, and how to go back. Nothing here deletes anything until the very last step, which needs your separate yes at least 7 days later.

## Why

Today the receiver's call data (Sendsteps and EconoWind) sits in the same Postgres as Paperclip, under the one owner login that the agents could see until the shim. Moving it to its own Postgres with its own two logins means: a leak of the Paperclip database password no longer exposes client data, the receiver can be given a login that cannot administer anything, and anyone who only needs to look gets a read-only login.

## What you will have at the end

| Thing | Where |
|---|---|
| A new Railway Postgres service named `client-data`, backups daily, point-in-time recovery on from day one | Railway, project gracious-unity |
| Login `receiver_app`: the receiver's own login, can read and write its tables, cannot create logins or databases | password in Google Password Manager |
| Login `receiver_ro`: read-only, for reports and checks | password in Google Password Manager |
| The receiver running on `CLIENT_DATABASE_URL`; `/health` says `"source":"client-data"` | Railway variable on the receiver service |
| The old tables still in the shared Postgres, untouched, for 7 days | gracious-unity Postgres |

## Before you start

1. This PR is merged. The receiver keeps using the shared database until you set the new variable, so merging changes nothing by itself. The deploy log shows `Database: shared (DATABASE_URL)`.
2. A machine that can run the migration script: your laptop with Node 22 and this repository checked out (`npm install` once), or the Cowork session. It needs to reach both databases, so use Railway's public connection strings (the "DATABASE_PUBLIC_URL" of each Postgres service).
3. Two new passwords, generated in Google Password Manager: one for `receiver_app`, one for `receiver_ro`. Long and random. They never appear in a chat, a log or a commit.
4. A quiet window of about 20 minutes: not 15:00 to 22:00 Amsterdam on a weekday, not 07:00 UTC, not 20:55 UTC. EconoWind chat runs around the clock, so a webhook or two may land during the switch; the delta copy in step 6 picks them up.

## The environment variables for the script (set in your shell, never pasted anywhere)

| Variable | Value |
|---|---|
| `SOURCE_DATABASE_URL` | the shared Postgres public connection string (today's data) |
| `CLIENT_ADMIN_DATABASE_URL` | the new `client-data` Postgres public connection string from Railway (its built-in admin login) |
| `RECEIVER_APP_PASSWORD` | the password you generated for `receiver_app` |
| `RECEIVER_RO_PASSWORD` | the password you generated for `receiver_ro` |

The script prints connection strings only with the password replaced by `***`.

## Steps

### Step 1. Create the new Postgres (Petrus, Railway, 5 minutes)

In project gracious-unity: New, Database, PostgreSQL. Name it `client-data`. When it is up, open its Backups tab: enable daily backups and click Enable PITR (same as 28 Oct for the shared database). Read back: the Backups tab shows the PITR picker. Copy its `DATABASE_PUBLIC_URL` into your shell as `CLIENT_ADMIN_DATABASE_URL`.

### Step 2. Create the two logins

```
node scripts/migrate-client-db.mjs roles
```
Expect six `ok` lines (or `skip ... already exists` on a rerun). What it does: creates `receiver_app` (login, no superuser, cannot create databases or logins) and `receiver_ro` (same, read-only), lets both connect, lets `receiver_app` create tables, and makes every table `receiver_app` creates readable by `receiver_ro`.

### Step 3. Create the empty tables as the receiver's login

```
node scripts/migrate-client-db.mjs schema
```
Expect the "Database table ... ready" lines and "schema created as receiver_app". The tables are the same ones the receiver creates at boot, from the same file (`schema.js`).

### Step 4. Row counts before

```
node scripts/migrate-client-db.mjs counts
```
Shows a table: source count, target count (0), max ids. Paste the table into the issue or chat; it has no personal data.

### Step 5. Copy

```
node scripts/migrate-client-db.mjs copy
```
Copies every table in batches of 1000, keeping the ids, then verifies the sequences. Rerunning copies only rows that are new on the source, so it is safe to run twice. Then:

```
node scripts/migrate-client-db.mjs verify
```
Expect `MATCH` on every table. If it says `DIFFERS` for a table, rerun `copy` and `verify`; new webhooks may have arrived.

### Step 6. Switch the receiver (Petrus, Railway, and the delta)

1. In Railway, on the receiver service, add the variable `CLIENT_DATABASE_URL`. Its value is the `client-data` connection string with the login `receiver_app` and its password: `node scripts/migrate-client-db.mjs url` prints the shape with the password masked. Use the **private** Railway host for this one (the receiver and the database are in the same project), not the public one.
2. Deploy. Read back in the deploy log: `Database: client-data (CLIENT_DATABASE_URL)` and the "ready" lines. Open `/health`: `"source":"client-data"`.
3. Straight away, from your shell: `node scripts/migrate-client-db.mjs copy` once more, then `verify`. This picks up anything written to the old database between step 5 and the deploy. Expect `MATCH` or a few new rows on the target only (those arrived after the switch, which is correct).
4. Readback by Claude Code: Railway deploy log and HTTP log; the next Reconciliation Checker run at 07:00 UTC reports normal counts.

### Step 7. Prove the logins

```
node scripts/migrate-client-db.mjs prove
```
Runs, as `receiver_ro`: a SELECT (must work) and INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE (must all be refused). As `receiver_app`: SELECT and an INSERT inside a rolled-back transaction (must work) and CREATE ROLE, CREATE DATABASE, ALTER SYSTEM, COPY to a server file (must all be refused). Expect `PROOF PASSED`. Paste the table; it contains no data.

### Step 8. Seven days later: drop the old tables (needs your yes)

Only after seven days on `client-data` with no problem, a fresh manual backup of the shared Postgres, and your explicit yes: run `sql/drop-old-receiver-tables.sql` against the **shared** Postgres. It drops the seven receiver tables there and nothing else. Until then the old data stays exactly where it is.

## Rollback

| When | What to do | What you lose |
|---|---|---|
| Steps 1 to 5 | Nothing to undo; the receiver never touched the new database. Delete the `client-data` service if you want. | Nothing |
| After step 6, within the window | Remove `CLIENT_DATABASE_URL` from the receiver and deploy. The receiver is back on the shared database, whose tables were never changed. | Webhook rows received after the switch exist only on `client-data`. To bring them back, run `copy` with the two URLs swapped (source = client-data as `receiver_app`, target = shared): the copy is symmetric. |
| Later | Same as above, plus the swapped copy for the days in between. | Nothing, once the swapped copy has run and `verify` matches. |

## Checks Claude Code does from Railway (read-only)

Deploy log lines `Database: client-data`, `/health` source, no `connection` errors on the receiver after the switch, Reconciliation Checker's next run normal, and the `client-data` Postgres service showing PITR variables and the bucket.
