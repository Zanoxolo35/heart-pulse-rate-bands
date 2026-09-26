// Sends SMS alerts. By default it only SIMULATES (prints to the console and saves to notification_log),
// so you can test everything without paying for SMS. Set SMS_PROVIDER=africastalking in .env to go live.
const db = require('./db');
const config = require('./config');

const logStmt = db.prepare(`
  INSERT INTO notification_log (alert_id, recipient_name, recipient_phone, message, provider, delivery_status)
  VALUES (?, ?, ?, ?, ?, ?)`);

// Africa's Talking SMS API (needs Node 18+ for built-in fetch)
async function sendViaAfricasTalking(phone, message) {
  const { atUsername, atApiKey, atSenderId, atSandbox } = config.sms;
  const host = atSandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';

  const body = new URLSearchParams({ username: atUsername, to: phone, message });
  if (atSenderId) body.append('from', atSenderId);

  const response = await fetch(`${host}/version1/messaging`, {
    method: 'POST',
    headers: {
      apiKey: atApiKey,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) throw new Error(`Africa's Talking replied ${response.status}: ${await response.text()}`);
  return response.json();
}

// Send one SMS and record it. Never throws - a failed SMS must not crash the alert engine.
async function sendSms({ alertId, name, phone, message }) {
  const provider = config.sms.provider === 'africastalking' ? 'AFRICASTALKING' : 'SIMULATED';
  let status = 'SIMULATED';

  try {
    if (provider === 'AFRICASTALKING') {
      await sendViaAfricasTalking(phone, message);
      status = 'SENT';
    } else {
      console.log(`[sms:simulated] to ${name} (${phone}): ${message}`);
    }
  } catch (err) {
    status = 'FAILED';
    console.error(`[sms] Failed to send to ${phone}:`, err.message);
  }

  logStmt.run(alertId, name, phone, message, provider, status);
  return status;
}

// Short messages in the recipient's language. Kept under 160 characters where possible (1 SMS).
const templates = {
  family: {
    en: (p, bpm, level) => `VitalCare ALERT: ${p.full_name}'s pulse is ${level} (${bpm} BPM). Please check on her now. Reply or call the response team.`,
    zu: (p, bpm, level) => `VitalCare ISEXWAYISO: Ukushaya kwenhliziyo ka-${p.full_name} ${level} (${bpm} BPM). Sicela umhlole manje.`,
  },
  driver: (p, bpm) => `VitalCare TRANSPORT: Pick up ${p.full_name}, ${p.address}. Pulse ${bpm} BPM. Confirm on the dashboard.`,
  caregiver: (p, bpm) => `VitalCare CAREGIVER: Visit ${p.full_name}, ${p.address}. Pulse ${bpm} BPM. Follow-up needed.`,
};

const levelWords = {
  en: { LOW: 'LOW', HIGH: 'HIGH' },
  zu: { LOW: 'kuphansi', HIGH: 'kuphezulu' },
};

module.exports = { sendSms, templates, levelWords };
