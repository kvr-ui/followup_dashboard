const express = require('express');

const {
  getTasks,
  getTask,
  updateStatus,
  addNote,
  sendWhatsapp,
} = require('../controllers/taskController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Any logged-in user; controllers enforce role-based access.
router.use(authenticate);

router.get('/', getTasks);
router.get('/:id', getTask);
router.patch('/:id/status', updateStatus);
router.post('/:id/notes', addNote);
router.post('/:id/whatsapp', sendWhatsapp);

module.exports = router;
