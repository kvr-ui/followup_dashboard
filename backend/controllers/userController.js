const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('../models/User');
const { publicUser } = require('./authController');

const EMAIL_IN_USE = 'Email already in use by another user';

// Trim + lowercase an email-ish input; null/undefined become ''.
function normEmail(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

function isDupKey(err, field) {
  return (
    err &&
    err.code === 11000 &&
    ((err.keyPattern && err.keyPattern[field]) || (err.keyValue && field in err.keyValue))
  );
}

// Admin creates a new user (sales or admin).
async function createUser(req, res) {
  try {
    const { name, username, password, role, ownerEmail, email } = req.body || {};

    if (!name || !username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'name, username and password are required' });
    }

    const roleVal = role === 'admin' ? 'admin' : 'sales';
    if (roleVal === 'sales' && !ownerEmail) {
      return res.status(400).json({
        success: false,
        message: 'ownerEmail is required for sales users (their Zoho Owner email)',
      });
    }

    const uname = String(username).toLowerCase();
    if (await User.findOne({ username: uname })) {
      return res.status(409).json({ success: false, message: 'Username already exists' });
    }

    const ownerVal = normEmail(ownerEmail);
    // Login email defaults to the Zoho Owner email when not given.
    const emailVal = normEmail(email) || ownerVal;
    if (emailVal && (await User.exists({ email: emailVal }))) {
      return res.status(409).json({ success: false, message: EMAIL_IN_USE });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const doc = {
      name,
      username: uname,
      passwordHash,
      role: roleVal,
      ownerEmail: ownerVal || null,
    };
    // Leave email absent (never null/'') so the sparse unique index skips it.
    if (emailVal) doc.email = emailVal;
    const user = await User.create(doc);

    res.status(201).json({ success: true, user: publicUser(user) });
  } catch (err) {
    if (isDupKey(err, 'email')) {
      return res.status(409).json({ success: false, message: EMAIL_IN_USE });
    }
    if (isDupKey(err, 'username')) {
      return res.status(409).json({ success: false, message: 'Username already exists' });
    }
    console.error('Create user failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
}

// Admin updates a user's login email and/or Zoho Owner email.
async function updateUser(req, res) {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email');
    const hasOwner = Object.prototype.hasOwnProperty.call(body, 'ownerEmail');

    if (!hasEmail && !hasOwner) {
      return res
        .status(400)
        .json({ success: false, message: 'Provide email and/or ownerEmail to update' });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (hasEmail) {
      const emailVal = normEmail(body.email);
      if (emailVal) {
        if (await User.exists({ email: emailVal, _id: { $ne: user._id } })) {
          return res.status(409).json({ success: false, message: EMAIL_IN_USE });
        }
        user.email = emailVal;
      } else {
        // Remove the key entirely ($unset) so the sparse unique index ignores it.
        user.email = undefined;
      }
    }

    if (hasOwner) {
      user.ownerEmail = normEmail(body.ownerEmail) || null;
    }

    await user.save();
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    if (isDupKey(err, 'email')) {
      return res.status(409).json({ success: false, message: EMAIL_IN_USE });
    }
    if (err && err.name === 'CastError') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    console.error('Update user failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
}

async function listUsers(req, res) {
  try {
    const users = await User.find().sort({ createdAt: 1 }).lean();
    res.json({ success: true, users: users.map(publicUser) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
}

async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    if (String(id) === String(req.user._id)) {
      return res
        .status(400)
        .json({ success: false, message: 'You cannot delete your own account' });
    }
    await User.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
}

module.exports = { createUser, updateUser, listUsers, deleteUser };
