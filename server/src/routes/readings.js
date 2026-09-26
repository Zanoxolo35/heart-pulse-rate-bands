// Device ingestion: the ESP32 (or the simulator) POSTs here.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { classify, evaluate } = require('../alertEngine');
const { broadcast } = require('../realtime');

const router = express.Router();

const findPatientByDevice = db.prepare('SELECT * FROM patients WHERE device_id = ?');
const insertReading = db.prepare(`
  INSERT INTO pulse_readings (patient_id, pulse_bpm, status, recorded_at) VALUES (?, ?, ?, ?)`);

// Only accept the device's clock if it looks sane (not missing, not far in the future)
function pickTimestamp(deviceTime) {
  const now = Date.now();
  const parsed = Date.parse(deviceTime);
  if (!deviceTime || Number.isNaN(parsed) || parsed > now + 5 * 60 * 1000) return new Date(now).toISOString();
  return new Date(parsed).toISOString();
}

// Simple shared-key check so random people can't post fake readings
function requireDeviceKey(req, res, next) {
  if (req.get('X-Device-Key') !== config.deviceApiKey) {
    return res.status(401).json({ error: 'Missing or wrong X-Device-Key header.' });
  }
  next();
}

/**
 * POST /api/readings
 * Body: { device_id: "ESP32-KZN-001", pulse_rate: 72, finger_detected: true, timestamp: "..." }
 */
router.post('/', requireDeviceKey, async (req, res) => {
  const { device_id, pulse_rate, timestamp } = req.body || {};
  const fingerDetected = req.body?.finger_detected !== false;   // assume true if not sent

  if (!device_id) return res.status(400).json({ error: 'device_id is required.' });
  const bpm = Number(pulse_rate);
  if (!Number.isFinite(bpm) || bpm < 0 || bpm > 250) {
    return res.status(400).json({ error: 'pulse_rate must be a number between 0 and 250.' });
  }

  const patient = findPatientByDevice.get(device_id);
  if (!patient) {
    return res.status(404).json({ error: `No patient has device_id "${device_id}". Add it to a patient first.` });
  }

  const status = classify(bpm, fingerDetected, patient);
  const recordedAt = pickTimestamp(timestamp);
  const storedBpm = status === 'NO_SIGNAL' ? null : Math.round(bpm);
  const id = insertReading.run(patient.id, storedBpm, status, recordedAt).lastInsertRowid;

  const reading = { id, patient_id: patient.id, pulse_bpm: storedBpm, status, recorded_at: recordedAt };
  broadcast('reading', reading);

  const alert = await evaluate(patient, reading);
  res.status(201).json({ reading, alert_opened: Boolean(alert) });
});

module.exports = router;
