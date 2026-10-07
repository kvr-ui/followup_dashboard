// Clean up Bigin call rows that should never have been queued or kept.
//
//   node modules/calls/scripts/mergeBiginTwins.js            # dry run — counts only
//   node modules/calls/scripts/mergeBiginTwins.js --apply    # merge + re-park
//
// Two bugs left debris behind:
//   1. findBiginTwin required leadPhone, which TeleCMI leaves null whenever the customer
//      isn't in our leads DB. So the outgoing poll created a second row instead of
//      adopting the Bigin one — the same call twice, one transcribed, one not.
//   2. The pipeline audit / deal updates re-queued parked Bigin rows to `pending`, and the
//      worker then failed them on Zoho's PhoneBridge scope (we don't hold it, and don't
//      need it — the audio comes from TeleCMI).
//
// This merges each Bigin row into its TeleCMI twin (exactly what upsertBiginCall's
// "linked" branch does live) and deletes it, then sets any Bigin-only row still `pending`
// back to `skipped`. Bigin rows never carry a transcript or grade, so nothing is lost.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const { key10 } = require('../../../utils/phone');

const APPLY = process.argv.includes('--apply');
const WINDOW_MS = 3 * 60 * 1000; // same as biginCalls.DEDUPE_WINDOW_MS

// The customer's number on a TeleCMI row. On outbound out_cdr rows `from` is the office
// DID, so matching on all phoneKeys would link unrelated calls.
const customerKey = (t) =>
  key10(t.leadPhone) || key10(t.direction === 'outbound' ? t.to : t.from);

async function findTwin(b) {
  const k = key10(b.leadPhone);
  if (!k || !b.startedAt) return null;
  const candidates = await Call.find({
    source: 'telecmi',
    phoneKeys: k,
    startedAt: {
      $gte: new Date(b.startedAt.getTime() - WINDOW_MS),
      $lte: new Date(b.startedAt.getTime() + WINDOW_MS),
    },
  });
  const ok = candidates.filter(
    (t) => customerKey(t) === k && (!b.agentExt || !t.agentExt || b.agentExt === t.agentExt)
  );
  ok.sort(
    (x, y) => Math.abs(x.startedAt - b.startedAt) - Math.abs(y.startedAt - b.startedAt)
  );
  return ok[0] || null;
}

async function run() {
  await connectDB();

  const rows = await Call.find({
    source: 'bigin',
    transcript: null,
    'grade.score': null,
  }).sort({ startedAt: -1 });

  let merged = 0;
  const mergedByStatus = {};

  for (const b of rows) {
    const twin = await findTwin(b);
    if (!twin) continue;

    merged += 1;
    mergedByStatus[b.transcriptionStatus] = (mergedByStatus[b.transcriptionStatus] || 0) + 1;
    if (!APPLY) continue;

    // Mirror upsertBiginCall's link: keep the longer Bigin record when two map to one call.
    const bDur = b.biginDurationSec || 0;
    const keepCurrent =
      twin.biginCallId && twin.biginCallId !== b.biginCallId && (twin.biginDurationSec || 0) >= bDur;
    if (!keepCurrent) {
      twin.biginCallId = b.biginCallId;
      twin.biginContactId = b.biginContactId;
      twin.biginDurationSec = b.biginDurationSec;
    }
    for (const f of ['ownerEmail', 'leadName', 'leadPhone', 'leadId', 'recordingUrl']) {
      if (!twin[f] && b[f]) twin[f] = b[f];
    }
    await twin.save();
    await Call.deleteOne({ _id: b._id });
  }

  const strandedFilter = { source: 'bigin', transcriptionStatus: 'pending', filename: null };
  // In a dry run the merge-candidates are still present, so subtract them for the count.
  const stranded = (await Call.countDocuments(strandedFilter)) - (APPLY ? 0 : mergedByStatus.pending || 0);

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  Bigin rows scanned:              ${rows.length}`);
  console.log(`  merged into TeleCMI twin:        ${merged}  ${JSON.stringify(mergedByStatus)}`);
  console.log(`  Bigin-only pending -> skipped:   ${stranded}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  const res = await Call.updateMany(strandedFilter, {
    $set: {
      transcriptionStatus: 'skipped',
      transcriptionError: 'Awaiting TeleCMI recording',
      transcriptionAttempts: 0,
      nextAttemptAt: null,
    },
  });
  console.log(`\nMerged ${merged}, re-parked ${res.modifiedCount}.`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
