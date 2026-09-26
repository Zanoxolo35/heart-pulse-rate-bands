// CRUD for patients, their emergency contacts, and reading history.
const express = require('express');
const db = require('../db');
const { broadcast } = require('../realtime');

const router = express.Router();
const TIERS = ['MONITOR', 'ASSIST', 'CARE'];

// Patient + their latest reading in one query
const listPatients = db.prepare(`
  SELECT p.*,
         r.pulse_bpm   AS last_bpm,
         r.status      AS last_status,
         r.recorded_at AS last_reading_at,
         (SELECT COUNT(*) FROM alert_escalations a WHERE a.patient_id = p.id AND a.status != 'RESOLVED') AS open_alerts
  FROM patients p
  LEFT JOIN pulse_readings r ON r.id = (
    SELECT id FROM pulse_readings WHERE patient_id = p.id ORDER BY recorded_at DESC, id DESC LIMIT 1)
  ORDER BY p.full_name`);

const getPatient = db.prepare('SELECT * FROM patients WHERE id = ?');
const getContacts = db.prepare('SELECT * FROM emergency_contacts WHERE patient_id = ? ORDER BY is_primary DESC, id');

function validatePatient(body, partial = false) {
  const errors = [];
  if (!partial || body.full_name !== undefined) {
    if (!body.full_name || !String(body.full_name).trim()) errors.push('full_name is required.');
  }
  if (body.tier !== undefined && !TIERS.includes(body.tier)) errors.push(`tier must be one of ${TIERS.join(', ')}.`);
  if (body.preferred_language !== undefined && !['en', 'zu'].includes(body.preferred_language)) errors.push('preferred_language must be en or zu.');
  const low = body.pulse_low, high = body.pulse_high;
  if (low !== undefined && high !== undefined && Number(low) >= Number(high)) errors.push('pulse_low must be lower than pulse_high.');
  return errors;
}

// GET /api/patients
router.get('/', (req, res) => res.json(listPatients.all()));

// GET /api/patients/:id  (includes contacts)
router.get('/:id', (req, res) => {
  const patient = getPatient.get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  res.json({ ...patient, contacts: getContacts.all(patient.id) });
});

// POST /api/patients
router.post('/', (req, res) => {
  const errors = validatePatient(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const p = { tier: 'MONITOR', pulse_low: 50, pulse_high: 100, preferred_language: 'zu', age: null, address: null, region: null, device_id: null, ...req.body };
  try {
    const id = db.prepare(`
      INSERT INTO patients (full_name, age, address, region, tier, device_id, pulse_low, pulse_high, preferred_language)
      VALUES (@full_name, @age, @address, @region, @tier, @device_id, @pulse_low, @pulse_high, @preferred_language)`).run(p).lastInsertRowid;
    const created = getPatient.get(id);
    broadcast('patient', created);
    res.status(201).json(created);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That device_id is already linked to another patient.' });
    throw err;
  }
});

// PATCH /api/patients/:id  (e.g. { "tier": "CARE" } to switch subscription level)
router.patch('/:id', (req, res) => {
  const existing = getPatient.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Patient not found.' });

  const allowed = ['full_name', 'age', 'address', 'region', 'tier', 'device_id', 'pulse_low', 'pulse_high', 'preferred_language'];
  const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const merged = { ...existing, ...changes };
  const errors = validatePatient(merged, true);
  if (errors.length) return res.status(400).json({ errors });
  if (!Object.keys(changes).length) return res.json(existing);

  const setClause = Object.keys(changes).map((k) => `${k} = @${k}`).join(', ');
  try {
    db.prepare(`UPDATE patients SET ${setClause} WHERE id = @id`).run({ ...changes, id: existing.id });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That device_id is already linked to another patient.' });
    throw err;
  }
  const updated = getPatient.get(existing.id);
  broadcast('patient', updated);
  res.json(updated);
});

// DELETE /api/patients/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM patients WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Patient not found.' });
  broadcast('patient', { id: Number(req.params.id), deleted: true });
  res.status(204).end();
});

// GET /api/patients/:id/readings?limit=60  (newest last, ready for a chart)
router.get('/:id/readings', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 1000);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM pulse_readings WHERE patient_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?
    ) ORDER BY recorded_at ASC, id ASC`).all(req.params.id, limit);
  res.json(rows);
});

// POST /api/patients/:id/contacts
router.post('/:id/contacts', (req, res) => {
  const { name, relationship = null, phone, contact_type = 'FAMILY', is_primary = 0 } = req.body || {};
  if (!getPatient.get(req.params.id)) return res.status(404).json({ error: 'Patient not found.' });
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required.' });
  if (!/^\+?\d{9,15}$/.test(String(phone).replace(/\s/g, ''))) return res.status(400).json({ error: 'phone should look like +27821234567.' });
  const id = db.prepare(`
    INSERT INTO emergency_contacts (patient_id, name, relationship, phone, contact_type, is_primary)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.params.id, name, relationship, String(phone).replace(/\s/g, ''), contact_type, is_primary ? 1 : 0).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM emergency_contacts WHERE id = ?').get(id));
});

// DELETE /api/patients/:id/contacts/:contactId
router.delete('/:id/contacts/:contactId', (req, res) => {
  const info = db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND patient_id = ?').run(req.params.contactId, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Contact not found.' });
  res.status(204).end();
});

module.exports = router;
