const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');

const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');

const colors = {
  green: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', 
  cyan: '\x1b[36m', white: '\x1b[37m', reset: '\x1b[0m'
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${colors.white}${q}${colors.reset}`, (a) => res(a.trim())));

function createClient(deviceId) {
  return axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'User-Agent': 'okhttp/4.12.0',
      'x-unique-id': deviceId,
      'x-device-id': deviceId,
      'version': '1.1.8',
      'Content-Type': 'application/json'
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
}

async function startLogin() {
  console.log(`\n${colors.cyan}=== Interlink Account Login Helper ===${colors.reset}\n`);
  
  const loginId = await prompt('Enter Login ID (Username/Email): ');
  const passcode = await prompt('Enter Passcode: ');
  const email = await prompt('Enter Email (for OTP): ');
  const deviceId = crypto.randomBytes(8).toString('hex');

  const client = createClient(deviceId);

  try {
    // 1. Check if ID exists
    console.log(`${colors.yel}[⟳] Checking Login ID...${colors.reset}`);
    await client.get(`/auth/loginId-exist-check/${loginId}`, { params: { deviceId } });

    // 2. Check Passcode
    console.log(`${colors.yel}[⟳] Verifying Passcode...${colors.reset}`);
    await client.post('/auth/check-passcode', { loginId, passcode, deviceId });

    // 3. Send OTP
    console.log(`${colors.yel}[⟳] Requesting OTP to ${email}...${colors.reset}`);
    await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });
    
    console.log(`${colors.green}[✓] OTP Sent! Please check your email.${colors.reset}`);
    const otp = await prompt('Enter OTP Code: ');

    // 4. Verify OTP and get Token
    const verifyRes = await client.post('/auth/check-otp-email-verify-login', { loginId, otp, deviceId });
    
    if (verifyRes.data.statusCode === 200) {
      const token = verifyRes.data.data.jwtToken;
      console.log(`${colors.green}[✅] Login Successful!${colors.reset}`);
      
      updateAccountsFile(token, deviceId);
    }
  } catch (error) {
    console.log(`${colors.red}[✗] Error: ${error.response?.data?.message || error.message}${colors.reset}`);
  } finally {
    rl.close();
  }
}

function updateAccountsFile(token, deviceId) {
  let accounts = [];
  
  if (fs.existsSync(ACCOUNTS_JSON)) {
    try {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
    } catch (e) {
      accounts = [];
    }
  }

  // Check if device already exists, update it; otherwise add new
  const index = accounts.findIndex(acc => acc.deviceId === deviceId);
  if (index !== -1) {
    accounts[index].token = token;
  } else {
    accounts.push({ token, deviceId });
  }

  fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
  console.log(`${colors.cyan}[i] accounts.json updated with new device: ${deviceId.substring(0,8)}...${colors.reset}\n`);
}

startLogin();
