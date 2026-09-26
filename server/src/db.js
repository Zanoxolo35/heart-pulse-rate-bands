// Opens the SQLite database, creates the tables, and adds demo data the first time.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbPath = path.resolve(__dirname, '..', config.dbFile);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');   // faster writes, safe reads while writing
db.pragma('foreign_keys = ON');

// Create tables from schema.sql
const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// ---------- Demo data (only added when the database is empty) ----------
function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM patients').get();
  if (count > 0) return;

  const addPatient = db.prepare(`
    INSERT INTO patients (full_name, age, address, region, tier, device_id, pulse_low, pulse_high, preferred_language)
    VALUES (@full_name, @age, @address, @region, @tier, @device_id, @pulse_low, @pulse_high, @preferred_language)`);
  const addContact = db.prepare(`
    INSERT INTO emergency_contacts (patient_id, name, relationship, phone, contact_type, is_primary)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const addResponder = db.prepare(`
    INSERT INTO responders (full_name, phone, role, region) VALUES (?, ?, ?, ?)`);

  // Phone numbers below are placeholders - replace with real test numbers.
  const seed = db.transaction(() => {
    const p1 = addPatient.run({ full_name: 'Nomvula Dlamini', age: 78, address: 'Section V, Umlazi', region: 'eThekwini',
      tier: 'MONITOR', device_id: 'ESP32-KZN-001', pulse_low: 50, pulse_high: 100, preferred_language: 'zu' }).lastInsertRowid;
    const p2 = addPatient.run({ full_name: 'Thembeka Mkhize', age: 82, address: 'Edendale, Pietermaritzburg', region: 'uMgungundlovu',
      tier: 'ASSIST', device_id: 'ESP32-KZN-002', pulse_low: 55, pulse_high: 100, preferred_language: 'zu' }).lastInsertRowid;
    const p3 = addPatient.run({ full_name: 'Zanele Ngcobo', age: 71, address: 'Shakaskraal, KwaDukuza', region: 'iLembe',
      tier: 'CARE', device_id: 'ESP32-KZN-003', pulse_low: 50, pulse_high: 95, preferred_language: 'en' }).lastInsertRowid;
    const p4 = addPatient.run({ full_name: 'Busisiwe Zulu', age: 85, address: 'Ngwelezane, Empangeni', region: 'King Cetshwayo',
      tier: 'CARE', device_id: 'ESP32-KZN-004', pulse_low: 50, pulse_high: 100, preferred_language: 'zu' }).lastInsertRowid;

    addContact.run(p1, 'Sipho Dlamini', 'Son', '+27800000101', 'FAMILY', 1);
    addContact.run(p1, 'Umlazi Mega City Clinic', 'Clinic', '+27800000102', 'CLINIC', 0);
    addContact.run(p2, 'Lindiwe Mkhize', 'Daughter', '+27800000201', 'FAMILY', 1);
    addContact.run(p2, 'Edendale Clinic', 'Clinic', '+27800000202', 'CLINIC', 0);
    addContact.run(p3, 'Ayanda Ngcobo', 'Granddaughter', '+27800000301', 'FAMILY', 1);
    addContact.run(p4, 'Mandla Zulu', 'Son', '+27800000401', 'FAMILY', 1);
    addContact.run(p4, 'Ngwelezane Clinic', 'Clinic', '+27800000402', 'CLINIC', 0);

    addResponder.run('Bongani Khumalo', '+27800000901', 'DRIVER', 'eThekwini');
    addResponder.run('Sifiso Mthembu', '+27800000902', 'DRIVER', 'uMgungundlovu');
    addResponder.run('Nokuthula Shange', '+27800000903', 'CAREGIVER', 'iLembe');
    addResponder.run('Precious Cele', '+27800000904', 'CAREGIVER', 'King Cetshwayo');
    addResponder.run('Themba Ntuli', '+27800000905', 'DRIVER', 'iLembe');
  });
  seed();
  console.log('[db] Demo data added (4 patients, 5 responders).');
}

seedIfEmpty();

module.exports = db;
