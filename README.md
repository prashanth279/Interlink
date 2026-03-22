# 🛰️ Interlink Farmer (Stealth Edition)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Termux%20%7C%20Linux%20%7C%20Windows-blue)](https://github.com/prashanth279/interlink-farmer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An advanced, automated farming solution for the **Interlink Network**, engineered for high stealth, low server footprint, and seamless multi-account management.

---
## 🛠️ Key Features

* **🎲 Precision Jitter:** Randomizes claim execution times (30 minute variance) to mimic human behavior and evade detection
* **📊 Visual Dashboard:** Real-time terminal UI providing status updates for all 6 daily mining windows.
* **⚡ Account management:** Integrated `login.js` utility to authenticate, add or remove accounts.
* **🕵️ Stealth Handshake:** Smart pings that only occur during active claim windows—no constant background noise.
* **👥 Multi-Account Engine:** Manages an unlimited number of accounts, each paired with a **Unique Android Device ID** and proxy rotation.
* **📜 Persistent Logging:** Comprehensive tracking of daily gains and window success rates in `logs.json`.
---

## 🚀 Installation

### 1️⃣ Pre-requisites
* Environment**: Optimized for **Termux** (Android), Linux VPS, or Windows CMD/PowerShell.
* For termux android- install apk from [Github](https://github.com/termux/termux-app) or [F-droid](https://f-droid.org/en/packages/com.termux/) not playstore
* Install GitHub package(ignore if installed)
```bash
Pkg install git
```
### Setup
```bash
# Clone the repository
git clone https://github.com/prashanth279/interlink.git
cd interlink
```
```bash
# Install dependencies
npm install
```
---
### 2️⃣ 🔑 Login
* Step 1: Run the Login Helper
```bash
node login.js
```
* Step 2: Authenticate
    Enter Credentials: Input your Login ID, Passcode, and Email when prompted.
    Device Identity: The script generates and assigns a Unique Android Device ID to that specific account.
    OTP Verification: Retrieve the OTP from your email and enter it to finalize the handshake.
    Auto-Config: The script verifies the JWT and automatically updates accounts.json.
* Step 3: Configure Proxies (Optional)
Create a `proxies.txt` file in the root directory. Add your proxies (HTTP/SOCKS5) one per line. If missing, the script defaults to your local IP.
---
###🎿 Usage
* Once your accounts are configured, launch the main farming engine:
```bash
node mine.js
```
---
### 📁 File Structure

| File | Purpose |
| :--- | :--- |
| `mine.js` | Main automation engine |
| `login.js` | Login & OTP helper |
| `accounts.json` | [Auto-generated] Stores your session data |
| `proxies.txt` | Your proxy list (one per line)|
| `logs.json` | [Auto-generated] Daily gain tracking|
| `README.md` | Project documentation|
---
🛡️ Security & Safety
* Privacy: accounts.json, proxies.txt, and logs.json are pre-added to .gitignore.
* Do not share these files or commit them to public forks.
* Stealth: This bot uses okhttp/4.12.0 headers and randomized delays to blend in with official mobile app traffic.
---
      Disclaimer: This tool is for educational purposes.
      Automated farming may violate Terms of Service.
      Use at your own risk.
---
Developed with ❤️ by Prashanth
credits to original developers [vikitoshi](https://github.com/vikitoshi/Interlink-Auto-Bot) , [cryptodai3](https://github.com/cryptodai3/Interlink-Bot)
