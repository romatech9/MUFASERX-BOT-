// ============================================================
// MUFASER-X — PRIVATE PAIRING SERVER CONFIG
// WhatsApp Multi-Device Bot by ROMA-TECH
// ============================================================

require('dotenv').config();

module.exports = {
  botName: 'MUFASER-X',
  developer: 'ROMA-TECH',
  version: '1.0.0',

  // Render provides PORT automatically
  port: process.env.PORT || 3000,

  // Optional owner number
  ownerNumber: String(process.env.OWNER_NUMBER || '')
    .replace(/\D/g, ''),

  // Private server API protection
  apiKey: process.env.PRIVATE_API_KEY || '',

  // Session prefix
  sessionPrefix: 'MUFASER-X:~',

  // Session storage
  sessionsDir: './sessions',

  // Automatically reconnect while generating the session
  autoReconnect: true
};