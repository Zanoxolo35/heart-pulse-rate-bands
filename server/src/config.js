// All settings in one place, read from .env (with safe defaults so it runs out of the box)
require('dotenv').config();

const num = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  port: num(process.env.PORT, 4000),
  deviceApiKey: process.env.DEVICE_API_KEY || 'change-me-device-key',
  dbFile: process.env.DB_FILE || './data/vitalcare.db',

  alerts: {
    consecutiveReadings: num(process.env.ALERT_CONSECUTIVE_READINGS, 3),
    criticalLow: num(process.env.CRITICAL_LOW_BPM, 40),
    criticalHigh: num(process.env.CRITICAL_HIGH_BPM, 140),
    followUpHours: num(process.env.FOLLOW_UP_HOURS, 24),
  },

  sms: {
    provider: (process.env.SMS_PROVIDER || 'simulated').toLowerCase(),
    atUsername: process.env.AT_USERNAME || 'sandbox',
    atApiKey: process.env.AT_API_KEY || '',
    atSenderId: process.env.AT_SENDER_ID || '',
    atSandbox: (process.env.AT_SANDBOX || 'true') === 'true',
  },
};
