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

// --- LOGS MANAGEMENT ---
const getLogs = () => {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
};

const saveLogs = (l) => {
    fs.writeFileSync(LOGS_JSON, JSON.stringify(l, null, 2));
};

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

function createMiniClient(acc) {
    return axios.create({
        baseURL: MINI_API_BASE,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Redmi Note 8 Pro Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Mobile Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'origin': 'https://interlink-mini-app.interlinklabs.ai',
            'referer': 'https://interlink-mini-app.interlinklabs.ai/qi-hong-interlink/',
            'Authorization': `Bearer ${acc.miniToken}`,
            'Cookie': `jwt_${APP_ID}=${acc.miniToken}`
        },
        httpsAgent: getAgent(acc.proxy),
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
    if (!acc.miniToken) {
        console.log(`${c.cy}⸽ ${c.e}NO MINI TOKEN. PLEASE RUN PROFILE SYNC IN LOGIN.JS.${c.rst}`);
        return;
    }

    const mainClient = createMainClient(acc);
    const miniClient = createMiniClient(acc);
    const id = acc.email || acc.deviceId || acc.loginId;
    const today = moment.utc().format('YYYY-MM-DD');

    // Load Logs
    let logs = getLogs();
    if (!logs[today]) logs[today] = {};
    if (!logs[today][id]) logs[today][id] = { tokens: { G: 0, S: 0, D: 0, INT: 0 }, windows: {}, spinProfit: 0 };
    if (logs[today][id].spinProfit === undefined) logs[today][id].spinProfit = 0;

    // 1. Fetch Initial Balance
    let currentBal = 0;
    try {
        const balRes = await mainClient.get('/token/get-token');
        currentBal = parseFloat(balRes.data.data.interlinkGoldTokenAmount || 0);
        
        // Formatted Daily PnL
        const allTimeSpin = logs[today][id].spinProfit;
        const pColor = allTimeSpin > 0 ? c.g : (allTimeSpin < 0 ? c.e : c.gr);
        const sign = allTimeSpin > 0 ? '+' : '';
        
        console.log(`${c.cy}⸽ ${c.rst}Starting Gold Balance: ${c.w}${currentBal.toFixed(2)} ITLG${c.rst} | Daily Spin PnL: ${pColor}${sign}${allTimeSpin.toFixed(2)}${c.rst}`);
        console.log(`${c.cy}─${c.rst}`.repeat(65));
    } catch (e) {
        console.log(`${c.cy}⸽ ${c.e}Failed to fetch initial balance. Skipping account.${c.rst}`);
        return;
    }

    // 2. The Random 10-20 Spin Loop
    const maxSpins = Math.floor(Math.random() * 11) + 10; 
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
                    console.log(`  ${c.cy}⸽ ${c.e}BUY FAILED.${c.rst}`);
                    break;
                }
            }
        } catch (e) {
            console.log(`  ${c.cy}⸽ ${c.e}BUY ERROR: ${e.response?.status || e.message}${c.rst}`);
            break;
        }

        // --- STEP B: WAIT 5 SECONDS ---
        await delay(5000);

        // --- STEP C: SPIN ---
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

        // --- STEP D: WAIT 5 SECONDS ---
        await delay(5000);

        // --- STEP E: CHECK BALANCE & LOG MATH ---
        try {
            const newBalRes = await mainClient.get('/token/get-token');
            const newBal = parseFloat(newBalRes.data.data.interlinkGoldTokenAmount || 0);
            
            const diff = newBal - currentBal; 
            currentBal = newBal;
            sessionProfit += diff;
            
            // Color logic: Green for positive, Red for negative, Gray for zero
            const diffColor = diff > 0 ? c.g : (diff < 0 ? c.e : c.gr);
            const diffSign = diff > 0 ? '+' : '';
            
            console.log(`  ${c.cy}⸽ ${c.wh}${i.toString().padStart(2, '0')}. Net: ${diffColor}${diffSign}${diff.toFixed(2)}${c.rst} | Bal: ${c.w}${currentBal.toFixed(2)}${c.rst}`);
        } catch (e) {
            console.log(`  ${c.cy}⸽ ${c.gr}${i.toString().padStart(2, '0')}. Balance Check Failed${c.rst}`);
        }
    }

    // 3. Update Logs and Show Summary
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
    console.log(`      ${c.gr}Algorithm: Random 10-20x Loop | 5s Staggered Delays${c.rst}\n`);

    let accounts = [];
    try { 
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); 
    } catch(e) { 
        console.log(`${c.e}Failed to read accounts.json. Please ensure it exists.${c.rst}`);
        process.exit(1);
    }

    if (accounts.length === 0) {
        console.log(`${c.w}No accounts found.${c.rst}`);
        process.exit(0);
    }

    for (let i = 0; i < accounts.length; i++) {
        await processAccount(accounts[i], i);
        if (i < accounts.length - 1) {
            console.log(`${c.gr}Cooling down for 10 seconds before next account...${c.rst}\n`);
            await delay(10000); 
        }
    }

    // This is where the missing closing bracket was restored!
    console.log(`\n${c.g}${c.b}>>> ALL ACCOUNTS PROCESSED. CLOSING MODULE. <<<${c.rst}\n`);
    process.exit(0);
}

main().catch(err => console.log(`\n${c.e}FATAL ERROR: ${err.message}${c.rst}`));
