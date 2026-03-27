const { execSync } = require('child_process');
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

const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_URL = 'https://interlink-mini-app.interlinklabs.ai/api';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.cy}⸽ ${c.w}${q}${c.rst}`, (a) => res(a.trim())));

const MODELS = [{ brand: 'XiaoMi', model: 'Redmi Note 8 Pro' }, { brand: 'Samsung', model: 'Galaxy S21 Ultra' }, { brand: 'Google', model: 'Pixel 6' }];

function getAgent(proxy) {
    if (!proxy) return new https.Agent({ rejectUnauthorized: false });
    return proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
}

// --- CORE LOGIN LOGIC ---
async function performLogin(targetAcc = null) {
    console.log(`\n${c.m}◢◤ ${c.cy}AUTH_PROTOCOL_INITIATED ${c.m}◥◣${c.rst}`);
    const loginId = await prompt('LOGIN ID: ');
    const passcode = await prompt('PASSCODE: ');
    const email = await prompt('EMAIL: ');
    const proxy = await prompt('PROXY (optional): ');

    const deviceId = targetAcc ? targetAcc.deviceId : crypto.randomBytes(8).toString('hex');
    const identity = targetAcc ? { brand: targetAcc.brand, model: targetAcc.model } : MODELS[Math.floor(Math.random() * MODELS.length)];
    const agent = getAgent(proxy);

    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': deviceId, 'version': '1.1.8' },
        httpsAgent: agent
    });

    try {
        await client.get(`/auth/loginId-exist-check/${loginId}`, { params: { deviceId } });
        await client.post('/auth/check-passcode', { loginId, passcode, deviceId });
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });

        console.log(`${c.g}⫸ OTP_SENT_TO_EMAIL${c.rst}`);
        const otp = await prompt('ENTER OTP: ');
        const verifyRes = await client.post('/auth/check-otp-email-verify-login', { loginId, otp, deviceId });

        const token = verifyRes.data?.data?.jwtToken;
        const realName = verifyRes.data?.data?.user?.username || loginId;

        if (token) {
            console.log(`${c.y}⫸ SYNCING_MINI_APP_TOKEN...${c.rst}`);
            let miniToken = null;
            try {
                const miniRes = await axios.post(`${MINI_API_URL}/tracking/verify`,
                    { loginId, appId: 'id__mk39oef6we80fs7j2rif' },
                    { headers: { 'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7', 'Authorization': `Bearer ${token}` }, httpsAgent: agent }
                );
                miniToken = miniRes.data?.data?.token || miniRes.data?.token || null;
            } catch (e) { console.log(`${c.y}⚠ MINI_TOKEN_SYNC_FAILED${c.rst}`); }

            // Save basic data (Update Profile will fetch the rest)
            saveAccount({ 
                name: realName, token, miniToken, deviceId, proxy, paused: false, ...identity 
            });
            console.log(`${c.g}✅ ACCOUNT_SAVED: ${realName}${c.rst}`);
            if (miniToken) console.log(`${c.g}✅ MINI_TOKEN_LINKED${c.rst}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e) {
        console.log(`${c.r}❌ AUTH_FAILED: ${e.response?.data?.message || e.message}${c.rst}`);
        await prompt('Press Enter to return...');
    }
}

// --- PROFILE SYNC LOGIC ---
async function syncProfile(acc) {
    const agent = getAgent(acc.proxy);
    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { 'Authorization': `Bearer ${acc.token}`, 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': acc.deviceId, 'version': '1.1.8' },
        httpsAgent: agent, timeout: 15000
    });

    try {
        console.log(`${c.cy}⸽ Fetching data for ${c.w}${acc.name || acc.email || acc.deviceId}${c.rst}...`);
        
        // 1. Current User Data
        const userRes = await client.get('/auth/current-user');
        const userData = userRes.data?.data || {};

        // 2. Token & Referral Data
        const tokenRes = await client.get('/token/get-token');
        const tokenData = tokenRes.data?.data || {};

        // 3. Mini Token Check/Refresh
        let miniToken = acc.miniToken;
        if (userData.loginId) {
            try {
                const miniRes = await axios.post(`${MINI_API_URL}/tracking/verify`,
                    { loginId: userData.loginId, appId: 'id__mk39oef6we80fs7j2rif' },
                    { headers: { 'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7', 'Authorization': `Bearer ${acc.token}` }, httpsAgent: agent }
                );
                miniToken = miniRes.data?.data?.token || miniRes.data?.token || miniToken;
            } catch(e) { /* ignore if fails, keep existing */ }
        }

        // Apply Updates (Backward Compatible)
        acc.name = userData.username || acc.name;
        acc.loginId = userData.loginId || acc.loginId;
        acc.registeredEmail = userData.email || acc.registeredEmail;
        acc.wallet = userData.connectedAccounts?.wallet?.address || 'None';
        acc.referralId = tokenData.userReferralId || acc.referralId;
        acc.miniToken = miniToken;
        acc.lastUpdate = moment().format('YYYY-MM-DD HH:mm:ss');

        console.log(`${c.g}✅ SYNCED: ${acc.name} | Wallet: ${acc.wallet !== 'None' ? c.g+'Linked' : c.r+'None'}${c.rst}`);
        return acc;

    } catch (e) {
        console.log(`${c.r}❌ FAILED: ${acc.name || 'Unknown'} - Token might be expired (${e.response?.status || e.message})${c.rst}`);
        return acc; 
    }
}

// --- FILE OPS ---
function saveAccount(acc) {
    let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
    const idx = accounts.findIndex(a => a.deviceId === acc.deviceId);
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
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK_MANAGER_v4.0${c.rst} ${c.m}══${c.rst}\n`);
        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));

        if (accounts.length > 0) {
            accounts.forEach((a, i) => {
                const s = a.miniToken ? `${c.g}YES${c.rst}` : `${c.r}NO${c.rst}`;
                const p = a.paused ? `${c.r}YES${c.rst}` : `${c.g}NO${c.rst}`;
                console.log(`${c.cy}⫸ ${c.w}${i+1}. ${a.name?.padEnd(12) || 'Unknown'.padEnd(12)}${c.rst} | SPN: ${s} | PAUSED: ${p}`);
            });
        } else { console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND${c.rst}`); }

        console.log(`\n${c.cy}⫹── ${c.b}${c.w}1. ADD/FIX | 2. REMOVE | 3. UPDATE PROFILES | 4. TOGGLE PAUSE | 5. EXIT${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');
        
        if (choice === '1') {
            const id = await prompt('ID TO OVERWRITE (OR BLANK FOR NEW): ');
            await performLogin(id ? accounts[id-1] : null);
        
        } else if (choice === '2') {
            const id = await prompt('REMOVE ID: ');
            if (accounts[id-1]) {
                accounts.splice(id-1, 1);
                saveAllAccounts(accounts);
            }
            
        } else if (choice === '3') {
            const target = await prompt('ID TO UPDATE (OR TYPE "ALL"): ');
            if (target.toUpperCase() === 'ALL') {
                for (let i = 0; i < accounts.length; i++) {
                    accounts[i] = await syncProfile(accounts[i]);
                }
            } else if (accounts[target-1]) {
                accounts[target-1] = await syncProfile(accounts[target-1]);
            }
            saveAllAccounts(accounts);
            await prompt('\nPress Enter to return...');

        } else if (choice === '4') {
            const id = await prompt('ID TO TOGGLE PAUSE: ');
            if (accounts[id-1]) {
                accounts[id-1].paused = !accounts[id-1].paused;
                saveAllAccounts(accounts);
                console.log(`${c.g}✅ Account ${accounts[id-1].name} pause status set to: ${accounts[id-1].paused}${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
            
        } else if (choice === '5') {
            process.exit(0);
        }
    }
}

main().catch(err => console.error(err));
