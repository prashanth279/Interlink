const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');

const REQUIRED_PACKAGES = ['axios', 'moment', 'moment-timezone'];
function installDependencies() {
    for (const pkg of REQUIRED_PACKAGES) {
        try { require.resolve(pkg); } catch (e) {
            execSync(`npm install ${pkg}`, { stdio: 'inherit' });
        }
    }
}
installDependencies();

const axios = require('axios');
const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_URL = 'https://interlink-mini-app.interlinklabs.ai/api';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');

const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', cy: '\x1b[36m', w: '\x1b[37m', rs: '\x1b[0m', gr: '\x1b[90m' };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.w}${q}${c.rs}`, (a) => res(a.trim())));

const MODELS = [
    { brand: 'XiaoMi', model: 'Redmi Note 8 Pro' },
    { brand: 'Samsung', model: 'Galaxy S21 Ultra' },
    { brand: 'Google', model: 'Pixel 6' },
    { brand: 'OnePlus', model: 'OnePlus 9' }
];

function createClient(acc) {
    const instance = axios.create({
        baseURL: API_BASE_URL,
        headers: {
            'User-Agent': 'okhttp/4.12.0',
            'x-unique-id': acc.deviceId,
            'x-device-id': acc.deviceId,
            'x-model': acc.model || 'Redmi Note 8 Pro',
            'x-brand': acc.brand || 'XiaoMi',
            'version': '1.1.8'
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    if (acc.token) instance.defaults.headers['Authorization'] = `Bearer ${acc.token}`;
    return instance;
}

async function performLogin(targetAcc = null) {
    console.log(`\n${c.y}--- Starting Login Management ---${c.rs}`);
    const loginId = await prompt('Enter Login ID: ');
    const passcode = await prompt('Enter Passcode: ');
    const email = await prompt('Enter Email: ');
    
    const deviceId = targetAcc ? targetAcc.deviceId : crypto.randomBytes(8).toString('hex');
    const identity = targetAcc ? { brand: targetAcc.brand, model: targetAcc.model } : MODELS[Math.floor(Math.random() * MODELS.length)];
    const client = createClient({ deviceId, ...identity });

    try {
        await client.get(`/auth/loginId-exist-check/${loginId}`, { params: { deviceId } });
        await client.post('/auth/check-passcode', { loginId, passcode, deviceId });
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });

        console.log(`${c.g}[✓] OTP Sent! Check email...${c.rs}`);
        const otp = await prompt('Enter OTP: ');
        const verifyRes = await client.post('/auth/check-otp-email-verify-login', { loginId, otp, deviceId });
        
        const token = verifyRes.data?.data?.jwtToken;
        const realName = verifyRes.data?.data?.user?.username || loginId;

        if (token) {
            console.log(`${c.y}[⟳] Syncing Mini-App Token...${c.rs}`);
            const miniRes = await axios.post(`${MINI_API_URL}/tracking/verify`, { loginId, appId: 'id__mk39oef6we80fs7j2rif' }, {
                headers: { 'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7' }
            });
            const miniToken = miniRes.data?.data?.token || null;
            
            saveAccount({ name: realName, token, miniToken, deviceId, ...identity });
            console.log(`${c.g}[✅] Account "${realName}" Updated & Saved!${c.rs}`);
        }
    } catch (e) {
        console.log(`${c.r}[✗] Failed: ${e.response?.data?.message || e.message}${c.rs}`);
    }
}

function saveAccount(acc) {
    let accounts = fs.existsSync(ACCOUNTS_JSON) ? JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')) : [];
    const idx = accounts.findIndex(a => a.deviceId === acc.deviceId);
    if (idx !== -1) accounts[idx] = acc; else accounts.push(acc);
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

async function main() {
    while (true) {
        console.clear();
        console.log(`${c.cy}=== INTERLINK ACCOUNT MANAGER ===${c.rs}`);
        if (fs.existsSync(ACCOUNTS_JSON)) {
            const accs = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
            accs.forEach((a, i) => console.log(`${i+1}. ${a.name.padEnd(15)} | ${a.model} | SpinToken: ${a.miniToken ? 'YES' : 'NO'}`));
        } else { console.log(c.gr + "No accounts yet." + c.rs); }
        
        console.log(`\n1. Add/Fix Account | 2. Remove | 3. Exit`);
        const choice = await prompt('Choice: ');
        if (choice === '1') {
            const id = await prompt('Enter ID to fix (or leave blank for new): ');
            const accounts = fs.existsSync(ACCOUNTS_JSON) ? JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')) : [];
            await performLogin(accounts[id-1] || null);
        }
        if (choice === '2') {
            const id = await prompt('Remove ID: ');
            let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
            accounts.splice(id-1, 1);
            fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
        }
        if (choice === '3') process.exit(0);
    }
}
main();
