# Smart Vital Monitoring & Rapid Care for Elderly Women (KZN)

A wearable pulse monitor (ESP32 + pulse sensor) that sends readings to a Node.js server. The server checks each reading, sends SMS alerts based on the patient's plan, and shows everything live on a web dashboard in English and isiZulu.

> Prototype for coursework. A hobby pulse sensor is not a medical device.

## How the parts talk to each other

```
 ┌──────────────────────┐   HTTP POST (JSON) every 5 s     ┌───────────────────────────────┐
 │ ESP32 + pulse sensor │ ───────────────────────────────▶ │  Node.js / Express server     │
 │ (or simulate-device) │   X-Device-Key header             │                               │
 └──────────────────────┘                                   │  1. Save reading (SQLite)     │
                                                            │  2. Classify LOW/NORMAL/HIGH  │
                                                            │  3. Alert engine (per tier)   │──▶ SMS (simulated or
                                                            │  4. Push live event (SSE)     │    Africa's Talking)
                                                            └──────────────┬────────────────┘
                                                                           │ /api/stream (live)
                                                                           │ /api/... (REST)
                                                                           ▼
                                                            ┌───────────────────────────────┐
                                                            │  Web dashboard (browser)      │
                                                            │  patients · live chart ·      │
                                                            │  alert queue · plan switch    │
                                                            └───────────────────────────────┘
```

What happens when a reading comes in:

1. The ESP32 sends `{ device_id, pulse_rate, finger_detected, timestamp }` to `POST /api/readings`.
2. The server finds the patient linked to that `device_id` and compares the BPM to **her own** limits (default below 50 = LOW, above 100 = HIGH).
3. The reading is saved and pushed live to every open dashboard.
4. The alert engine waits for **3 bad readings in a row** before alerting (one bad reading is usually a moved finger). A **critical** reading (40 or below, 140 or above) alerts straight away.
5. What the alert does depends on the plan:

| Plan | Level | When an alert fires |
|---|---|---|
| Vital Monitor | 1 | SMS to family and clinic |
| Vital Assist | 2 | Level 1 + a driver is assigned and gets an SMS (transport) |
| Vital Care | 3 | Level 2 + a caregiver is assigned, gets an SMS, and a follow-up time is set |

6. The operator moves the alert along on the dashboard: Alert → Family contacted → Transport sent → Resolved. Resolving frees the driver and caregiver again.

## Folder layout

```
vital-care/
├── firmware/
│   ├── sensor_test/sensor_test.ino          # step 1: check wiring in Serial Plotter
│   └── vital_pulse_esp32/
│       ├── vital_pulse_esp32.ino            # main firmware
│       └── secrets.example.h                # copy to secrets.h
└── server/
    ├── db/schema.sql                        # database tables
    ├── src/
    │   ├── server.js                        # starts everything
    │   ├── config.js                        # reads .env
    │   ├── db.js                            # opens DB + demo data
    │   ├── alertEngine.js                   # thresholds + escalation rules
    │   ├── notifier.js                      # SMS (simulated / Africa's Talking)
    │   ├── realtime.js                      # live updates (Server-Sent Events)
    │   └── routes/ readings.js, patients.js, alerts.js
    ├── public/ index.html, styles.css, app.js, i18n.js   # the dashboard
    └── tools/ simulate-device.js, reset-db.js
```

## Part A: run the dashboard with fake data (no hardware)

You need Node.js 20 or 22 (LTS). Check with `node -v`.

```bash
cd server
copy .env.example .env        # Windows   (Mac/Linux: cp .env.example .env)
npm install
npm start
```

Open http://localhost:4000. You'll see 4 demo patients with no readings yet.

In a **second terminal**:

```bash
cd server
npm run simulate                      # mixed: mostly normal, with a high and a low episode now and then
npm run simulate -- --scenario=high   # Thembeka (Vital Assist) goes high -> driver assigned
npm run simulate -- --scenario=low    # Zanele (Vital Care) goes low -> driver + caregiver assigned
```

Watch the chart move, the alert appear, and the simulated SMS messages print in the server terminal. To start fresh: stop the server, run `npm run reset-db`, then `npm start`.

## Part B: the real hardware

You only need the **ESP32**. The Arduino Uno isn't needed, because the ESP32 already has Wi-Fi and can read the sensor itself.

**Wiring (power the sensor from 3.3V, not 5V):**

| Pulse sensor pin | ESP32 pin |
|---|---|
| `+` (VCC) | `3V3` |
| `-` (GND) | `GND` |
| `S` (signal) | `GPIO34` |

Use GPIO34 (or 32, 33, 35, 36, 39). Those are ADC1 pins. The ADC2 pins stop working while Wi-Fi is on.

**Steps:**

1. Arduino IDE → Boards Manager → install **esp32 by Espressif**. Select **ESP32 Dev Module** and the right COM port.
2. Upload `firmware/sensor_test`, open **Tools → Serial Plotter** (115200), rest a fingertip gently on the sensor. You want a wave that bumps with each heartbeat. Flat line = check wiring.
3. Find your laptop's IP: run `ipconfig` and look for **IPv4 Address** (e.g. 192.168.1.50). The laptop and ESP32 must be on the same Wi-Fi.
4. In `firmware/vital_pulse_esp32`, copy `secrets.example.h` to `secrets.h`. Fill in Wi-Fi, `SERVER_URL` with your laptop's IP, and the same `DEVICE_API_KEY` as in `server/.env`.
5. Upload `vital_pulse_esp32`. The Serial Monitor shows each send and the HTTP code. `201` means it worked.
6. The reading shows up under Nomvula Dlamini (device `ESP32-KZN-001`). Change the device ID in `secrets.h` to test another patient.

If the ESP32 gets no response, Windows Firewall is usually blocking port 4000. Allow Node.js on private networks when Windows asks, or add an inbound rule for port 4000.

## Sending real SMS (optional)

1. Create an Africa's Talking account and use the **sandbox** first.
2. In `.env`: `SMS_PROVIDER=africastalking`, `AT_USERNAME=sandbox`, `AT_API_KEY=<your key>`, `AT_SANDBOX=true`.
3. Replace the placeholder `+278000...` numbers with real test numbers (sandbox messages show in their simulator).

Every SMS, sent or simulated, is saved in the `notification_log` table and available at `GET /api/alerts/:id/notifications`.

## API reference

| Method | Path | What it does |
|---|---|---|
| POST | `/api/readings` | Device sends a reading (needs `X-Device-Key`) |
| GET | `/api/patients` | All patients with their latest reading |
| GET | `/api/patients/:id` | One patient + emergency contacts |
| POST | `/api/patients` | Add a patient |
| PATCH | `/api/patients/:id` | Update, e.g. `{ "tier": "CARE" }` |
| DELETE | `/api/patients/:id` | Remove a patient |
| GET | `/api/patients/:id/readings?limit=60` | Reading history (oldest first) |
| POST | `/api/patients/:id/contacts` | Add an emergency contact |
| DELETE | `/api/patients/:id/contacts/:contactId` | Remove a contact |
| GET | `/api/alerts?status=open` | Open alerts (also `all`, `RESOLVED`, ...) |
| PATCH | `/api/alerts/:id` | Move status, add notes, assign responders |
| GET | `/api/alerts/:id/notifications` | SMS sent for that alert |
| GET | `/api/responders?role=DRIVER` | Drivers and caregivers |
| GET | `/api/stream` | Live events: `reading`, `alert`, `patient` |
| GET | `/api/health` | Quick "is the server up" check |

Test the device endpoint without hardware:

```bash
curl -X POST http://localhost:4000/api/readings -H "Content-Type: application/json" -H "X-Device-Key: change-me-device-key" -d "{\"device_id\":\"ESP32-KZN-001\",\"pulse_rate\":130}"
```

## Before this goes beyond a prototype

- The dashboard has no login yet. Add operator accounts before putting it online.
- Use HTTPS, and give each device its own key instead of one shared key.
- Get a first-language speaker to review the isiZulu labels and SMS text.
- Moving to Supabase/PostgreSQL: `schema.sql` carries over with small changes (noted at the top of the file).
