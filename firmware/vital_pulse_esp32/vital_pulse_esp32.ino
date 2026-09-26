/*
 * Smart Vital Monitoring - ESP32 pulse firmware
 * ---------------------------------------------
 * Board:  ESP32 DevKit (ESP-WROOM-32)  -> no Arduino Uno needed, the ESP32 has Wi-Fi built in
 * Sensor: Analog "Heart Pulse Rate" module (3 pins: S / + / -)
 *
 * WIRING (power the sensor from 3.3V, NOT 5V - the ESP32 pins only handle 3.3V)
 *   Sensor  +  (VCC)    -> ESP32 3V3
 *   Sensor  -  (GND)    -> ESP32 GND
 *   Sensor  S  (signal) -> ESP32 GPIO34   (an ADC1 pin - ADC2 pins stop working when Wi-Fi is on)
 *
 * WHAT IT DOES
 *   1. Samples the sensor every 10 ms.
 *   2. Finds heartbeats using an adaptive threshold (it follows the signal's own peaks and dips).
 *   3. Averages the last few beat-to-beat gaps into a BPM value.
 *   4. Every SEND_INTERVAL_MS it POSTs JSON to the backend:
 *        { "device_id": "...", "pulse_rate": 72, "finger_detected": true, "timestamp": "2026-09-26T10:15:00+02:00" }
 *
 * BEFORE UPLOADING
 *   - Copy secrets.example.h to secrets.h (same folder) and fill in your Wi-Fi + server details.
 *   - Tools > Board: "ESP32 Dev Module"  (install "esp32 by Espressif" in Boards Manager first)
 *   - Open Serial Monitor at 115200 baud to watch what's happening.
 *
 * NOTE: A hobby pulse sensor is fine for a prototype, but it's not a medical device.
 *       Readings jump around if the finger moves or presses too hard.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, SERVER_URL, DEVICE_ID, DEVICE_API_KEY

// ---------- Settings you can tweak ----------
const int      PULSE_PIN          = 34;     // sensor signal pin (ADC1)
const int      LED_PIN            = 2;      // on-board LED blinks on each beat
const uint32_t SAMPLE_INTERVAL_MS = 10;     // 100 samples per second
const uint32_t SEND_INTERVAL_MS   = 5000;   // send a reading every 5 seconds
const uint32_t NO_BEAT_TIMEOUT_MS = 4000;   // no beat for 4 s = finger probably off
const int      MIN_AMPLITUDE      = 120;    // weaker signal than this = no finger (0..4095 scale)
const int      IBI_HISTORY        = 6;      // how many beat gaps to average

// ---------- Beat detection state ----------
int      smoothBuf[4] = {0};  // tiny moving average to clean up noise
int      smoothIdx = 0;
float    peak = 2048, trough = 2048;   // running high and low of the signal
bool     aboveThreshold = false;
uint32_t lastBeatMs = 0;
uint32_t ibi[IBI_HISTORY] = {0};       // inter-beat intervals (ms)
int      ibiCount = 0, ibiIdx = 0;

uint32_t lastSampleMs = 0;
uint32_t lastSendMs   = 0;

// ------------------------------------------------------------
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to Wi-Fi '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected. ESP32 IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWi-Fi failed. Will retry on the next send.");
  }
}

// Returns an ISO time string like 2026-09-26T10:15:00+02:00, or "" if the clock isn't set yet.
// If it's empty, the server just uses the time it received the reading.
String isoTimestamp() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "";
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S+02:00", &t);  // South Africa is UTC+2
  return String(buf);
}

// Average of the stored beat gaps -> beats per minute. 0 means "not enough data".
int currentBpm() {
  if (ibiCount < 3) return 0;
  uint32_t sum = 0;
  for (int i = 0; i < ibiCount; i++) sum += ibi[i];
  return (int)(60000UL / (sum / ibiCount));
}

void resetBeats() {
  ibiCount = 0;
  ibiIdx = 0;
}

// Called every SAMPLE_INTERVAL_MS
void samplePulse() {
  int raw = analogRead(PULSE_PIN);            // 0..4095 on the ESP32

  // 1. Smooth: average of the last 4 samples
  smoothBuf[smoothIdx] = raw;
  smoothIdx = (smoothIdx + 1) % 4;
  int value = (smoothBuf[0] + smoothBuf[1] + smoothBuf[2] + smoothBuf[3]) / 4;

  // 2. Track the signal's peak and trough, letting both slowly drift back toward the signal
  if (value > peak) peak = value; else peak -= 1.5;
  if (value < trough) trough = value; else trough += 1.5;
  if (trough > peak) trough = peak;

  float amplitude = peak - trough;
  float threshold = trough + amplitude * 0.6;  // a beat = signal rises past 60% of its range
  float hysteresis = amplitude * 0.1;          // stops one noisy beat counting twice

  uint32_t now = millis();

  // 3. Detect a rising edge through the threshold = one heartbeat
  if (!aboveThreshold && value > threshold + hysteresis && amplitude > MIN_AMPLITUDE) {
    aboveThreshold = true;
    uint32_t gap = now - lastBeatMs;

    // Only accept gaps that make sense: 300 ms (200 BPM) to 2000 ms (30 BPM)
    if (lastBeatMs != 0 && gap >= 300 && gap <= 2000) {
      ibi[ibiIdx] = gap;
      ibiIdx = (ibiIdx + 1) % IBI_HISTORY;
      if (ibiCount < IBI_HISTORY) ibiCount++;
      digitalWrite(LED_PIN, HIGH);
    }
    if (gap >= 300 || lastBeatMs == 0) lastBeatMs = now;
  } else if (aboveThreshold && value < threshold - hysteresis) {
    aboveThreshold = false;
    digitalWrite(LED_PIN, LOW);
  }

  // 4. No beats for a while -> clear old data so we don't send a stale BPM
  if (lastBeatMs != 0 && now - lastBeatMs > NO_BEAT_TIMEOUT_MS) {
    resetBeats();
    lastBeatMs = 0;
  }
}

void sendReading() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

  int bpm = currentBpm();
  bool finger = bpm > 0;
  String ts = isoTimestamp();

  // Build the JSON by hand (keeps things simple - no extra library needed)
  String body = "{";
  body += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  body += "\"pulse_rate\":" + String(bpm) + ",";
  body += "\"finger_detected\":" + String(finger ? "true" : "false");
  if (ts.length() > 0) body += ",\"timestamp\":\"" + ts + "\"";
  body += "}";

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  http.setTimeout(4000);

  int code = http.POST(body);
  Serial.printf("Sent %s -> HTTP %d\n", body.c_str(), code);
  if (code > 0 && code != 201) Serial.println("Server said: " + http.getString());
  http.end();
}

// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  analogReadResolution(12);              // 0..4095
  analogSetAttenuation(ADC_11db);        // read the full 0..3.3V range

  connectWiFi();
  // Get the real time from the internet (South Africa = UTC+2, no daylight saving)
  configTime(2 * 3600, 0, "pool.ntp.org", "time.google.com");
  Serial.println("Place a finger gently on the sensor and keep still...");
}

void loop() {
  uint32_t now = millis();

  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    samplePulse();
  }

  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    sendReading();   // takes a moment; sampling pauses briefly while it sends
  }
}
