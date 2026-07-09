const express = require('express');

const { createUser, listUsers, deleteUser } = require('../controllers/userController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All user-management routes are admin-only.
router.use(authenticate, requireAdmin);

router.get('/', listUsers);
router.post('/', createUser);
router.delete('/:id', deleteUser);

module.exports = router;
