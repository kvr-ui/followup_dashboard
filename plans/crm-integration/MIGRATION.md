# Atlas migration + attribution backfill runbook

The one-time move of the retired `focas-crm` MongoDB Atlas database into the
dashboard database, and the backfills that give the migrated leads their
attribution.

**Why this is not optional and not repeatable.** Meta's insights API does not reach
back indefinitely. The spend rows for older months exist in the CRM's database and
nowhere else — once that cluster is decommissioned they are gone, and no amount of
re-syncing brings them back. Everything else in this plan can be rebuilt from Meta;
this cannot.

**Why there is no transformation step.** Task 1 kept Meta's own ids as `_id` on
every mirror collection, exactly as the CRM stored them. So this is a straight
collection copy: dump, restore with the namespaces remapped, verify counts. No
field is rewritten, no id is regenerated, and every cross-reference
(`MetaAdset.campaignId` -> `MetaCampaign._id`, `MetaAd.adsetId` -> `MetaAdset._id`,
`MetaAd.creativeId` -> `MetaCreative._id`, `MetaInsight.campaignId`,
`MetaLead.campaignId`) keeps pointing at the same document it always did.

---

## 0. Before you start

### Tooling

```bash
mongodump --version     # MongoDB Database Tools
mongorestore --version
node --version
```

### Credentials — read them, never commit them

Two connection strings are needed. **Both live only in `.env` files that are not in
git. Do not paste either one into this document, a ticket, or a shell you are
screen-sharing.**

| Placeholder    | Where it lives                              | Points at                          |
| -------------- | ------------------------------------------- | ---------------------------------- |
| `$ATLAS_SRC`   | `focas-crm/.env` -> `DATABASE_URL`          | the retired CRM database (`meta`)  |
| `$DASH_DST`    | `Followup_dashboard/backend/.env` -> `MONGO_URI` | the dashboard database        |

Load them into the shell without echoing them:

```bash
cd /path/to/Followup_dashboard

ATLAS_SRC=$(grep -m1 '^DATABASE_URL=' /path/to/focas-crm/.env | cut -d= -f2- | tr -d '"'"'"'')
DASH_DST=$(grep -m1  '^MONGO_URI='    backend/.env              | cut -d= -f2- | tr -d '"'"'"'')
```

> **The password contains `@` and must stay URL-encoded as `%40`.** Both `.env`
> files already encode it. If you retype a URI by hand and the driver complains
> about the host, this is why.

### The one flag that decides where the data lands

`mongorestore` treats a dump directory as **single-database** when the URI carries a
default database in its path, and **multi-database** when it does not. The namespace
remapping below only works in multi-database mode, so the destination URI must have
its `/followup_dashboard` path segment stripped:

```bash
DASH_ROOT=$(printf '%s' "$DASH_DST" | sed -E 's#(mongodb(\+srv)?://[^/]+)/[^?]*#\1/#')
```

Symptom if you skip this: `don't know what to do with subdirectory dump/meta,
skipping...` and `0 document(s) restored`.

---

## 1. Freeze the source, then record its counts

### Stop the CRM's sync scheduler first

The retired CRM keeps polling Meta on a timer (`SYNC_INTERVAL_MINUTES` in its
`.env`) and keeps accepting web leads. While it runs, its collection counts move
under you — during the writing of this runbook `metacreatives` went from 1366 to
1445 and `metainsights` from 260 to 265 within twenty minutes. A live source is not
wrong, but it makes "the counts match" un-assertable, and any lead captured after
the dump is a lead the dashboard never receives.

So before dumping, on the CRM host: set `SYNC_INTERVAL_MINUTES=0` and stop the
service (or stop its container outright).

If you cannot stop it — a rehearsal run against a live CRM is a perfectly reasonable
thing to do — that is fine. Just know that step 5's verification deliberately
compares the restore against **the dump**, not against a live re-count of Atlas, for
exactly this reason.

### Record the counts

```bash
mongosh "$ATLAS_SRC" --quiet --eval '
  db.getCollectionNames().sort().forEach(c =>
    print(String(db.getCollection(c).countDocuments()).padStart(8), c))'
```

Write the output down. For reference, the counts at the time this runbook was
written (2026-08-07):

| Collection      | Documents |
| --------------- | --------: |
| `metacampaigns` |        27 |
| `metaadsets`    |        48 |
| `metaads`       |       179 |
| `metacreatives` |      1445 |
| `metainsights`  |       265 |
| `metaleads`     |         0 |
| `webleads`      |       159 |
| `syncruns`      |        81 |

---

## 2. What moves, and where it lands

Seven of the eight collections keep their name. One is renamed: the CRM's model was
`SyncRun`, the dashboard's is `AdSyncRun` (deliberately, so it is unmistakably
separate from the dashboard's own `SyncState` cursor), and mongoose derives the
collection name from the model name.

| Source (`meta` db) | Destination (`followup_dashboard` db) | Note                        |
| ------------------ | ------------------------------------- | --------------------------- |
| `metacampaigns`    | `metacampaigns`                       |                             |
| `metaadsets`       | `metaadsets`                          |                             |
| `metaads`          | `metaads`                             |                             |
| `metacreatives`    | `metacreatives`                       |                             |
| `metainsights`     | `metainsights`                        |                             |
| `metaleads`        | `metaleads`                           |                             |
| `webleads`         | `webleads`                            |                             |
| `syncruns`         | **`adsyncruns`**                      | renamed — `SyncRun` -> `AdSyncRun` |

Nothing else in the dashboard database is touched. `tasks`, `calls`, `deals`,
`users`, `syncstates`, `watiwebhooks` and the campaign/messaging collections are not
in the dump and are not in any `--nsInclude` below.

---

## 3. Dump

The dump is **read-only against Atlas**. Nothing in this step can damage the source.

Keep the log — step 5 verifies the restore against the per-collection counts
`mongodump` reports here, which is the only number that is authoritative about what
actually left Atlas.

```bash
mongodump --uri="$ATLAS_SRC" --out=./crm-dump 2>&1 | tee ./crm-dump.log
grep 'done dumping' ./crm-dump.log
ls -la ./crm-dump/meta        # one .bson + one .metadata.json per collection
```

Keep `./crm-dump` until step 5 has passed. It is the artifact you re-restore from if
a restore is interrupted, and it is the only offline copy of the capture history.

> `./crm-dump` contains customer phone numbers. Put it somewhere gitignored, and
> delete it once the cutover (task 13) is done.

---

## 4. Restore, with the namespaces remapped

Two passes, because the `syncruns` -> `adsyncruns` rename is a different mapping from
the wholesale `meta.*` -> `followup_dashboard.*` one. Two explicit passes are used
rather than two `--nsFrom/--nsTo` pairs in one command, because the precedence
between overlapping pairs is not worth guessing at during a one-shot migration.

```bash
# Pass 1 — everything except syncruns
mongorestore --uri="$DASH_ROOT" --drop \
  --numParallelCollections=1 \
  --nsInclude='meta.*' --nsExclude='meta.syncruns' \
  --nsFrom='meta.*' --nsTo='followup_dashboard.*' \
  ./crm-dump

# Pass 2 — syncruns -> adsyncruns
mongorestore --uri="$DASH_ROOT" --drop \
  --nsInclude='meta.syncruns' \
  --nsFrom='meta.syncruns' --nsTo='followup_dashboard.adsyncruns' \
  ./crm-dump
```

**`--drop`** drops each destination collection immediately before refilling it. That
is what makes this step re-runnable: an interrupted restore is fixed by running it
again, not by hand-deleting partial data. It is safe here because the destination
ads collections are created empty by the model definitions and hold nothing the
dashboard produced — with one exception:

> If the Meta sync (task 5) has already run locally, `adsyncruns` holds local run
> records that pass 2 will drop. Those are an audit log of syncs, not data anything
> depends on. If you want to keep them, drop `--drop` from **pass 2 only** — the
> CRM's `_id`s are ObjectIds and cannot collide with the local ones.

**`--numParallelCollections=1`** restores one collection at a time. The parallel
default opens several connections at once and, on a residential link, one of them
timing out fails the whole run mid-way (`connection pool ... was cleared`). Serial
is slower and finishes.

> **Re-running this step AFTER the backfills in section 6 will undo them on the lead
> side.** `--drop` refills `webleads` from the CRM's copy, which has no `phoneKey`,
> `resolvedCampaignId`, `resolvedBy` or `linkedTaskId` — those four fields exist only
> in the dashboard's schema. `Task.linkedLeadId` survives (lead `_id`s are stable
> across a restore), so the link is left pointing one way only until you re-run
> steps 6.2 and 6.3. Both are idempotent, so the fix is just to run them again.

---

## 5. Verify

### 5a. Counts match, collection by collection

Compares what the dashboard now holds against what `mongodump` reported taking out
of Atlas, applying the same rename map as the restore. Read-only on both sides.

```bash
mongosh "$DASH_DST" --quiet --eval '
  ["metacampaigns","metaadsets","metaads","metacreatives","metainsights",
   "metaleads","webleads","adsyncruns"].forEach(c =>
     print(c, db.getCollection(c).countDocuments()))' \
| while read -r dest n; do
    src=$([ "$dest" = adsyncruns ] && echo syncruns || echo "$dest")
    want=$(grep -oE "done dumping .meta\.$src. \([0-9]+ documents\)" ./crm-dump.log \
           | grep -oE '[0-9]+ documents' | grep -oE '[0-9]+')
    [ "$want" = "$n" ] && s=OK || s=MISMATCH
    printf '%-14s -> %-14s dumped:%6s restored:%6s  %s\n' "$src" "$dest" "$want" "$n" "$s"
  done
```

Every row must read `OK`. A mismatch means re-run step 4 — `--drop` makes that safe.

> **Why not compare against a live count of Atlas?** Because if the CRM was not
> stopped in step 1 it is still writing, and its counts will legitimately have moved
> on since the dump. Comparing dump-to-restore asks the question that actually
> matters — *did everything that left Atlas arrive?* — and gives the same answer
> whether or not the source is frozen. If you did stop the CRM, the step-1 numbers
> will agree with the dump numbers too, and that is worth checking.

### 5b. Ids survived, and cross-references still resolve

A count match proves the documents arrived. This proves they arrived *joined*: that
`_id` is still Meta's own string id and that every foreign key still finds its row.

```bash
mongosh "$DASH_DST" --quiet --eval '
  const c = db.metacampaigns.findOne();
  print("campaign _id:", c._id, "(" + typeof c._id + ") —", c.name);

  const ids  = new Set(db.metacampaigns.find({}, {_id:1}).toArray().map(x => x._id));
  const sets = new Set(db.metaadsets.find({}, {_id:1}).toArray().map(x => x._id));
  const cres = new Set(db.metacreatives.find({}, {_id:1}).toArray().map(x => x._id));

  const dangling = (coll, field, pool) =>
    db.getCollection(coll).find({[field]: {$ne: null}}, {[field]:1}).toArray()
      .filter(d => !pool.has(d[field])).length;

  print("adset -> campaign  :", dangling("metaadsets",   "campaignId", ids));
  print("ad -> adset        :", dangling("metaads",      "adsetId",    sets));
  print("ad -> campaign     :", dangling("metaads",      "campaignId", ids));
  print("ad -> creative     :", dangling("metaads",      "creativeId", cres));
  print("insight -> campaign:", dangling("metainsights", "campaignId", ids));'
```

Expected: `campaign _id` prints a long numeric **string** (`120250293479570598`), not
an ObjectId, and every dangling count is `0`.

---

## 6. Backfill the attribution

Four scripts. **The order is load-bearing** and each one refuses to run out of turn
with a message naming the step it is waiting for — you cannot silently produce a
misleading result by running them in the wrong sequence.

### Run them from `backend/`

```bash
cd backend
```

Not from the repo root. `backfillPhoneKeys.js` calls a bare `require("dotenv").config()`,
which resolves `.env` from the **shell's working directory** — run it from the repo
root, where there is no `.env`, and `MONGO_URI` falls back to the localhost default.
On a machine with a dev mongod listening (this one has one) the script then connects,
reports a confident success, and has rewritten a **different database**. The three
scripts added by this task resolve `.env` from their own location and are immune,
but keeping one working directory for all four is the habit that makes the class of
mistake impossible.

### Step 1 — contact phone keys

```bash
node scripts/backfillPhoneKeys.js
```

Derives `Task.phoneKey` (last 10 digits) for every contact. Everything downstream
joins on this by indexed equality, so a contact without it can never match a lead.

Expect: `Scanned N task(s): N updated, ... skipped (no usable phone)`.

### Step 2 — resolve lead campaigns

```bash
node scripts/resolveLeadCampaigns.js --dry-run   # look first
node scripts/resolveLeadCampaigns.js
```

Runs task 5's campaign resolver over every web lead's `utm_campaign` and stores
`resolvedCampaignId` + `resolvedBy` (`id` / `exact` / `normalized` / `alias` /
`unmapped` / `null`).

Prints a breakdown by method and — the actionable part — **the distinct
`utm_campaign` strings that matched no campaign and that nobody has triaged**. That
list is a to-do list for whoever owns the ad URLs.

*Refuses to run* if `MetaCampaign` is empty: with no campaigns to match against,
every lead would resolve to nothing and the report would blame the UTM tags for a
missing step 4.

### Step 2a — seed the UTM aliases, then re-run step 2

```bash
node scripts/seedCampaignAliases.js --dry-run    # look first
node scripts/seedCampaignAliases.js
node scripts/resolveLeadCampaigns.js             # re-run step 2 to apply them
```

Step 2's first real run resolved **0 of 80** tagged leads — not a resolver defect but
a tagging one: every Meta campaign name carries a `DDMM` suffix (`... Campaign 2904`)
that no hand-written UTM tag reproduces, so no normalisation can close the gap. The
alias table (`modules/ads/models/CampaignAlias`) is the operator's answer for the
history that a fix-at-source can never reach.

This seeds the four mappings a human has already checked against the evidence — two
to real Meta campaigns, and `Google x Competitor Audience Campaign` (Google Ads) plus
`deploytest` (smoke tests) as **deliberately unmapped**, which is how a UTM that has
no Meta campaign comes off the actionable list without pretending it resolved.

The mapped seeds are looked up **by campaign name at run time**, and the script aborts
if a name matches zero or more than one campaign — a stale hard-coded id would
otherwise attach real spend to the wrong campaign, silently and forever.

Idempotent, and it will not clobber a human: a row that already says something
different is reported and left alone unless you pass `--force`. Aliases are keyed on
the *normalized* UTM, so one entry survives later case and punctuation drift.

Afterwards the operator maintains this table through the admin API rather than the
script — `GET/POST/PUT/DELETE /api/ads/campaign-aliases` (admin JWT only). The list
endpoint returns every still-unresolved `utm_campaign` with its lead count, ordered
by count, so the next alias worth adding is the top row. **Adding an alias does not
touch existing leads** — re-run step 2 to apply it to history.

### Step 3 — link leads to contacts

```bash
node scripts/linkLeadsToTasks.js --dry-run       # current state, no writes
node scripts/linkLeadsToTasks.js
```

Two passes. First it derives `phoneKey` on the leads themselves — from `phone` for a
web lead, and out of the untyped instant-form `fieldData` for a Meta lead. Then it
runs task 5's linker over every lead and writes the link on both sides
(`WebLead.linkedTaskId`, and `Task.linkedLeadId` + `Task.leadSource`).

Reports matched/unmatched split by the rule that succeeded (`biginContactId` — an
identity, or `phoneKey` — an inference) and, for the unmatched, why:

- `no-key` — neither a Bigin contact id nor a usable phone. A data-quality problem.
- `no-matching-task` — the person is not a dashboard contact. Normal: a Task exists
  only for someone a rep raised a follow-up against.
- `ambiguous-phone` — two contacts share the number. The linker refuses to guess.
- `task-found-other-lead-won` — the contact submitted the form more than once and a
  newer lead holds the link.

*Refuses to run* if any Task has a usable phone but no `phoneKey` — i.e. step 1 was
skipped — because the phone rule would silently match nothing.

### Step 4 — the report (the phase gate)

```bash
node scripts/attributionReport.js
```

Read-only; it does not even let mongoose auto-build an index. Prints total leads by
type, campaign resolution by method, links by rule, how many contacts now carry a
source, the end-to-end "has both a lead and a campaign" figure, and the unresolved
UTM list.

*Refuses to run* until steps 2 and 3 have both recorded a run in `syncstates`
(`backfill:resolveLeadCampaigns`, `backfill:linkLeadsToTasks`), because a report full
of zeros is indistinguishable from a report of a backfill that never happened — and
distinguishing those two is the entire reason it exists.

### Step 5 — spot-check one lead by hand

Aggregates hide a systematically wrong link as easily as they hide a right one. Pick
one linked lead and read both sides of it:

```bash
node -e '
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./config/db");
const Task = require("./models/Task");
const WebLead = require("./modules/ads/models/WebLead");
(async () => {
  await connectDB();
  const lead = await WebLead.findOne({ linkedTaskId: { $ne: null } })
    .sort({ createdAt: -1 }).lean();
  const task = await Task.findById(lead.linkedTaskId,
    { phone: 1, phoneKey: 1, dedupeKey: 1, leadSource: 1, linkedLeadId: 1, "body.Who_Id": 1 }).lean();
  console.log("lead:", lead.name, lead.phone, "| utm:", lead.utmCampaign,
              "| campaign:", lead.resolvedCampaignId || null,
              "(" + (lead.resolvedBy || null) + ")");
  console.log("task:", task.dedupeKey, task.phone, "| source:", task.leadSource);
  console.log({
    backlink:         String(task.linkedLeadId) === String(lead._id),
    contactIdMatches: String(task.body.Who_Id.id) === String(lead.biginContactId),
    phoneKeyMatches:  task.phoneKey === lead.phoneKey,
  });
  await mongoose.connection.close();
})();'
```

All three booleans must be `true`. If `campaign:` prints `null`, cross-check the
lead's `utmCampaign` against the unresolved list from step 2 — a null there is the
tagging problem, not a linking problem. (The field is left absent rather than
explicitly `null` when nothing resolved: step 2 writes only on a real change, which
is what makes its second run a no-op. Every query in the report and the API treats
absent and `null` identically.)

### Re-running

All of them are idempotent: they compare against what is stored and write only on a
real change, so a second run reports `0 updated` / `0 links newly written` /
`0 created`. Tune `modules/ads/services/campaignResolver.js` or add an alias, re-run
steps 2 and 4, compare.

---

## 7. Phase gate

Read the report and answer one question: **if the Acquisition panel shipped tomorrow,
how often would it have something true to say?**

- A poor **link** rate means the matcher needs work, or the leads genuinely belong to
  people who were never dashboard contacts. The unmatched-reason breakdown says
  which.
- A poor **campaign resolution** rate means the ad URLs are tagged with something
  that is not a campaign name. That is fixed in Meta, not in code — though a
  consistently-wrong tagging convention may be worth teaching the resolver.

Do not start phase 4 (the UI) until someone has looked at these numbers and said
they are good enough. That is why this task sits before the UI tasks and not after.

---

## 8. Rollback

**The dump does not modify Atlas.** Steps 1-3 are pure reads; the source database is
byte-for-byte untouched no matter what happens afterwards. So rollback is, in the
ordinary case, simply *not proceeding*: stop, and the retired CRM still holds
everything.

If you need to undo a restore that has already landed:

```bash
# Removes ONLY the migrated collections. Nothing else in the dashboard database
# comes from the CRM, so nothing else is affected.
mongosh "$DASH_DST" --quiet --eval '
  ["metacampaigns","metaadsets","metaads","metacreatives",
   "metainsights","metaleads","webleads","adsyncruns"]
    .forEach(c => { db.getCollection(c).drop(); print("dropped", c); })'
```

Then re-run step 4 from `./crm-dump` when you are ready to try again.

To undo the **backfills** (steps 6.1-6.3) without touching the migrated data:

```bash
mongosh "$DASH_DST" --quiet --eval '
  db.tasks.updateMany({}, {$set: {linkedLeadId: null, leadSource: null}});
  db.webleads.updateMany({}, {$set: {linkedTaskId: null, resolvedCampaignId: null, resolvedBy: null}});
  db.syncstates.deleteMany({job: {$in: ["backfill:resolveLeadCampaigns","backfill:linkLeadsToTasks"]}});
  print("attribution cleared");'
```

`Task.phoneKey` is deliberately *not* cleared: it is derived from the contact's own
phone, nothing else depends on the backfill having run, and re-deriving it is free.

**Do not** drop `tasks`, `calls`, `deals`, `users` or `watiwebhooks` under any
circumstance. None of them came from this migration.

---

## Appendix — what the first real run found (2026-08-07)

Recorded so a later run has something to compare against, and because one of these
numbers is a finding rather than a measurement.

**Migration:** all eight collections restored with counts identical to the dump
(27 / 48 / 179 / 1445 / 265 / 0 / 159 / 81). `_id`s are Meta's original string ids
and all five cross-reference checks returned zero dangling references. The CRM was
still running during this rehearsal, which is how the source-drift caveat in step 1
came to be written.

**Linking: 77/159 web leads (48%), every one of them by `biginContactId`** — an
identity match, which cannot be wrong. Of the 82 unmatched, 69 are people who never
became a dashboard contact and 13 are repeat submissions whose contact is already
held by a newer lead. Both are correct outcomes, not failures. No lead matched by
phone alone, because the CRM's ingest recorded a Bigin contact id on all 159.

**Campaign resolution: 0/80 tagged leads (0%).** This is a *tagging* finding, not a
resolver defect — the resolver was verified against the same live campaign list and
matches correctly by id, by exact name and by normalized name. The four
`utm_campaign` values in use are hand-written labels that are not any campaign's
name:

| Leads | `utm_campaign`                              | Why it cannot resolve                                                     |
| ----: | ------------------------------------------- | ------------------------------------------------------------------------- |
|    34 | `Website Lead Campaign x Focas`              | words reordered vs. `Focas x Website Leads Campaign 2904`; no date suffix |
|    25 | `Google x Competitor Audience Campaign`      | Google Ads traffic — there is no Meta campaign to resolve to at all       |
|    18 | `Focas Retargeting Campaign - Website Leads` | reordered vs. `Focas Retargeting x Website Leads Campaign 1707`           |
|     3 | `deploytest`                                 | a deployment smoke test                                                   |

Every Meta campaign name carries a `DDMM` suffix (`... Campaign 2904`) that no UTM
tag reproduces, so **no amount of string normalisation will close this gap.** The
fix is at source: tag ad URLs with `utm_campaign={{campaign.id}}`, which resolves by
`id` and cannot drift — but that fix can never reach the leads already in the
database, which is what step 2a was added for.

**After step 2a (same day): 52/80 tagged leads (65%), and 52/52 of the *resolvable*
ones.** The remaining 28 are not a gap: 25 are Google Ads traffic and 3 are deploy
smoke tests, both triaged as deliberately unmapped, so nothing tagged is left
untriaged. The two mapped aliases were not inferred from the names looking alike —
each lead's `landingUrl` carries Meta's own `campaign_id`, and those ids agree
unanimously (34/34 and 17/18, the 18th having an unrendered `{{placement}}` macro and
no ids at all). `utm_term` independently corroborates it: both values are ad-set ids
belonging to those same two campaigns.

| Leads | `utm_campaign`                              | Now resolves to                                              |
| ----: | ------------------------------------------- | ------------------------------------------------------------ |
|    34 | `Website Lead Campaign x Focas`              | `120245224305490598` Focas x Website Leads Campaign 2904     |
|    18 | `Focas Retargeting Campaign - Website Leads` | `120250293479570598` Focas Retargeting x Website Leads 1707  |
|    25 | `Google x Competitor Audience Campaign`      | deliberately unmapped — Google Ads                           |
|     3 | `deploytest`                                 | deliberately unmapped — smoke tests                          |

End to end this moved fully-attributed contacts from 0 to **25 of the 77 linked ones
(32%)** — the first real cost figures on historical leads.

**Meta instant-form leads: 0.** The CRM never had `META_LEAD_FORM_IDS` or
`META_PAGE_ID` configured, so `metaleads` is empty and the Meta half of the linking
backfill had nothing to walk. It is exercised and correct — verified against seeded
data in a scratch database — but it has not yet run against real Meta leads.
