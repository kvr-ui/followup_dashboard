// Backfill task categories.
//
//   node modules/calls/scripts/backfillTaskCategory.js            # dry run
//   node modules/calls/scripts/backfillTaskCategory.js --apply    # write
//
// Bigin's custom `Task_Category` picklist is brand new — only 2 of the 2,000 most
// recent tasks have it set, so there is nothing to fetch from the API. But for years
// the reps typed the category straight into the task SUBJECT ("Follow Up",
// "Call Back", "Followup-NR", "See Response"). That's the data we backfill from.
//
// No Zoho calls — everything needed is already in our own taskHistory.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Task = require('../../../models/Task');
const { resolveCategory, categoryFromSubject } = require('../../../services/taskCategory');

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDB();
  await Task.syncIndexes(); // taskCategory index

  const docs = await Task.find({}, { taskHistory: 1, body: 1, taskCategory: 1, taskCategorySource: 1 });
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | ${docs.length} lead(s)\n`);

  const tally = {};
  const unmapped = {};
  let tasksSeen = 0, tasksTagged = 0, leadsChanged = 0;

  for (const doc of docs) {
    let touched = false;

    // 1. Every task in the lead's history gets its own category.
    for (const h of doc.taskHistory || []) {
      tasksSeen += 1;
      if (h.category) { tally[h.category] = (tally[h.category] || 0) + 1; tasksTagged += 1; continue; }

      const cat = categoryFromSubject(h.subject);
      if (cat) {
        h.category = cat;
        tally[cat] = (tally[cat] || 0) + 1;
        tasksTagged += 1;
        touched = true;
      } else {
        const k = String(h.subject || '(blank)').slice(0, 28);
        unmapped[k] = (unmapped[k] || 0) + 1;
      }
    }

    // 2. The lead's own category is its NEWEST task's — that's what `body` holds.
    //    Never overwrite a real Bigin value with a guess from a subject line.
    if (doc.taskCategorySource !== 'bigin') {
      const { category, source } = resolveCategory(doc.body || {});
      if (doc.taskCategory !== category) {
        doc.taskCategory = category;
        doc.taskCategorySource = source;
        touched = true;
      }
    }

    if (touched) {
      leadsChanged += 1;
      if (APPLY) { doc.markModified('taskHistory'); await doc.save(); }
    }
  }

  console.log('=== CATEGORIES DERIVED ===');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log(`\n  tasks categorised : ${tasksTagged}/${tasksSeen}  (${Math.round((100 * tasksTagged) / tasksSeen)}%)`);
  console.log(`  leads changed     : ${leadsChanged}`);

  console.log('\n=== NOT CATEGORISED — subjects that match no category ===');
  console.log('  (these are real things your reps do, but are not in the Bigin picklist)');
  Object.entries(unmapped)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  "${k}"`));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  } else {
    const withCat = await Task.countDocuments({ taskCategory: { $ne: null } });
    console.log(`\nAPPLIED — ${withCat}/${docs.length} leads now have a category.`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
