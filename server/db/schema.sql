-- Smart Vital Monitoring & Rapid Care - database schema (SQLite)
-- Runs automatically when the server starts. Safe to run more than once.
-- Moving to PostgreSQL/Supabase later? Swap INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL/IDENTITY
-- and datetime('now') -> now(). Everything else carries over.

PRAGMA foreign_keys = ON;

-- Elderly patients (the people wearing the device)
CREATE TABLE IF NOT EXISTS patients (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name          TEXT    NOT NULL,
  age                INTEGER CHECK (age > 0),
  address            TEXT,
  region             TEXT,                          -- KZN district, e.g. eThekwini, uMgungundlovu
  tier               TEXT    NOT NULL DEFAULT 'MONITOR'
                     CHECK (tier IN ('MONITOR', 'ASSIST', 'CARE')),
                     -- MONITOR = Vital Monitor (Level 1, alerts family only)
                     -- ASSIST  = Vital Assist  (Level 2, + transport)
                     -- CARE    = Vital Care    (Level 3, + caregiver and follow-up)
  device_id          TEXT    UNIQUE,                -- matches DEVICE_ID on the ESP32
  pulse_low          INTEGER NOT NULL DEFAULT 50,   -- personal baseline: below this = LOW
  pulse_high         INTEGER NOT NULL DEFAULT 100,  -- above this = HIGH
  preferred_language TEXT    NOT NULL DEFAULT 'zu' CHECK (preferred_language IN ('en', 'zu')),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (pulse_low < pulse_high)
);

-- Family members and local clinics to notify
CREATE TABLE IF NOT EXISTS emergency_contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  relationship  TEXT,                               -- e.g. Daughter, Neighbour, Clinic
  phone         TEXT    NOT NULL,                   -- international format: +27...
  contact_type  TEXT    NOT NULL DEFAULT 'FAMILY' CHECK (contact_type IN ('FAMILY', 'CLINIC')),
  is_primary    INTEGER NOT NULL DEFAULT 0
);

-- Response team: drivers (Level 2+) and caregivers (Level 3)
CREATE TABLE IF NOT EXISTS responders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('DRIVER', 'CAREGIVER')),
  region        TEXT,
  is_available  INTEGER NOT NULL DEFAULT 1
);

-- Every reading the device sends
CREATE TABLE IF NOT EXISTS pulse_readings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  pulse_bpm    INTEGER,                              -- NULL when there's no signal
  status       TEXT    NOT NULL CHECK (status IN ('LOW', 'NORMAL', 'HIGH', 'NO_SIGNAL')),
  recorded_at  TEXT    NOT NULL,                     -- device time (or server time as fallback)
  received_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_readings_patient_time ON pulse_readings (patient_id, recorded_at);

-- Alerts and how far along the response is
CREATE TABLE IF NOT EXISTS alert_escalations (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id             INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  tier                   TEXT    NOT NULL CHECK (tier IN ('MONITOR', 'ASSIST', 'CARE')), -- tier at the time of the alert
  trigger_status         TEXT    NOT NULL CHECK (trigger_status IN ('LOW', 'HIGH')),
  trigger_bpm            INTEGER NOT NULL,
  is_critical            INTEGER NOT NULL DEFAULT 0,  -- very high/low reading, skipped the wait
  status                 TEXT    NOT NULL DEFAULT 'TRIGGERED'
                         CHECK (status IN ('TRIGGERED', 'CONTACTED', 'TRANSPORT_DISPATCHED', 'RESOLVED')),
  assigned_driver_id     INTEGER REFERENCES responders(id) ON DELETE SET NULL,
  assigned_caregiver_id  INTEGER REFERENCES responders(id) ON DELETE SET NULL,
  follow_up_due_at       TEXT,                         -- Vital Care only
  notes                  TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alert_escalations (status);

-- Record of every SMS sent (or simulated)
CREATE TABLE IF NOT EXISTS notification_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id         INTEGER REFERENCES alert_escalations(id) ON DELETE CASCADE,
  recipient_name   TEXT,
  recipient_phone  TEXT NOT NULL,
  message          TEXT NOT NULL,
  provider         TEXT NOT NULL,                      -- SIMULATED or AFRICASTALKING
  delivery_status  TEXT NOT NULL,                      -- SENT, FAILED, SIMULATED
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
