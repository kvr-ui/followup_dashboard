const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { SECRET } = require('../middleware/auth');

function publicUser(u) {
  return {
    id: u._id,
    name: u.name,
    username: u.username,
    role: u.role,
    ownerEmail: u.ownerEmail,
  };
}

async function login(req, res) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Username and password are required' });
    }

    const user = await User.findOne({ username: String(username).toLowerCase() });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: user._id.toString(), role: user.role }, SECRET, {
      expiresIn: '30d',
    });

    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
}

function me(req, res) {
  res.json({ success: true, user: publicUser(req.user) });
}

module.exports = { login, me, publicUser };
