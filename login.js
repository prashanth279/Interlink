const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');

const c = { cy: '\x1b[36m', m: '\x1b[35m', y: '\x1b[33m', g: '\x1b[32m', r: '\x1b[31m', w: '\x1b[37m', gr: '\x1b[90m', b: '\x1b[1m', rst: '\x1b[0m', wh: '\x1b[97m' };

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
    if (!fs.existsSync(path.join(__dirname, 'devicepool.txt'))) fs.writeFileSync(path.join(__dirname, 'devicepool.txt'), '# Format: email | Brand | Model | DeviceID\n');
}
setupEnvironment();

const axios = require('axios');
const moment = require('moment');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// --- APP CONFIGURATION ---
const APP_VERSION = '5.0.1'; 
const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_URL = 'https://interlink-mini-app.interlinklabs.ai/api';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const DEVICE_POOL = path.join(__dirname, 'devicepool.txt');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.cy}⸽ ${c.w}${q}${c.rst}`, (a) => res(a.trim())));

const MODELS = [
    { brand: 'POCO', model: '25053PC47G' }, 
    { brand: 'Samsung', model: 'Galaxy S24 Ultra' }, 
    { brand: 'Google', model: 'Pixel 8 Pro' }, 
    { brand: 'XiaoMi', model: 'Redmi Note 13' }
];

function getAgent(proxy) {
    if (!proxy || proxy.toUpperCase() === 'NONE') return new https.Agent({ rejectUnauthorized: false });
    return proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
}

function getHeaders(acc) {
    return {
        'Version': APP_VERSION,
        'X-Platform': 'android',
        'X-System-Name': 'Android',
        'X-Date': Date.now().toString(),
        'X-Brand': acc.brand || 'POCO',
        'X-Model': acc.model || '25053PC47G',
        'X-Unique-Id': acc.deviceId,
        'X-Device-Id': acc.deviceId,
        'X-Bundle-Id': 'org.ai.interlinklabs.interlinkId',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'okhttp/4.12.0',
        'Content-Type': 'application/json'
    };
}

// --- DEVICE POOL MANAGER ---
function appendToDevicePool(email, brand, model, deviceId) {
    const idKey = email;
    let poolText = fs.readFileSync(DEVICE_POOL, 'utf8');
    if (!poolText.includes(idKey)) {
        fs.appendFileSync(DEVICE_POOL, `${idKey} | ${brand} | ${model} | ${deviceId}\n`);
    }
}

// --- CORE LOGIN LOGIC (V2 SECURED) ---
async function performLogin(targetAcc = null) {
    console.log(`\n${c.m}◢◤ ${c.cy}AUTH_PROTOCOL_INITIATED (v${APP_VERSION}) ${c.m}◥◣${c.rst}`);
    
    let loginId, passcode, email, proxy, deviceId, identity;

    if (targetAcc) {
        console.log(`${c.g}⸽ Auto-loading credentials for: ${targetAcc.name || targetAcc.registeredEmail}${c.rst}`);
        loginId = targetAcc.loginId;
        passcode = targetAcc.passcode;
        email = targetAcc.registeredEmail || targetAcc.email;
        proxy = targetAcc.proxy;
        deviceId = targetAcc.deviceId;
        identity = { brand: targetAcc.brand, model: targetAcc.model };
    } else {
        loginId = await prompt('LOGIN ID: ');
        passcode = await prompt('PASSCODE: ');
        email = await prompt('EMAIL: ');
        proxy = await prompt('PROXY (optional, leave blank for None): ');
        deviceId = crypto.randomBytes(8).toString('hex');
        identity = MODELS[Math.floor(Math.random() * MODELS.length)];
        
        // Save new footprint to Device Pool instantly
        appendToDevicePool(email, identity.brand, identity.model, deviceId);
    }

    const agent = getAgent(proxy);
    const tempAcc = { deviceId, brand: identity.brand, model: identity.model };

    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: getHeaders(tempAcc),
        httpsAgent: agent
    });

    try {
        console.log(`${c.gr}⸽ Checking Login ID...${c.rst}`);
        await client.get(`/auth/loginId-exist-check/${loginId}`, { params: { deviceId } });
        
        console.log(`${c.gr}⸽ Verifying Passcode...${c.rst}`);
        await client.post('/auth/check-passcode', { loginId, passcode, deviceId });
        
        console.log(`${c.gr}⸽ Requesting OTP...${c.rst}`);
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });
        console.log(`${c.g}⫸ OTP SENT TO EMAIL!${c.rst}`);

        const otp = await prompt('ENTER OTP: ');
        
        console.log(`${c.gr}⸽ Verifying OTP (v2 Security Handshake)...${c.rst}`);
        
        // V2 Patched: Strict Headers + deviceId injected into payload
        const verifyRes = await client.post(`/auth/check-otp-email-verify-login?v=2`, { 
            loginId, 
            otp,
            deviceId 
        });

        // Fetch Both Tokens
        const token = verifyRes.data?.data?.accessToken || verifyRes.data?.data?.jwtToken;
        const refreshToken = verifyRes.data?.data?.refreshToken || null;
        
        if (token) {
            console.log(`${c.g}✅ AUTHENTICATED SUCCESSFULLY${c.rst}`);
            
            let newAcc = { 
                name: loginId, loginId, registeredEmail: email, passcode, 
                token, refreshToken, deviceId, proxy: proxy || 'NONE', paused: false, ...identity 
            };
            
            newAcc = await syncProfile(newAcc);
            saveAccount(newAcc);
            
            await prompt('\nPress Enter to return to menu...');
        }
    } catch (e) {
        console.log(`\n${c.r}❌ AUTH_FAILED: ${e.response?.data?.message || e.message}${c.rst}`);
        await prompt('\nPress Enter to return to menu...');
    }
}

// --- PROFILE SYNC LOGIC ---
async function syncProfile(acc) {
    const agent = getAgent(acc.proxy);
    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { ...getHeaders(acc), 'Authorization': `Bearer ${acc.token}` },
        httpsAgent: agent, timeout: 15000
    });

    try {
        console.log(`${c.cy}⸽ Fetching Profile Data for ${c.w}${acc.name || acc.registeredEmail || acc.deviceId}${c.rst}...`);
        
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
                const status = a.paused ? `${c.r}[PAUSED]${c.rst}` : `${c.wh}[WORKING]${c.rst}`;
                console.log(`${c.cy}⫸ ${c.w}${i+1}. ${a.name?.padEnd(12) || 'Unknown'.padEnd(12)}${c.rst} | ${status}`);
            });
        } else { console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND${c.rst}`); }

        console.log(`\n${c.cy}⫹── ${c.b}${c.w}1. ADD / FIX | 2. REMOVE | 3. UPDATE PROFILES | 4. TOGGLE PAUSE | 5. START INDEX.JS${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');
        
        if (choice === '1') {
            const id = await prompt('SELECT NUMBER TO FIX (OR LEAVE BLANK FOR NEW ACCOUNT): ');
            if (id.trim() === '') {
                await performLogin(null);
            } else if (accounts[id-1]) {
                await performLogin(accounts[id-1]);
            } else {
                console.log(`${c.r}❌ Invalid selection.${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
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
            
            const child = spawn('node', ['index.js'], { stdio: 'inherit' });
            child.on('close', (code) => {
                process.exit(code);
            });
            break; 
        }
    }
}

main().catch(err => console.error(err));
