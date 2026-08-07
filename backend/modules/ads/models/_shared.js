const mongoose = require('mongoose');

// Shared helpers for the ads models, ported from the retired focas-crm service
// (backend/src/models.ts). Kept in one place so all eight schemas serialise
// identically and so the compile guard is written once.

// Shared JSON shape: expose the virtual `id`, hide `_id` and `__v`. The API
// responses the ads frontend expects are keyed on `id`, not `_id`.
function applyJsonTransform(schema) {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  });
  schema.set('toObject', { virtuals: true, versionKey: false });
}

// The Meta mirror collections are a copy of remote state, so the only useful
// timestamp is "when did we last pull this row" — an updatedAt named `syncedAt`,
// with no createdAt.
const syncedAtTimestamps = { timestamps: { createdAt: false, updatedAt: 'syncedAt' } };

// Reuse an already-compiled model. Nodemon reloads modules on restart and the
// models are required from several places; without this a second require throws
// OverwriteModelError.
function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = { applyJsonTransform, syncedAtTimestamps, model };
