# <re> Interlink Precision Farmer (Stealth Edition)

An automated farming solution for Interlink Gold, designed with high stealth, low server footprint, and multi-account support.

## ✕ Key Features

* **One-Command Login:** Use `login.js` to authenticate, verify OTP, and auto-configure accounts.
* **Stealth Handshake:** Only pings the server during claim windows (no constant spamming).
* **Precision Timing:** Randomizes claim times for each account to mimic human behavior.
* **Multi-Account Support:** Runs multiple accounts with unique Device IDs and Proxy rotation.
* **Visual Dashboard:** Real-time terminal UI showing status for all 6 daily mining windows.
* **Persistent Logging:** Tracks daily gains and missed windows in `logs.json.

---

## ✄ Installation

### 1. Requirements
* Node.js (v16 or higher)
* Termux (Android) or any Linux VPS

### 2. Setup
```bash
# Clone the repository
git clone https://github.com/prashanth279/interlink-farmer.git
cd interlink-farmer

# Install dependencies
npm install axios moment https-proxy-agent socks-proxy-agent
```

---

## 💹 Automated Login Process

You do not need to create `accounts.json` manually. The login helper handles everything.

### Step 1: Prepare Proxies (Optional)
If you have proxies, add them to a file named `proxies.txt` (one per line). If the file is empty or missing, the script will use your local IP.

### Step 2: Run the Login Helper
```bash
node login.js
```

### Step 3: Authenticate
1. **Enter Credentials:** Provide your Login ID (Username/Email), Passcode, and Email.
2. **Device Identity:** The script automatically generates a **Unique Android Device ID** for this session.
3. **OTP Verification:** Check your email for the OTP, enter it into the terminal, and hit Enter.
4. **Auto-Save:** The script verifies the token and automatically creates/updates `accounts.json` with the correct format.

---

## 🎿 Usage

Once your accounts are added via `login.js`, start the precision farmer:
``bbash
node index.js
```

---

## ⚢ Security Notice
Your `accounts.json`, `proxies.txt`, and `logs.json` are included in the `.gitignore`. **Never** remove them from the ignore list, or you risk leaking your login tokens to the public.