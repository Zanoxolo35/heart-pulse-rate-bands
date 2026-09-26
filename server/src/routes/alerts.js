// Emergency escalation queue + responders.
const express = require('express');
const db = require('../db');
const { alertSelect, getAlertById, setResponderAvailability } = require('../alertEngine');
const { broadcast } = require('../realtime');

const router = express.Router();

// Alerts can only move forward through these steps (or jump straight to RESOLVED)
const STEPS = ['TRIGGERED', 'CONTACTED', 'TRANSPORT_DISPATCHED', 'RESOLVED'];

// GET /api/alerts?status=open (default) | all | RESOLVED | TRIGGERED ...
router.get('/', (req, res) => {
  const filter = (req.query.status || 'open').toUpperCase();
  let rows;
  if (filter === 'ALL') {
    rows = db.prepare(`${alertSelect} ORDER BY a.created_at DESC LIMIT 200`).all();
  } else if (filter === 'OPEN') {
    // Most urgent first: critical, then oldest
    rows = db.prepare(`${alertSelect} WHERE a.status != 'RESOLVED' ORDER BY a.is_critical DESC, a.created_at ASC`).all();
  } else if (STEPS.includes(filter)) {
    rows = db.prepare(`${alertSelect} WHERE a.status = ? ORDER BY a.created_at DESC`).all(filter);
  } else {
    return res.status(400).json({ error: 'status must be open, all, or one of ' + STEPS.join(', ') });
  }
  res.json(rows);
});

// GET /api/alerts/:id/notifications - which SMS went out for this alert
router.get('/:id/notifications', (req, res) => {
  res.json(db.prepare('SELECT * FROM notification_log WHERE alert_id = ? ORDER BY id').all(req.params.id));
});

// PATCH /api/alerts/:id  body: { status?, notes?, assigned_driver_id?, assigned_caregiver_id? }
router.patch('/:id', (req, res) => {
  const alert = getAlertById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found.' });
  if (alert.status === 'RESOLVED') return res.status(409).json({ error: 'This alert is already resolved.' });

  const { status, notes, assigned_driver_id, assigned_caregiver_id } = req.body || {};
  const updates = {};

  if (status !== undefined) {
    if (!STEPS.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
    if (STEPS.indexOf(status) < STEPS.indexOf(alert.status)) {
      return res.status(400).json({ error: `Can't move an alert back from ${alert.status} to ${status}.` });
    }
    if (status === 'TRANSPORT_DISPATCHED' && alert.tier === 'MONITOR') {
      return res.status(400).json({ error: 'Transport is only part of Vital Assist and Vital Care.' });
    }
    updates.status = status;
  }
  if (notes !== undefined) updates.notes = String(notes).slice(0, 1000);
  if (assigned_driver_id !== undefined) updates.assigned_driver_id = assigned_driver_id || null;
  if (assigned_caregiver_id !== undefined) updates.assigned_caregiver_id = assigned_caregiver_id || null;
  if (!Object.keys(updates).length) return res.json(alert);

  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.transaction(() => {
    db.prepare(`UPDATE alert_escalations SET ${setClause}, updated_at = datetime('now')
                ${updates.status === 'RESOLVED' ? ", resolved_at = datetime('now')" : ''} WHERE id = @id`)
      .run({ ...updates, id: alert.id });

    // When resolved, the driver and caregiver become available again
    if (updates.status === 'RESOLVED') {
      const fresh = getAlertById(alert.id);
      if (fresh.assigned_driver_id) setResponderAvailability.run(1, fresh.assigned_driver_id);
      if (fresh.assigned_caregiver_id) setResponderAvailability.run(1, fresh.assigned_caregiver_id);
    }
  })();

  const updated = getAlertById(alert.id);
  broadcast('alert', updated);
  res.json(updated);
});

module.exports = router;
