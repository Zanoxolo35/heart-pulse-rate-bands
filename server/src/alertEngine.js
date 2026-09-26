// The alert engine: decides if a reading is LOW / NORMAL / HIGH and what to do about it.
//
// How it avoids false alarms:
//   - One odd reading (finger moved) does NOT raise an alert.
//   - It waits for ALERT_CONSECUTIVE_READINGS abnormal readings in a row (default 3).
//   - Exception: a CRITICAL reading (<= 40 or >= 140 BPM by default) alerts straight away.
//   - If a patient already has an open alert, it doesn't open a second one.
//
// What happens per tier when an alert fires:
//   MONITOR (Vital Monitor) -> SMS family contacts
//   ASSIST  (Vital Assist)  -> SMS family + assign and SMS a driver (transport request)
//   CARE    (Vital Care)    -> all of the above + assign and SMS a caregiver + set a follow-up time

const db = require('./db');
const config = require('./config');
const { broadcast } = require('./realtime');
const { sendSms, templates, levelWords } = require('./notifier');

// How many abnormal readings in a row each patient has had (kept in memory)
const abnormalStreak = new Map();

/** Classify one reading against the patient's own limits. */
function classify(bpm, fingerDetected, patient) {
  if (!fingerDetected || !bpm) return 'NO_SIGNAL';
  if (bpm < patient.pulse_low) return 'LOW';
  if (bpm > patient.pulse_high) return 'HIGH';
  return 'NORMAL';
}

function isCritical(bpm) {
  return bpm <= config.alerts.criticalLow || bpm >= config.alerts.criticalHigh;
}

// ---------- Prepared SQL ----------
const findOpenAlert = db.prepare(
  `SELECT id FROM alert_escalations WHERE patient_id = ? AND status != 'RESOLVED' LIMIT 1`);
const insertAlert = db.prepare(`
  INSERT INTO alert_escalations (patient_id, tier, trigger_status, trigger_bpm, is_critical, follow_up_due_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
const contactsFor = db.prepare(
  `SELECT * FROM emergency_contacts WHERE patient_id = ? ORDER BY is_primary DESC`);
// Prefer an available responder in the same region, otherwise any available one
const pickResponder = db.prepare(`
  SELECT * FROM responders WHERE role = ? AND is_available = 1
  ORDER BY (region = ?) DESC, id ASC LIMIT 1`);
const setResponderAvailability = db.prepare(`UPDATE responders SET is_available = ? WHERE id = ?`);
const assignDriver = db.prepare(`UPDATE alert_escalations SET assigned_driver_id = ? WHERE id = ?`);
const assignCaregiver = db.prepare(`UPDATE alert_escalations SET assigned_caregiver_id = ? WHERE id = ?`);

/**
 * Run the engine for one saved reading.
 * Returns the new alert (or null if no alert was opened).
 */
async function evaluate(patient, reading) {
  const { status, pulse_bpm: bpm } = reading;

  // Normal or no-signal readings reset the streak. (No signal is shown on the dashboard,
  // but it's usually a loose sensor, so it doesn't send SMS on its own.)
  if (status === 'NORMAL' || status === 'NO_SIGNAL') {
    abnormalStreak.set(patient.id, 0);
    return null;
  }

  const streak = (abnormalStreak.get(patient.id) || 0) + 1;
  abnormalStreak.set(patient.id, streak);

  const critical = isCritical(bpm);
  if (streak < config.alerts.consecutiveReadings && !critical) return null;
  if (findOpenAlert.get(patient.id)) return null;   // already being handled

  return openAlert(patient, status, bpm, critical);
}

async function openAlert(patient, triggerStatus, bpm, critical) {
  const followUp = patient.tier === 'CARE'
    ? new Date(Date.now() + config.alerts.followUpHours * 3600 * 1000).toISOString()
    : null;

  const alertId = insertAlert.run(patient.id, patient.tier, triggerStatus, bpm, critical ? 1 : 0, followUp).lastInsertRowid;
  console.log(`[alert] #${alertId} ${patient.full_name}: ${triggerStatus} ${bpm} BPM (tier ${patient.tier})`);

  // 1. Every tier: tell the family and clinic
  const lang = patient.preferred_language === 'en' ? 'en' : 'zu';
  const familyMsg = templates.family[lang](patient, bpm, levelWords[lang][triggerStatus]);
  for (const contact of contactsFor.all(patient.id)) {
    await sendSms({ alertId, name: contact.name, phone: contact.phone, message: familyMsg });
  }

  // 2. Vital Assist and Vital Care: request transport
  if (patient.tier === 'ASSIST' || patient.tier === 'CARE') {
    const driver = pickResponder.get('DRIVER', patient.region);
    if (driver) {
      assignDriver.run(driver.id, alertId);
      setResponderAvailability.run(0, driver.id);
      await sendSms({ alertId, name: driver.full_name, phone: driver.phone, message: templates.driver(patient, bpm) });
    } else {
      console.warn(`[alert] #${alertId}: no driver available - operator must arrange transport`);
    }
  }

  // 3. Vital Care: send a caregiver as well
  if (patient.tier === 'CARE') {
    const caregiver = pickResponder.get('CAREGIVER', patient.region);
    if (caregiver) {
      assignCaregiver.run(caregiver.id, alertId);
      setResponderAvailability.run(0, caregiver.id);
      await sendSms({ alertId, name: caregiver.full_name, phone: caregiver.phone, message: templates.caregiver(patient, bpm) });
    } else {
      console.warn(`[alert] #${alertId}: no caregiver available - operator must assign one`);
    }
  }

  const alert = getAlertById(alertId);
  broadcast('alert', alert);
  return alert;
}

// Full alert row with patient + responder names (used by the API and the dashboard)
const alertSelect = `
  SELECT a.*, p.full_name AS patient_name, p.region, p.address,
         d.full_name AS driver_name, d.phone AS driver_phone,
         c.full_name AS caregiver_name, c.phone AS caregiver_phone
  FROM alert_escalations a
  JOIN patients p ON p.id = a.patient_id
  LEFT JOIN responders d ON d.id = a.assigned_driver_id
  LEFT JOIN responders c ON c.id = a.assigned_caregiver_id`;

function getAlertById(id) {
  return db.prepare(`${alertSelect} WHERE a.id = ?`).get(id);
}

module.exports = { classify, evaluate, getAlertById, alertSelect, setResponderAvailability };
