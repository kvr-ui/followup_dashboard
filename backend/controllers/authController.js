const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const { SECRET } = require('../middleware/auth');

function publicUser(u) {
  return {
    id: u._id,
    name: u.name,
    username: u.username,
    role: u.role,
    ownerEmail: u.ownerEmail,
    email: u.email,
  };
}

// Both password and Google sign-in issue identical tokens.
function issueToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, SECRET, {
    expiresIn: '30d',
  });
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

    const token = issueToken(user);

    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
}

// Public: tells the frontend which Google client ID to use (read per request,
// since one image serves beta and prod with the ID supplied at runtime).
function config(req, res) {
  res.json({ success: true, googleClientId: process.env.GOOGLE_CLIENT_ID || null });
}

// Sign in an existing user with a Google Identity Services ID token.
// Users are never auto-created.
async function googleLogin(req, res) {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res
        .status(503)
        .json({ success: false, message: 'Google sign-in is not configured' });
    }

    const { credential } = req.body || {};
    if (typeof credential !== 'string' || !credential.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'Google credential is required' });
    }

    let payload;
    try {
      const ticket = await new OAuth2Client(clientId).verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid Google credential' });
    }
    if (!payload) {
      return res.status(401).json({ success: false, message: 'Invalid Google credential' });
    }

    if (!payload.email_verified || !payload.email) {
      return res
        .status(403)
        .json({ success: false, message: 'Google email is not verified' });
    }

    const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN;
    if (
      allowedDomain &&
      String(payload.hd || '').toLowerCase() !== allowedDomain.trim().toLowerCase()
    ) {
      return res
        .status(403)
        .json({ success: false, message: 'This Google account is not allowed' });
    }

    const user = await User.findOne({ email: String(payload.email).toLowerCase() });
    if (!user) {
      return res
        .status(403)
        .json({ success: false, message: 'No account for this Google email — ask an admin' });
    }

    res.json({ success: true, token: issueToken(user), user: publicUser(user) });
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    res.status(500).json({ success: false, message: 'Google sign-in failed' });
  }
}

function me(req, res) {
  res.json({ success: true, user: publicUser(req.user) });
}

module.exports = { login, me, config, googleLogin, issueToken, publicUser };
