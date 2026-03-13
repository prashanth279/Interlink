# 🛰️ Interlink Precision Farmer (Stealth Edition)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Termux%20%7C%20Linux%20%7C%20Windows-blue)](https://github.com/prashanth279/interlink-farmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An advanced, automated farming solution for the **Interlink Network**, engineered for high stealth, low server footprint, and seamless multi-account management.

---

## 🛠️ Key Features

* **⚡ One-Command Login:** Integrated `login.js` utility to authenticate, verify OTP, and auto-configure account metadata.
* **🕵️ Stealth Handshake:** Smart pings that only occur during active claim windows—no constant background noise.
* **🎲 Precision Jitter:** Randomizes claim execution times (1-5 minute variance) to mimic human behavior and evade detection.
* **👥 Multi-Account Engine:** Manages an unlimited number of accounts, each paired with a **Unique Android Device ID** and proxy rotation.
* **📊 Visual Dashboard:** Real-time terminal UI providing status updates for all 6 daily mining windows.
* **📜 Persistent Logging:** Comprehensive tracking of daily gains and window success rates in `logs.json`.

---

## 🚀 Installation

### 1. Prerequisites
* **Node.js**: v16.0.0 or higher.
* **Environment**: Optimized for **Termux** (Android), Linux VPS, or Windows CMD/PowerShell.

### 2. Setup
```bash
# Clone the repository
git clone [https://github.com/prashanth279/interlink-farmer.git](https://github.com/prashanth279/interlink-farmer.git)
cd interlink-farmer

# Install dependencies
npm install axios moment https-proxy-agent socks-proxy-agent
