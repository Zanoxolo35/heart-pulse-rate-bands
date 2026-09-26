/*
 * Step 1 wiring check - run this BEFORE the main firmware.
 * Upload, then open Tools > Serial Plotter (115200 baud).
 * Rest a fingertip gently on the sensor: you should see a wave that bumps with each heartbeat.
 * Flat line near 0 or 4095 = check the wiring (S -> GPIO34, + -> 3V3, - -> GND).
 */
const int PULSE_PIN = 34;

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
}

void loop() {
  Serial.println(analogRead(PULSE_PIN));
  delay(10);
}
