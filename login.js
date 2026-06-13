const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');
const axios = require('axios');
const moment = require('moment');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// --- APP CONFIGURATION ---
const APP_VERSION = '5.0.3'; 
const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_URL = 'https://interlink-mini-app.interlinklabs.ai/api';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const DEVICE_POOL = path.join(__dirname, 'devicepool.txt');

// Advanced 256-Color Palette
const c = { p: '\x1b[38;5;39m', s: '\x1b[38;5;198m', a: '\x1b[38;5;118m', w: '\x1b[38;5;220m', e: '\x1b[38;5;196m', g: '\x1b[38;5;46m', wh: '\x1b[97m', gr: '\x1b[38;5;245m', cy: '\x1b[36m', m: '\x1b[38;5;207m', b: '\x1b[1m', rst: '\x1b[0m' };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.cy}⸽ ${c.wh}${q}${c.rst}`, (a) => res(a.trim())));

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

function getJwtExp(token) {
    if (!token) return 0;
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).exp; } 
    catch (e) { return 0; }
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

// --- NETWORK & REFRESH ENGINE ---
async function pulseCheck(proxyUrl) {
    const agent = getAgent(proxyUrl);
    try {
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
        return true;
    } catch (e) { 
        try {
            await axios.get('https://icanhazip.com', { httpsAgent: agent, timeout: 10000 });
            return true;
        } catch (e2) { return false; }
    }
}

async function doRefreshToken(acc) {
    if (!acc.refreshToken) return false;
    try {
        const client = axios.create({ baseURL: API_BASE_URL, headers: getHeaders(acc), httpsAgent: getAgent(acc.proxy) });
        const res = await client.post(`/auth/token`, { refreshToken: acc.refreshToken });
        if (res.data && res.data.data) {
            acc.token = res.data.data.accessToken || res.data.data.jwtToken;
            acc.refreshToken = res.data.data.refreshToken || acc.refreshToken;
            return true;
        }
        return false;
    } catch (e) { return false; }
}

// --- BOOT-UP SYNC LOGIC ---
async function syncProfile(acc) {
    const isAlive = await pulseCheck(acc.proxy);
    if (!isAlive) {
        acc.syncStatus = 'CONN_FAIL';
        return acc;
    }

    const exp = getJwtExp(acc.token);
    const nowTs = Math.floor(Date.now() / 1000);
    
    if (exp > 0 && nowTs > exp) {
        const refreshed = await doRefreshToken(acc);
        if (!refreshed) {
            acc.syncStatus = 'EXP';
            return acc;
        }
    }

    const agent = getAgent(acc.proxy);
    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { ...getHeaders(acc), 'Authorization': `Bearer ${acc.token}` },
        httpsAgent: agent, timeout: 15000
    });

    try {
        const userRes = await client.get('/auth/current-user-full?include=userInfo,token,isClaimable');
        const userData = userRes.data?.data?.userInfo || userRes.data?.data || {};

        acc.name = userData.username || userData.name || acc.name;
        acc.loginId = userData.loginId || acc.loginId;
        acc.registeredEmail = userData.email || acc.registeredEmail;
        acc.wallet = userData.connectedAccounts?.wallet?.address || 'None';
        acc.lastUpdate = moment().format('YYYY-MM-DD HH:mm:ss');
        acc.syncStatus = 'SYNCED';

        return acc;
    } catch (e) {
        if (e.response && (e.response.status === 400 || e.response.status === 401)) {
            acc.syncStatus = 'EXP';
        } else {
            acc.syncStatus = 'CONN_FAIL';
        }
        return acc; 
    }
}

// --- CORE LOGIN LOGIC (V2 SECURED) ---
function appendToDevicePool(email, brand, model, deviceId) {
    const idKey = email;
    let poolText = fs.existsSync(DEVICE_POOL) ? fs.readFileSync(DEVICE_POOL, 'utf8') : '';
    if (!poolText.includes(idKey)) {
        fs.appendFileSync(DEVICE_POOL, `${idKey} | ${brand} | ${model} | ${deviceId}\n`);
    }
}

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
        console.log(`${c.gr}⸽ Requesting OTP...${c.rst}`);
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });
        console.log(`${c.g}⫸ OTP SENT TO EMAIL!${c.rst}`);

        const otp = await prompt('ENTER OTP: ');
        
        console.log(`${c.gr}⸽ Verifying OTP (v2 Security Handshake)...${c.rst}`);
        const verifyRes = await client.post(`/auth/check-otp-email-verify-login?v=2`, { 
            loginId, 
            otp,
            deviceId 
        });

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
        console.log(`\n${c.e}❌ AUTH_FAILED: ${e.response?.data?.message || e.message}${c.rst}`);
        await prompt('\nPress Enter to return to menu...');
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

// --- MAIN UI LOGIC ---
async function main() {
    let accounts = fs.existsSync(ACCOUNTS_JSON) ? JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')) : [];
    
    if (accounts.length > 0) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK LOGIN ${APP_VERSION}${c.rst} ${c.m}══${c.rst}\n`);
        console.log(`${c.gr}[BOOT SEQUENCE] Testing connections and synchronizing endpoints...${c.rst}\n`);
        
        for (let i = 0; i < accounts.length; i++) {
            const tempName = accounts[i].name || accounts[i].loginId || 'Unknown';
            process.stdout.write(`${c.cy}⸽ ${c.gr}Synchronizing Account ${i + 1} of ${accounts.length}: ${tempName}...${c.rst}\r`);
            accounts[i] = await syncProfile(accounts[i]);
            await new Promise(r => setTimeout(r, 500)); 
        }
        saveAllAccounts(accounts);
    }

    while (true) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK LOGIN ${APP_VERSION}${c.rst} ${c.m}══${c.rst}\n`);
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));

        if (accounts.length > 0) {
            accounts.forEach((a, i) => {
                let statusTag = '';
                if (a.syncStatus === 'SYNCED') statusTag = `${c.g}[🟢 SYNCED]${c.rst}`;
                else if (a.syncStatus === 'EXP') statusTag = `${c.e}[🔴 EXP - FIX REQ]${c.rst}`;
                else if (a.syncStatus === 'CONN_FAIL') statusTag = `${c.w}[🟡 CONN FAIL]${c.rst}`;
                else statusTag = `${c.gr}[⚪ UNKNOWN]${c.rst}`;

                const pauseTag = a.paused ? `${c.gr}[PAUSED]${c.rst}` : `${c.wh}[WORKING]${c.rst}`;
                
                console.log(`${c.cy}⫸ ${c.wh}${i+1}. ${a.name?.padEnd(12) || 'Unknown'.padEnd(12)}${c.rst} | ${pauseTag} ${statusTag}`);
            });
        } else { 
            console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND${c.rst}`); 
        }

        console.log(`\n${c.cy}⫹── ${c.b}${c.wh}1. ADD / FIX | 2. REMOVE | 3. TOGGLE PAUSE | 4. START INDEX.JS${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');
        
        if (choice === '1') {
            const id = await prompt('SELECT NUMBER TO FIX (OR LEAVE BLANK FOR NEW ACCOUNT): ');
            if (id.trim() === '') {
                await performLogin(null);
            } else if (accounts[id-1]) {
                await performLogin(accounts[id-1]);
            } else {
                console.log(`${c.e}❌ Invalid selection.${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '2') {
            const id = await prompt('SELECT NUMBER TO REMOVE: ');
            if (accounts[id-1]) {
                console.log(`${c.w}Removed ${accounts[id-1].name}${c.rst}`);
                accounts.splice(id-1, 1);
                saveAllAccounts(accounts);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '3') {
            const id = await prompt('SELECT NUMBER TO TOGGLE PAUSE: ');
            if (accounts[id-1]) {
                accounts[id-1].paused = !accounts[id-1].paused;
                saveAllAccounts(accounts);
                console.log(`${c.g}✅ ${accounts[id-1].name} Paused: ${accounts[id-1].paused}${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '4') {
            console.clear();
            console.log(`${c.g}🚀 LAUNCHING INDEX.JS...${c.rst}\n`);
            const child = spawn('node', ['index.js'], { stdio: 'inherit' });
            child.on('close', (code) => { process.exit(code); });
            break; 
        }
    }
}

main().catch(err => console.error(err));
