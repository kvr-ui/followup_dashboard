const bcrypt = require('bcryptjs');

const User = require('../models/User');
const { publicUser } = require('./authController');

// Admin creates a new user (sales or admin).
async function createUser(req, res) {
  try {
    const { name, username, password, role, ownerEmail } = req.body || {};

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

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      username: uname,
      passwordHash,
      role: roleVal,
      ownerEmail: ownerEmail ? String(ownerEmail).toLowerCase() : null,
    });

    res.status(201).json({ success: true, user: publicUser(user) });
  } catch (err) {
    console.error('Create user failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create user' });
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

module.exports = { createUser, listUsers, deleteUser };
