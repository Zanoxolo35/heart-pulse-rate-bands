// Fake ESP32s: sends readings for the 4 demo devices so you can test the dashboard with no hardware.
//
//   npm run simulate                 -> normal readings with occasional episodes
//   npm run simulate -- --scenario=high   -> pushes ESP32-KZN-002 high to trigger a Vital Assist alert
//   npm run simulate -- --scenario=low    -> pushes ESP32-KZN-003 low to trigger a Vital Care alert
//
// Uses the same JSON and header as the real firmware, so if this works, the ESP32 will too.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 4000;
const URL = process.env.SIM_URL || `http://localhost:${PORT}/api/readings`;
const KEY = process.env.DEVICE_API_KEY || 'change-me-device-key';
const INTERVAL_MS = 2000;

const scenario = (process.argv.find((a) => a.startsWith('--scenario=')) || '').split('=')[1] || 'mixed';

// Each device has a resting pulse it wanders around
const devices = [
  { id: 'ESP32-KZN-001', rest: 72, bpm: 72 },
  { id: 'ESP32-KZN-002', rest: 78, bpm: 78 },
  { id: 'ESP32-KZN-003', rest: 66, bpm: 66 },
  { id: 'ESP32-KZN-004', rest: 70, bpm: 70 },
];

let tick = 0;

function nextBpm(d) {
  // Random walk that drifts back to the resting rate
  d.bpm += (Math.random() - 0.5) * 6 + (d.rest - d.bpm) * 0.2;

  // Scripted episodes so alerts actually happen
  const high = scenario === 'high' || (scenario === 'mixed' && tick % 90 > 30 && tick % 90 < 45);
  const low = scenario === 'low' || (scenario === 'mixed' && tick % 120 > 70 && tick % 120 < 85);
  if (d.id === 'ESP32-KZN-002' && high) d.bpm = 118 + Math.random() * 10;
  if (d.id === 'ESP32-KZN-003' && low) d.bpm = 42 + Math.random() * 5;

  return Math.round(d.bpm);
}

async function send(d) {
  const noSignal = Math.random() < 0.02;   // now and then the "finger slips"
  const body = {
    device_id: d.id,
    pulse_rate: noSignal ? 0 : nextBpm(d),
    finger_detected: !noSignal,
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': KEY },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const flag = json.alert_opened ? '  <-- ALERT OPENED' : '';
    console.log(`${d.id}  ${String(body.pulse_rate).padStart(3)} BPM  ${json.reading?.status ?? res.status}${flag}`);
  } catch (err) {
    console.error(`Can't reach ${URL}. Is the server running? (${err.message})`);
  }
}

console.log(`Simulating ${devices.length} devices -> ${URL}  (scenario: ${scenario}). Ctrl+C to stop.`);
setInterval(() => {
  tick++;
  devices.forEach(send);
}, INTERVAL_MS);
