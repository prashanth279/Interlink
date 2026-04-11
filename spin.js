const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const moment = require('moment');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API_BASE = 'https://interlink-mini-app.interlinklabs.ai/api';
const APP_ID = 'id__mk39oef6we80fs7j2rif';

// Advanced 256-Color Palette
const c = {
    p: '\x1b[38;5;39m',
    s: '\x1b[38;5;198m',
    a: '\x1b[38;5;118m',
    w: '\x1b[38;5;220m',
    e: '\x1b[38;5;196m',
    g: '\x1b[38;5;46m',
    wh: '\x1b[97m',
    gr: '\x1b[38;5;245m',
    cy: '\x1b[36m',
    b: '\x1b[1m',
    rst: '\x1b[0m'
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getAgent(proxyUrl) {
    if (!proxyUrl || proxyUrl.toUpperCase() === 'NONE') return new https.Agent({ rejectUnauthorized: false });
    return proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

const getLogs = () => {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
};

const saveLogs = (l) => {
    fs.writeFileSync(LOGS_JSON, JSON.stringify(l, null, 2));
};

// --- AUTH: THE 401 FIREWALL BYPASS ---
async function getMiniToken(acc, agent) {
    try {
        const payload = { loginId: acc.loginId || acc.email, appId: APP_ID };
        const bodyStr = JSON.stringify(payload);
        const hash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('base64');
        const deviceId = acc.deviceId || crypto.randomBytes(8).toString('hex');

        const res = await axios.post('https://interlink-mini-app.interlinklabs.ai/api/tracking/verify',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${acc.token}`,
                    'api-public': 'e97ae0aa6520499d9edf20bd5a1e13c7',
                    'User-Agent': 'okhttp/4.12.0',
                    'Content-Type': 'application/json',
                    'x-date': Date.now().toString(),
                    'x-content-hash': hash,
                    'x-unique-id': deviceId,
                    'x-model': 'Redmi Note 8 Pro',
                    'x-brand': 'XiaoMi',
                    'x-system-name': 'Android',
                    'x-device-id': deviceId,
                    'x-bundle-id': 'org.ai.interlinklabs.interlinkId',
                    'version': '1.1.6'
                },
                httpsAgent: agent,
                timeout: 15000
            }
        );
        return res.data.data?.token || res.data.data?.jwtToken;
    } catch (e) {
        console.log(`  ${c.cy}⸽ ${c.e}Verify Error: ${e.response?.status || 'Timeout'} - ${JSON.stringify(e.response?.data?.message || e.message)}${c.rst}`);
        return null;
    }
}

// --- API CLIENTS ---
function createMainClient(acc) {
    return axios.create({
        baseURL: API_BASE,
        headers: {
            'Authorization': `Bearer ${acc.token}`,
            'User-Agent': 'okhttp/4.12.0',
            'Content-Type': 'application/json'
        },
        httpsAgent: getAgent(acc.proxy),
        timeout: 15000
    });
}

function createMiniClient(freshMiniToken, proxyUrl) {
    return axios.create({
        baseURL: MINI_API_BASE,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Redmi Note 8 Pro Build/V417IR; wv) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
            'origin': 'https://interlink-mini-app.interlinklabs.ai',
            'referer': 'https://interlink-mini-app.interlinklabs.ai/qi-hong-interlink/',
            'Authorization': `Bearer ${freshMiniToken}`,
            'Cookie': `jwt_${APP_ID}=${freshMiniToken}`
        },
        httpsAgent: getAgent(proxyUrl),
        timeout: 15000
    });
}

// --- ACCOUNT PROCESSOR ---
async function processAccount(acc, idx) {
    console.log(`${c.cy}─${c.rst}`.repeat(65));
    console.log(`${c.cy}⫸ ${c.wh}${c.b}Acc ${idx + 1}:${c.rst} ${c.p}${acc.name || acc.loginId}${c.rst} | Spin Module Initiated`);

    if (acc.paused) {
        console.log(`${c.cy}⸽ ${c.e}ACCOUNT PAUSED. SKIPPING.${c.rst}`);
        return;
    }

    const agent = getAgent(acc.proxy);
    const mainClient = createMainClient(acc);

    const freshMiniToken = await getMiniToken(acc, agent);
    if (!freshMiniToken) {
        console.log(`${c.cy}⸽ ${c.e}AUTH ERROR: 401 (Failed to generate Mini Token). Skipping.${c.rst}`);
        return;
    }
    const miniClient = createMiniClient(freshMiniToken, acc.proxy);

    const id = acc.email || acc.deviceId || acc.loginId;
    const today = moment.utc().format('YYYY-MM-DD');

    let logs = getLogs();
    if (!logs[today]) logs[today] = {};
    if (!logs[today][id]) logs[today][id] = { tokens: { G: 0, S: 0, D: 0, INT: 0 }, windows: {}, spinProfit: 0 };
    if (logs[today][id].spinProfit === undefined) logs[today][id].spinProfit = 0;

    let currentBal = 0;
    try {
        const balRes = await mainClient.get('/token/get-token');
        currentBal = parseFloat(balRes.data.data.interlinkGoldTokenAmount || 0);

        const allTimeSpin = logs[today][id].spinProfit;
        const pColor = allTimeSpin > 0 ? c.g : (allTimeSpin < 0 ? c.e : c.gr);
        const sign = allTimeSpin > 0 ? '+' : '';

        console.log(`${c.cy}⸽ ${c.rst}Starting Gold Balance: ${c.w}${currentBal.toFixed(2)} ITLG${c.rst} | Daily Spin PnL: ${pColor}${sign}${allTimeSpin.toFixed(2)}${c.rst}`);
        console.log(`${c.cy}─${c.rst}`.repeat(65));
    } catch (e) {
        console.log(`${c.cy}⸽ ${c.e}Failed to fetch initial balance. Skipping account.${c.rst}`);
        return;
    }

    // Exact 5 Spin Loop
    const maxSpins = 5;
    let sessionProfit = 0;

    for (let i = 1; i <= maxSpins; i++) {
        // --- STEP A: BUY TICKET ---
        try {
            const tRes = await miniClient.get('/spin-ticket/get-number-of-tickets');
            if (tRes.data.data.numberOfTickets === 0) {
                if (currentBal < 50 && !tRes.data.data.isFirstTicket) {
                    console.log(`  ${c.cy}⸽ ${c.e}INSUFFICIENT FUNDS (< 50 ITLG). ABORTING LOOP.${c.rst}`);
                    break;
                }
                const buyRes = await miniClient.post('/spin-ticket/buy', null, { headers: { 'x-ref-id': crypto.randomUUID() } });
                if (!buyRes.data.success) {
                    console.log(`  ${c.cy}⸽ ${c.e}BUY FAILED: ${buyRes.data?.message || 'Unknown'}${c.rst}`);
                    break;
                }
            }
        } catch (e) {
            console.log(`  ${c.cy}⸽ ${c.e}BUY ERROR: ${e.response?.status || e.message}${c.rst}`);
            break;
        }

        await delay(5000);

        // --- STEP B: SPIN ---
        try {
            const spinRes = await miniClient.get('/spin-reward/generate-random');
            if (!spinRes.data.success) {
                console.log(`  ${c.cy}⸽ ${c.e}SPIN FAILED.${c.rst}`);
                break;
            }
        } catch (e) {
            console.log(`  ${c.cy}⸽ ${c.e}SPIN ERROR: ${e.response?.status || e.message}${c.rst}`);
            break;
        }

        await delay(5000);

        // --- STEP C: CHECK BALANCE ---
        try {
            const newBalRes = await mainClient.get('/token/get-token');
            const newBal = parseFloat(newBalRes.data.data.interlinkGoldTokenAmount || 0);

            const diff = newBal - currentBal;
            currentBal = newBal;
            sessionProfit += diff;

            const diffColor = diff > 0 ? c.g : (diff < 0 ? c.e : c.gr);
            const diffSign = diff > 0 ? '+' : '';

            console.log(`  ${c.cy}⸽ ${c.wh}${i.toString().padStart(2, '0')}. Net: ${diffColor}${diffSign}${diff.toFixed(2)}${c.rst} | Bal: ${c.w}${currentBal.toFixed(2)}${c.rst}`);
        } catch (e) {
            console.log(`  ${c.cy}⸽ ${c.e}${i.toString().padStart(2, '0')}. Balance Check Failed (Status: ${e.response?.status || 'Timeout'})${c.rst}`);
        }
    }

    logs[today][id].spinProfit += sessionProfit;
    saveLogs(logs);

    const netColor = sessionProfit > 0 ? c.g : (sessionProfit < 0 ? c.e : c.gr);
    const netSign = sessionProfit > 0 ? '+' : '';
    console.log(`${c.cy}─${c.rst}`.repeat(65));
    console.log(`${c.cy}⫹── ${c.b}SESSION COMPLETE | Earned: ${netColor}${netSign}${sessionProfit.toFixed(2)}${c.rst}\n`);
}

async function main() {
    console.clear();
    console.log(`\n           ${c.w}${c.b}INTERLINK LUCKY SPIN MODULE${c.rst}`);
    console.log(`      ${c.gr}Algorithm: Exactly 5x Loop | 5s Staggered Delays${c.rst}\n`);

    let accounts = [];
    try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); } 
    catch(e) { console.log(`${c.e}Failed to read accounts.json.${c.rst}`); process.exit(1); }

    if (accounts.length === 0) { console.log(`${c.w}No accounts found.${c.rst}`); process.exit(0); }

    for (let i = 0; i < accounts.length; i++) {
        await processAccount(accounts[i], i);
        if (i < accounts.length - 1) {
            console.log(`${c.gr}Cooling down for 10 seconds before next account...${c.rst}\n`);
            await delay(10000);
        }
    }

    console.log(`\n${c.g}${c.b}>>> ALL ACCOUNTS PROCESSED. CLOSING MODULE. <<<${c.rst}\n`);
    process.exit(0);
}

main().catch(err => console.log(`\n${c.e}FATAL ERROR: ${err.message}${c.rst}`));
