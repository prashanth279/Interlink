const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');

const c = { cy: '\x1b[36m', m: '\x1b[35m', y: '\x1b[33m', g: '\x1b[32m', r: '\x1b[31m', w: '\x1b[37m', gr: '\x1b[90m', b: '\x1b[1m', rst: '\x1b[0m' };

function setupEnvironment() {
    const pkgs = ['axios', 'moment', 'https-proxy-agent', 'socks-proxy-agent'];
    pkgs.forEach(p => { 
        try { require.resolve(p); } catch (e) { 
            console.log(`${c.gr}Installing ${p}...${c.rst}`);
            execSync(`npm install ${p}`, { stdio: 'inherit' }); 
        } 
    });
    if (!fs.existsSync(path.join(__dirname, 'accounts.json'))) fs.writeFileSync(path.join(__dirname, 'accounts.json'), '[]');
    if (!fs.existsSync(path.join(__dirname, 'logs.json'))) fs.writeFileSync(path.join(__dirname, 'logs.json'), '{}');
}
setupEnvironment();

const axios = require('axios');
const moment = require('moment');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// --- APP CONFIGURATION ---
const APP_VERSION = '1.1.8'; 
const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_URL = 'https://interlink-mini-app.interlinklabs.ai/api';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.cy}⸽ ${c.w}${q}${c.rst}`, (a) => res(a.trim())));

const MODELS = [{ brand: 'XiaoMi', model: 'Redmi Note 8 Pro' }, { brand: 'Samsung', model: 'Galaxy S21 Ultra' }, { brand: 'Google', model: 'Pixel 6' }];

function getAgent(proxy) {
    if (!proxy || proxy.toUpperCase() === 'NONE') return new https.Agent({ rejectUnauthorized: false });
    return proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
}

// --- CORE LOGIN LOGIC (WITH BYPASS) ---
async function performLogin(targetAcc = null) {
    console.log(`\n${c.m}◢◤ ${c.cy}AUTH_PROTOCOL_INITIATED (v${APP_VERSION}) ${c.m}◥◣${c.rst}`);
    const loginId = await prompt('LOGIN ID: ');
    const passcode = await prompt('PASSCODE: ');
    const email = await prompt('EMAIL: ');
    const proxy = await prompt('PROXY (optional, leave blank for None): ');

    const deviceId = targetAcc ? targetAcc.deviceId : crypto.randomBytes(8).toString('hex');
    const identity = targetAcc ? { brand: targetAcc.brand, model: targetAcc.model } : MODELS[Math.floor(Math.random() * MODELS.length)];
    const agent = getAgent(proxy);

    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': deviceId, 'version': APP_VERSION },
        httpsAgent: agent
    });

    try {
        console.log(`${c.gr}⸽ Checking Login ID...${c.rst}`);
        await client.get(`/auth/loginId-exist-check/${loginId}`, { params: { deviceId } });
        
        console.log(`${c.gr}⸽ Verifying Passcode...${c.rst}`);
        await client.post('/auth/check-passcode', { loginId, passcode, deviceId });
        
        console.log(`${c.gr}⸽ Requesting Auto-OTP...${c.rst}`);
        try {
            await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });
            console.log(`${c.g}⫸ OTP_SENT_TO_EMAIL${c.rst}`);
        } catch (otpErr) {
            console.log(`${c.y}⚠ Auto-OTP Blocked (${otpErr.response?.status || 'Error'}). Generate OTP via the official app and enter it below.${c.rst}`);
        }

        const otp = await prompt('ENTER OTP: ');
        
        console.log(`${c.gr}⸽ Verifying OTP (Stealth Bypass Mode)...${c.rst}`);
        
        // THE BYPASS: Fresh request, NO deviceId in payload, NO x-unique-id in headers
        const verifyRes = await axios.post(`${API_BASE_URL}/auth/check-otp-email-verify-login`, 
            { loginId, otp }, 
            {
                headers: { 'User-Agent': 'okhttp/4.12.0', 'version': APP_VERSION },
                httpsAgent: agent
            }
        );

        // Fetch Both Tokens
        const token = verifyRes.data?.data?.accessToken || verifyRes.data?.data?.jwtToken;
        const refreshToken = verifyRes.data?.data?.refreshToken || null;
        
        if (token) {
            console.log(`${c.g}✅ AUTHENTICATED SUCCESSFULLY${c.rst}`);
            
            // Create a temporary account object to pass into Profile Sync
            let newAcc = { 
                name: loginId, loginId, registeredEmail: email, passcode, 
                token, refreshToken, deviceId, proxy: proxy || 'NONE', paused: false, ...identity 
            };
            
            // Run instant profile sync to grab wallet, balances, and mini token
            newAcc = await syncProfile(newAcc);
            saveAccount(newAcc);
            
            await prompt('\nPress Enter to return to menu...');
        }
    } catch (e) {
        console.log(`\n${c.r}❌ AUTH_FAILED: ${e.message}${c.rst}`);
        if (e.response && e.response.data) {
            console.log(`${c.gr}${JSON.stringify(e.response.data, null, 2)}${c.rst}`);
        }
        await prompt('\nPress Enter to return to menu...');
    }
}

// --- PROFILE SYNC LOGIC ---
async function syncProfile(acc) {
    const agent = getAgent(acc.proxy);
    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { 'Authorization': `Bearer ${acc.token}`, 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': acc.deviceId, 'version': APP_VERSION },
        httpsAgent: agent, timeout: 15000
    });

    try {
        console.log(`${c.cy}⸽ Fetching Profile Data for ${c.w}${acc.name || acc.email || acc.deviceId}${c.rst}...`);
        
        const userRes = await client.get('/auth/current-user');
        const userData = userRes.data?.data || {};

        const tokenRes = await client.get('/token/get-token');
        const tokenData = tokenRes.data?.data || {};

        let miniToken = acc.miniToken;
        if (userData.loginId) {
            try {
                const miniRes = await axios.post(`${MINI_API_URL}/tracking/verify`,
                    { loginId: userData.loginId, appId: 'id__mk39oef6we80fs7j2rif' },
                    { headers: { 'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7', 'Authorization': `Bearer ${acc.token}` }, httpsAgent: agent }
                );
                miniToken = miniRes.data?.data?.token || miniRes.data?.token || miniToken;
            } catch(e) { }
        }

        acc.name = userData.username || acc.name;
        acc.loginId = userData.loginId || acc.loginId;
        acc.registeredEmail = userData.email || acc.registeredEmail;
        acc.wallet = userData.connectedAccounts?.wallet?.address || 'None';
        acc.referralId = tokenData.userReferralId || acc.referralId;
        acc.miniToken = miniToken;
        acc.lastUpdate = moment().format('YYYY-MM-DD HH:mm:ss');

        console.log(`${c.g}✅ PROFILE SYNCED: ${acc.name}${c.rst}`);
        return acc;

    } catch (e) {
        console.log(`${c.r}❌ SYNC FAILED: Token may be expired. Status ${e.response?.status || e.message}${c.rst}`);
        return acc; 
    }
}

// --- FILE OPS ---
function saveAccount(acc) {
    let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
    const idx = accounts.findIndex(a => a.deviceId === acc.deviceId || a.loginId === acc.loginId);
    if (idx !== -1) accounts[idx] = acc; else accounts.push(acc);
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

function saveAllAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

// --- MAIN MENU ---
async function main() {
    while (true) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK_COMMAND_CENTER_v5.0${c.rst} ${c.m}══${c.rst}\n`);
        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));

        if (accounts.length > 0) {
            accounts.forEach((a, i) => {
                const s = a.miniToken ? `${c.g}YES${c.rst}` : `${c.r}NO${c.rst}`;
                const p = a.paused ? `${c.r}YES${c.rst}` : `${c.g}NO${c.rst}`;
                console.log(`${c.cy}⫸ ${c.w}${i+1}. ${a.name?.padEnd(12) || 'Unknown'.padEnd(12)}${c.rst} | SPN: ${s} | PAUSED: ${p}`);
            });
        } else { console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND${c.rst}`); }

        console.log(`\n${c.cy}⫹── ${c.b}${c.w}1. ADD/FIX | 2. REMOVE | 3. UPDATE PROFILES | 4. TOGGLE PAUSE | 5. START BOT${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');
        
        if (choice === '1') {
            const id = await prompt('SELECT NUMBER TO OVERWRITE (OR BLANK FOR NEW): ');
            await performLogin(id ? accounts[id-1] : null);
        } else if (choice === '2') {
            const id = await prompt('SELECT NUMBER TO REMOVE: ');
            if (accounts[id-1]) {
                console.log(`${c.y}Removed ${accounts[id-1].name}${c.rst}`);
                accounts.splice(id-1, 1);
                saveAllAccounts(accounts);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '3') {
            const target = await prompt('SELECT NUMBER TO UPDATE (OR TYPE "ALL"): ');
            if (target.toUpperCase() === 'ALL') {
                for (let i = 0; i < accounts.length; i++) accounts[i] = await syncProfile(accounts[i]);
            } else if (accounts[target-1]) {
                accounts[target-1] = await syncProfile(accounts[target-1]);
            }
            saveAllAccounts(accounts);
            await prompt('\nPress Enter to return...');
        } else if (choice === '4') {
            const id = await prompt('SELECT NUMBER TO TOGGLE PAUSE: ');
            if (accounts[id-1]) {
                accounts[id-1].paused = !accounts[id-1].paused;
                saveAllAccounts(accounts);
                console.log(`${c.g}✅ ${accounts[id-1].name} Paused: ${accounts[id-1].paused}${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '5') {
            console.clear();
            console.log(`${c.g}🚀 LAUNCHING INDEX.JS...${c.rst}\n`);
            
            // Seamlessly hands over the terminal to index.js
            const child = spawn('node', ['index.js'], { stdio: 'inherit' });
            child.on('close', (code) => {
                process.exit(code);
            });
            break; // Exits the menu loop
        }
    }
}

main().catch(err => console.error(err));
