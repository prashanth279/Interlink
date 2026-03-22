const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const WINDOWS = [0, 4, 8, 12, 16, 20];

// Advanced 256-Color Palette & Formatting
const c = {
    p: '\x1b[38;5;39m',   // Primary Blue
    s: '\x1b[38;5;198m',  // Secondary Pink
    a: '\x1b[38;5;118m',  // Accent Green
    w: '\x1b[38;5;220m',  // Warning Gold
    e: '\x1b[38;5;196m',  // Error Red
    g: '\x1b[38;5;46m',   // Success Green
    wh: '\x1b[97m',       // Bright White
    gr: '\x1b[38;5;245m', // Gray
    b: '\x1b[1m',         // Bold
    rst: '\x1b[0m'        // Reset
};

// Clean Box Drawing Characters
const box = {
    tl: '┌', tr: '┐', bl: '└', br: '┘', 
    h: '─', v: '│', ml: '├', mr: '┤'
};

// Global State
let forecasts = {};
let currentStatus = {};
let proxyStatus = {};
let isShuttingDown = false;

// --- MIGRATION & BACKWARD COMPATIBILITY ---
function migrateData() {
    let accounts = [];
    try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); } catch(e) { accounts = []; }
    
    let accUpdated = false;
    accounts.forEach(acc => {
        if (!acc.deviceId) {
            acc.deviceId = crypto.randomBytes(8).toString('hex');
            accUpdated = true;
        }
    });
    if (accUpdated) {
        fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
    }

    let logs = {};
    try { logs = JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch(e) { logs = {}; }
    
    let logsUpdated = false;
    for (const day in logs) {
        for (const id in logs[day]) {
            if (logs[day][id].currentGold !== undefined) {
                logs[day][id].tokens = {
                    G: logs[day][id].currentGold,
                    S: 0, D: 0, INT: 0
                };
                delete logs[day][id].currentGold;
                logsUpdated = true;
            }
        }
    }
    if (logsUpdated) {
        fs.writeFileSync(LOGS_JSON, JSON.stringify(logs, null, 2));
    }
    
    return { accounts, logs };
}

// --- UTILITIES ---
const getLogs = () => {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
};

const saveLogs = (l) => {
    if (!isShuttingDown) fs.writeFileSync(LOGS_JSON, JSON.stringify(l, null, 2));
};

function extractIp(proxyUrl) {
    if (!proxyUrl) return 'NONE';
    try {
        const match = proxyUrl.match(/@([\d\.]+):/);
        return match ? match[1] : proxyUrl.split('://')[1].split(':')[0];
    } catch (e) { return 'UNKNOWN_IP'; }
}

function getJwtExp(token) {
    if (!token) return 0;
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return payload.exp;
    } catch (e) { return 0; }
}

function getNextWindow() {
    const now = moment.utc();
    let next = WINDOWS.find(h => h > now.hour());
    if (next === undefined) next = 0;
    let nextDate = moment.utc().hour(next).minute(0).second(0).millisecond(0);
    if (next === 0 && now.hour() >= 20) nextDate.add(1, 'day');
    return nextDate;
}

function maskData(str) {
    if (!str) return 'N/A';
    if (str.includes('@')) {
        const [local, domain] = str.split('@');
        if (local.length <= 3) return `${local[0]}***@${domain}`;
        return `${local.substring(0, 3)}***${local.substring(local.length - 2)}@${domain}`;
    }
    return str.length > 8 ? `${str.substring(0, 4)}***${str.substring(str.length - 4)}` : str;
}

// --- CORE API CLIENT (WITH SECURITY INJECTIONS) ---
function createClient(acc, proxy) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : new https.Agent({ rejectUnauthorized: false });
    
    const config = {
        baseURL: API_BASE,
        headers: { 
            'Authorization': `Bearer ${acc.token}`, 
            'User-Agent': 'okhttp/4.12.0',
            'Accept-Encoding': 'gzip',
            'x-unique-id': acc.deviceId,
            'x-model': 'Redmi Note 8 Pro',
            'x-brand': 'XiaoMi',
            'x-system-name': 'Android',
            'x-device-id': acc.deviceId,
            'x-bundle-id': 'org.ai.interlinklabs.interlinkId',
            'version': '1.1.8'
        },
        httpsAgent: agent, 
        timeout: 15000,
        proxy: false
    };

    const instance = axios.create(config);

    // Security: Payload Hashing Interceptor
    instance.interceptors.request.use((conf) => {
        conf.headers['x-date'] = Date.now().toString();
        if (conf.method === 'post') {
            const body = conf.data ? (typeof conf.data === 'object' ? JSON.stringify(conf.data) : conf.data.toString()) : "{}";
            conf.headers['x-content-hash'] = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
        }
        return conf;
    });

    return instance;
}

// --- PULSE CHECK ---
async function pulseCheck(proxyUrl) {
    try {
        const agent = proxyUrl ? (proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl.trim()) : new HttpsProxyAgent(proxyUrl.trim())) : null;
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
        return true;
    } catch (e) {
        return false;
    }
}

// --- ACCOUNT PROCESSING ---
async function processAccount(acc) {
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    const yesterday = moment.utc().subtract(1, 'day').format('YYYY-MM-DD');
    let logs = getLogs();
    
    const id = acc.email || acc.deviceId;
    if (!logs[today]) logs[today] = {};
    if (!logs[today][id]) {
        logs[today][id] = { startBal: null, windows: {}, tokens: { G: 0, S: 0, D: 0, INT: 0 }, lastSync: null };
    }
    let accLog = logs[today][id];

    // 1. JWT Pre-Check
    const exp = getJwtExp(acc.token);
    const nowTs = Math.floor(Date.now() / 1000);
    if (exp > 0 && nowTs > exp) {
        currentStatus[id] = `${c.e}AUTH_EXP${c.rst}`;
        return;
    }

    // 2. Pulse Check
    const hasProxy = !!acc.proxy;
    const proxyIp = extractIp(acc.proxy);
    const isAlive = await pulseCheck(acc.proxy);
    
    if (!isAlive) {
        proxyStatus[id] = hasProxy ? `${c.e}${proxyIp} ● DEAD${c.rst}` : `${c.e}LOCAL_NET ● DEAD${c.rst}`;
        currentStatus[id] = `${c.e}CONN_FAIL${c.rst}`;
        return;
    }
    
    proxyStatus[id] = hasProxy ? `${c.p}${proxyIp} ● ONLINE${c.rst}` : `${c.gr}NONE${c.rst}`;

    // 3. API Execution
    const isClaimNeeded = (forecasts[id] && now.isSameOrAfter(forecasts[id])) || !accLog.lastSync;
    
    if (!isClaimNeeded) {
        currentStatus[id] = `${c.gr}STEALTH MODE${c.rst}`;
        return;
    }

    const client = createClient(acc, acc.proxy);
    const winHour = ([...WINDOWS].reverse().find(h => h <= now.hour()) || 0).toString().padStart(2, '0');

    try {
        currentStatus[id] = `${c.w}SYNCING...${c.rst}`;
        
        // Fetch Balance
        const balRes = await client.get('/token/get-token');
        const tData = balRes.data.data;
        accLog.tokens = {
            G: parseFloat(tData.interlinkGoldTokenAmount || 0),
            S: parseFloat(tData.interlinkSilverTokenAmount || 0),
            D: parseFloat(tData.interlinkDiamondTokenAmount || 0),
            INT: parseFloat(tData.interlinkTokenAmount || 0)
        };
        accLog.lastSync = moment().format('HH:mm:ss');
        if (accLog.startBal === null) accLog.startBal = accLog.tokens.G;

        // Check Claim
        const check = await client.get('/token/check-is-claimable');
        if (check.data?.data?.isClaimable) {
            currentStatus[id] = `${c.g}CLAIMING...${c.rst}`;
            await client.post('/token/claim-airdrop', {});
            accLog.windows[winHour] = moment().format('HH:mm');
            
            // Refresh balance
            const postBal = await client.get('/token/get-token');
            accLog.tokens.G = parseFloat(postBal.data.data.interlinkGoldTokenAmount || 0);
            currentStatus[id] = `${c.g}CLAIM SUCCESS${c.rst}`;
        } else {
            currentStatus[id] = `${c.a}WINDOW COMPLETE${c.rst}`;
            if (!accLog.windows[winHour]) accLog.windows[winHour] = "DONE";
        }
        
        forecasts[id] = moment.utc(getNextWindow()).add(Math.floor(Math.random() * 15) + 5, 'minutes');
        saveLogs(logs);

    } catch (e) {
        if (e.response) {
            currentStatus[id] = `${c.e}ERR_${e.response.status}${c.rst}`;
        } else {
            currentStatus[id] = `${c.e}API_DOWN${c.rst}`;
        }
    }
}

// --- DASHBOARD RENDERER ---
function renderDashboard(accounts, winStartUtc, winEndUtc, rem) {
    console.clear();
    const localWinStart = moment.utc().hour(winStartUtc).minute(0).local().format('HH:mm');
    const localWinEnd = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).local().format('HH:mm');
    const logs = getLogs();
    const yesterday = moment.utc().subtract(1, 'day').format('YYYY-MM-DD');
    const today = moment.utc().format('YYYY-MM-DD');
    const width = 65;

    // Header
    console.log(`${c.p}${box.tl}${box.h.repeat(width)}${box.tr}${c.rst}`);
    const title = `INTERLINK FARMER: STEALTH EDITION`;
    const titlePad = Math.floor((width - title.length) / 2);
    console.log(`${c.p}${box.v}${c.rst}${' '.repeat(titlePad)}${c.s}${c.b}${title}${c.rst}${' '.repeat(width - titlePad - title.length)}${c.p}${box.v}${c.rst}`);
    
    const sub = `GMT ${moment().format('Z')} | Window: ${localWinStart}-${localWinEnd} | Rem: ${rem.hours()}h ${rem.minutes()}m`;
    const subPad = Math.floor((width - sub.length) / 2);
    console.log(`${c.p}${box.v}${c.rst}${' '.repeat(subPad)}${c.gr}${sub}${c.rst}${' '.repeat(width - subPad - sub.length)}${c.p}${box.v}${c.rst}`);
    console.log(`${c.p}${box.ml}${box.h.repeat(width)}${box.mr}${c.rst}`);

    // Accounts
    accounts.forEach((acc, idx) => {
        const id = acc.email || acc.deviceId;
        const nameStr = acc.name || maskData(id);
        const accLog = logs[today]?.[id] || { tokens: { G: 0, S: 0, D: 0, INT: 0 }, startBal: 0 };
        const prevLog = logs[yesterday]?.[id] || null;
        
        const dailyProfit = (accLog.tokens.G - (accLog.startBal || accLog.tokens.G)).toFixed(2);
        const stat = currentStatus[id] || `${c.gr}WAITING${c.rst}`;
        const pStat = proxyStatus[id] || `${c.gr}CHECKING${c.rst}`;

        console.log(`${c.p}${box.v}${c.rst} ${c.wh}${c.b}Acc ${idx + 1}:${c.rst} ${c.p}${nameStr}${c.rst} | ${pStat}${' '.repeat(Math.max(0, width - 15 - nameStr.length - pStat.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.p}${box.v}${c.rst}`);
        console.log(`${c.p}${box.v}${c.rst} Status: ${stat}${' '.repeat(Math.max(0, width - 9 - stat.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.p}${box.v}${c.rst}`);
        
        const tStr = `G: ${c.w}${accLog.tokens.G.toFixed(2)}${c.rst} | S: ${c.wh}${accLog.tokens.S.toFixed(2)}${c.rst} | D: ${c.p}${accLog.tokens.D.toFixed(2)}${c.rst} | INT: ${c.g}${accLog.tokens.INT.toFixed(2)}${c.rst}`;
        console.log(`${c.p}${box.v}${c.rst} ${tStr}${' '.repeat(Math.max(0, width - 1 - tStr.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.p}${box.v}${c.rst}`);
        
        let profitStr = `Profit: ${c.g}+${dailyProfit}${c.rst} ${c.gr}(${accLog.lastSync || '--'})${c.rst}`;
        if (prevLog) profitStr += ` | YST: ${c.wh}${prevLog.tokens.G.toFixed(2)}${c.rst}`;
        console.log(`${c.p}${box.v}${c.rst} ${profitStr}${' '.repeat(Math.max(0, width - 1 - profitStr.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.p}${box.v}${c.rst}`);
        
        const now = moment.utc();
        const tM = forecasts[id] ? moment.duration(forecasts[id].diff(now)) : null;
        const cdStr = (tM && tM.asSeconds() > 0) ? `${c.gr}(T-${tM.hours()}h ${tM.minutes()}m)${c.rst}` : `${c.g}(SYNC)${c.rst}`;
        const nextStr = forecasts[id] ? forecasts[id].local().format('HH:mm:ss') : "CALCULATING";
        
        const foot = `Next Claim: ${c.b}${c.wh}${nextStr}${c.rst} ${cdStr}`;
        console.log(`${c.p}${box.v}${c.rst} ${foot}${' '.repeat(Math.max(0, width - 1 - foot.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.p}${box.v}${c.rst}`);
        
        if (idx < accounts.length - 1) {
            console.log(`${c.p}${box.ml}${box.h.repeat(width)}${box.mr}${c.rst}`);
        }
    });

    console.log(`${c.p}${box.bl}${box.h.repeat(width)}${box.br}${c.rst}`);
}

// --- MAIN LOOP ---
async function main() {
    const { accounts, logs } = migrateData();
    
    // Initialize Forecasts
    accounts.forEach(acc => {
        const id = acc.email || acc.deviceId;
        if (!forecasts[id]) {
            const nW = getNextWindow(), curS = moment.utc(nW).subtract(4, 'hours');
            const winK = curS.hour().toString().padStart(2, '0'), today = moment.utc().format('YYYY-MM-DD');
            const rand = Math.floor(Math.random() * 15) + 5;
            let target = moment.utc(curS).add(rand, 'minutes');
            if (logs[today]?.[id]?.windows?.[winK]) forecasts[id] = moment.utc(nW).add(rand, 'minutes');
            else forecasts[id] = moment.utc().isAfter(target) ? moment.utc().add(1, 'minute') : target;
        }
    });

    while (!isShuttingDown) {
        const now = moment.utc();
        const winStartUtc = Math.floor(now.hour() / 4) * 4;
        const winEndUtc = (winStartUtc + 4) % 24;
        const diff = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).second(0).diff(now);
        const rem = moment.duration(diff);

        renderDashboard(accounts, winStartUtc, winEndUtc, rem);

        for (let i = 0; i < accounts.length; i++) { 
            if (isShuttingDown) break;
            await processAccount(accounts[i]); 
            renderDashboard(accounts, winStartUtc, winEndUtc, rem);
        }
        
        // Heartbeat Loop (Can be interrupted by SIGINT)
        for (let i = 60; i > 0; i--) { 
            if (isShuttingDown) break;
            process.stdout.write(`\r ${c.p}⫸${c.rst} HEARTBEAT: ${c.w}${i}s${c.rst} (Press Ctrl+C to safely exit)  `); 
            await new Promise(r => setTimeout(r, 1000)); 
        }
    }
}

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
    isShuttingDown = true;
    console.log(`\n\n${c.w}${box.tl}${box.h.repeat(40)}${box.tr}${c.rst}`);
    console.log(`${c.w}${box.v}${c.rst} ${c.e}${c.b}SHUTTING DOWN SAFELY...${c.rst}                  ${c.w}${box.v}${c.rst}`);
    console.log(`${c.w}${box.v}${c.rst} ${c.wh}Saving logs.json to prevent corruption${c.rst}   ${c.w}${box.v}${c.rst}`);
    console.log(`${c.w}${box.bl}${box.h.repeat(40)}${box.br}${c.rst}\n`);
    
    // Ensure final save happens before exit
    fs.writeFileSync(LOGS_JSON, JSON.stringify(getLogs(), null, 2));
    process.exit(0);
});

main().catch(err => console.log(`\n${c.e}FATAL ERROR: ${err.message}${c.rst}`));
