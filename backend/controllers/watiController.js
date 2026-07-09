const wati = require('../services/wati');

async function getTemplates(req, res) {
  const result = await wati.getTemplates();
  res.json({
    success: true,
    configured: wati.isConfigured(),
    templates: result.templates || [],
    error: result.error || null,
  });
}

module.exports = { getTemplates };
