// Copy this file to "secrets.h" in the same folder and fill in your details.
// Keep secrets.h out of GitHub (it's already in .gitignore).
#pragma once

#define WIFI_SSID       "Your-WiFi-Name"
#define WIFI_PASSWORD   "Your-WiFi-Password"

// Your laptop's IP on the same Wi-Fi (run `ipconfig` on Windows, look for IPv4 Address).
// "localhost" will NOT work here - localhost on the ESP32 means the ESP32 itself.
#define SERVER_URL      "http://192.168.1.50:4000/api/readings"

// Must match a device_id on a patient in the dashboard (seed data uses these)
#define DEVICE_ID       "ESP32-KZN-001"

// Must match DEVICE_API_KEY in server/.env
#define DEVICE_API_KEY  "change-me-device-key"
