// Give back the retry budget to calls that were blacklisted by a PROVIDER-side failure.
//
//   node modules/calls/scripts/resetGradeAttempts.js            # dry run — counts only
//   node modules/calls/scripts/resetGradeAttempts.js --apply    # clear the counters
//   node modules/calls/scripts/resetGradeAttempts.js --apply --all
//
// Why this exists: gradePending only picks up calls with gradeAttempts < MAX_ATTEMPTS,
// and every failure used to bump that counter regardless of cause. When 'sarvam-30b' was
// deprecated server-side, every grade failed with the same 400 and the whole backlog hit
// the cap within ~30 minutes — permanently invisible to the worker even after the model
// was fixed. grader.js no longer spends the budget on provider faults (isProviderFault),
// but calls blacklisted BEFORE that fix still need their counters cleared by hand. That
// is this script.
//
// By default it only resets calls whose recorded gradeError looks like a provider fault,
// so a call that is genuinely ungradeable (transcript too long, model can't produce valid
// JSON for it) stays given-up-on instead of costing credits forever. --all overrides that.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const { isProviderFault, MAX_ATTEMPTS } = require('../services/grader');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

async function run() {
  await connectDB();

  // Everything the worker has given up on but that still has a transcript to grade.
  const stuck = await Call.find({
    transcriptionStatus: 'done',
    'grade.score': null,
    gradeAttempts: { $gte: MAX_ATTEMPTS },
  })
    .select('_id gradeError gradeAttempts startedAt')
    .lean();

  if (!stuck.length) {
    console.log('Nothing stuck — no call is at the attempt cap with an ungraded transcript.');
    return;
  }

  // Status is unknown here (the error text is all we kept), so pass 0 and let the message
  // patterns decide. Every real provider fault we have seen carries its cause in the text.
  const eligible = ALL ? stuck : stuck.filter((c) => isProviderFault(0, c.gradeError));
  const skipped = stuck.length - eligible.length;

  const byError = new Map();
  for (const c of eligible) {
    const key = (c.gradeError || '(no error recorded)').slice(0, 80);
    byError.set(key, (byError.get(key) || 0) + 1);
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} | ${stuck.length} call(s) at the cap`);
  console.log(`  resettable: ${eligible.length}${ALL ? '  (--all: cause ignored)' : ''}`);
  console.log(`  left alone: ${skipped}  (failure looks specific to the call)\n`);
  for (const [err, n] of [...byError.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${err}`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to clear these counters.');
    return;
  }
  if (!eligible.length) return;

  // Clear the lease too: a call abandoned mid-grade by a crash would otherwise wait out
  // GRADE_LEASE_MS before the worker could claim it again.
  const res = await Call.updateMany(
    { _id: { $in: eligible.map((c) => c._id) } },
    { $set: { gradeAttempts: 0, gradeError: null, gradeStartedAt: null } }
  );

  console.log(`\nReset ${res.modifiedCount} call(s). The grade poll will pick them up.`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
