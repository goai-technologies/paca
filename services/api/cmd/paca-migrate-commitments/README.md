# paca-migrate-commitments

Moves every Commitment-typed task into one **Commitments project** and attaches
its work through the Commitment field (`tasks.commitment_task_id`), replacing
the older convention of linking work to a commitment with `relates_to`.

It talks to PACA only through the public API, so every change is validated and
recorded in task history exactly as if someone had made it in the UI. It never
touches the database directly.

## What it does

1. **Reads** every live project, its types, statuses, fields, members and
   tasks, and the `relates_to` links and comments of every commitment.
2. **Plans** the move and prints it. Linked top-level tickets are attached;
   linked child tickets follow their top-level ticket; a commitment's own child
   tasks are detached and attached as top-level work. Anything ambiguous (a
   ticket linked to two commitments, a child whose parent belongs to nothing)
   is reported as an issue and blocks `-apply` until resolved.
3. **Prepares** the Commitments project (created if missing): the statuses the
   commitments use, a `Commitment` task type, the fields they carry plus
   `workstream`, their owners as members. It then sets the project as the
   workspace's commitments project.
4. **Migrates** each commitment: creates the copy (title, description, owner,
   reporter, dates, priority, tags, fields, a "Migrated from" note), attaches
   its work, sets the final status (closed commitments accept no new work, so
   this comes last), copies its comments, removes the old `relates_to` links
   and soft-deletes the old task.
5. **Verifies**: every new commitment carries exactly the planned work and
   every old one is gone.

## Running it

```bash
go build -o paca-migrate-commitments ./cmd/paca-migrate-commitments

# Dry run (default): prints the plan, changes nothing.
./paca-migrate-commitments -base-url https://paca.example.com -api-key "$PACA_API_KEY"

# Apply. Progress is written to the state file after every step; if a run
# stops, fix the cause and run the same command again to resume.
./paca-migrate-commitments -base-url https://paca.example.com -api-key "$PACA_API_KEY" \
  -state migrate.state.json -apply

# Re-check a finished migration.
./paca-migrate-commitments -base-url https://paca.example.com -api-key "$PACA_API_KEY" \
  -state migrate.state.json -verify
```

Authenticate with `-api-key` (sent as `X-Api-Key`) or `-username`/`-password`.
Use an account with workspace-wide rights (settings, projects, tasks): it
creates a project, sets a workspace setting and edits tasks in every project.

| Flag | Default | Meaning |
|---|---|---|
| `-project-name` | `Commitments` | Name of the Commitments project |
| `-prefix` | `COM` | Its ticket prefix; an existing project with this prefix is reused |
| `-workstream` | `Delivery` | Workstream written on every migrated commitment |
| `-also-attach T=C` | | Attach top-level ticket `T` to commitment `C` by hand (repeatable). Refused if `T` is already linked to a different commitment |
| `-state` | `migrate-commitments.state.json` | Resume file |
| `-created-at-sql` | `migrate-commitments.created_at.sql` | Where to write the optional SQL below |

## Created dates

The API sets a new task's created date to the day it is created. After
`-apply` the tool writes SQL that restores each commitment's original created
date. It is never executed by the tool; review it and run it against the PACA
database if you want the original dates kept.

## Before running against production

- Back up the database.
- Run the dry run and read the plan; resolve every reported issue.
- The account's comments on old commitments need project membership; where the
  account is not a member, the tool skips that courtesy note and says so.
