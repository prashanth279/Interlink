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
            const miniRes = await axios.post(`${MINI_API_URL}/tracking/verify`,
                { loginId, appId: 'id__mk39oef6we80fs7j2rif' },
                { headers: { 'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7', 'Authorization': `Bearer ${token}` }, httpsAgent: agent }
            );
            const miniToken = miniRes.data?.data?.token || miniRes.data?.token || null;
            saveAccount({ name: realName, token, miniToken, deviceId, proxy, ...identity });
            console.log(`${c.g}✅ ACCOUNT_SAVED: ${realName}${c.rst}`);
            if (miniToken) console.log(`${c.g}✅ MINI_TOKEN_LINKED${c.rst}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e) {
        console.log(`${c.r}❌ AUTH_FAILED: ${e.response?.data?.message || e.message}${c.rst}`);
        await prompt('Press Enter to return...');
    }
}

function saveAccount(acc) {
    let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
    const idx = accounts.findIndex(a => a.deviceId === acc.deviceId);
    const formattedAcc = { ...acc, lastUpdate: moment().format('YYYY-MM-DD HH:mm:ss') };
    if (idx !== -1) accounts[idx] = formattedAcc; else accounts.push(formattedAcc);
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

async function main() {
    while (true) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK_MANAGER_v3.4${c.rst} ${c.m}══${c.rst}\n`);
        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));

        if (accounts.length > 0) {
            accounts.forEach((a, i) => {
                const s = a.miniToken ? `${c.g}YES${c.rst}` : `${c.r}NO${c.rst}`;
                console.log(`${c.cy}⫸ ${c.w}${i+1}. ${a.name.padEnd(12)}${c.rst} | SPN: ${s}`);
            });
        } else { console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND${c.rst}`); }

        console.log(`\n${c.cy}⫹── ${c.b}${c.w}1. ADD/FIX | 2. REMOVE | 3. EXIT${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');
        if (choice === '1') {
            const id = await prompt('ID (OR BLANK): ');
            await performLogin(accounts[id-1] || null);
        } else if (choice === '2') {
            const id = await prompt('REMOVE ID: ');
            if (accounts[id-1]) {
                accounts.splice(id-1, 1);
                fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
            }
        } else if (choice === '3') process.exit(0);
    }
}
main().catch(err => console.error(err));
