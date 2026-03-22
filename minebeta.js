const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const WINDOWS = [0, 4, 8, 12, 16, 20];

const c = { 
    cy: '\x1b[36m', m: '\x1b[35m', y: '\x1b[33m', g: '\x1b[32m', 
    r: '\x1b[31m', w: '\x1b[37m', gr: '\x1b[90m', b: '\x1b[1m', rst: '\x1b[0m' 
};

let forecasts = {};
let currentStatus = {};

const getLogs = () => {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
};
const saveLogs = (l) => fs.writeFileSync(LOGS_JSON, JSON.stringify(l, null, 2));

function getNextWindow() {
    const now = moment.utc();
    let next = WINDOWS.find(h => h > now.hour());
    if (next === undefined) next = 0;
    let nextDate = moment.utc().hour(next).minute(0).second(0).millisecond(0);
    if (next === 0 && now.hour() >= 20) nextDate.add(1, 'day');
    return nextDate;
}

function createClient(acc, proxy) {
    let agent;
    if (proxy) {
        const proxyUrl = proxy.trim();
        if (proxyUrl.startsWith('socks')) {
            agent = new SocksProxyAgent(proxyUrl);
        } else {
            agent = new HttpsProxyAgent(proxyUrl);
        }
    } else {
        agent = new https.Agent({ rejectUnauthorized: false });
    }

    return axios.create({
        baseURL: API_BASE,
        headers: { 
            'Authorization': `Bearer ${acc.token}`, 
            'User-Agent': 'okhttp/4.12.0', 
            'x-unique-id': acc.deviceId, 
            'version': '1.1.8' 
        },
        httpsAgent: agent,
        proxy: false, // Disables axios default proxy logic to use our agent
        timeout: 15000
    });
}

async function processAccount(acc, index, proxies) {
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    const yesterday = moment.utc().subtract(1, 'day').format('YYYY-MM-DD');
    let logs = getLogs();

    if (!logs[today]) logs[today] = {};
    if (!logs[today][acc.deviceId]) {
        logs[today][acc.deviceId] = { startBal: null, windows: {}, currentGold: 0, lastSync: null };
    }
    let accLog = logs[today][acc.deviceId];
    let prevLog = logs[yesterday]?.[acc.deviceId] || null;

    const proxyList = [acc.proxy, ...proxies].filter(p => p && p.trim().length > 0);
    const winHour = ([...WINDOWS].reverse().find(h => h <= now.hour()) || 0).toString().padStart(2, '0');
    
    const isInitial = accLog.lastSync === null;
    const isClaimNeeded = !accLog.windows[winHour] && (forecasts[acc.deviceId] && now.isSameOrAfter(forecasts[acc.deviceId]));
    
    let client = null, data = null;

    if (isInitial || isClaimNeeded) {
        let attemptProxy = proxyList.length > 0 ? proxyList.slice(0,3) : [null];
        for (let p of attemptProxy) {
            try {
                const test = createClient(acc, p);
                const res = await test.get('/token/get-token');
                data = res.data.data; client = test; break;
            } catch (e) { currentStatus[acc.deviceId] = `${c.r}CONN_FAIL${c.rst}`; }
        }
    } else {
        currentStatus[acc.deviceId] = `${c.gr}STEALTH MODE${c.rst}`;
    }

    if (client && data) {
        accLog.currentGold = parseFloat(data.interlinkGoldTokenAmount);
        accLog.lastSync = moment().format('HH:mm:ss');
        if (accLog.startBal === null) accLog.startBal = accLog.currentGold;

        const check = await client.get('/token/check-is-claimable');
        if (check.data?.data?.isClaimable) {
            currentStatus[acc.deviceId] = `${c.g}CLAIMING...${c.rst}`;
            await client.post('/token/claim-airdrop', {});
            accLog.windows[winHour] = moment().format('HH:mm');
            
            const post = await client.get('/token/get-token');
            accLog.currentGold = parseFloat(post.data.data.interlinkGoldTokenAmount);
            currentStatus[acc.deviceId] = `${c.g}SUCCESS${c.rst}`;
            forecasts[acc.deviceId] = moment.utc(getNextWindow()).add(Math.floor(Math.random() * 15) + 5, 'minutes');
        } else {
            currentStatus[acc.deviceId] = `${c.gr}WINDOW_COMPLETE${c.rst}`;
            if (!accLog.windows[winHour]) accLog.windows[winHour] = "DONE"; 
            forecasts[acc.deviceId] = moment.utc(getNextWindow()).add(Math.floor(Math.random() * 15) + 5, 'minutes');
        }
    }

    // --- DISPLAY ---
    const dailyProfit = (accLog.currentGold - (accLog.startBal || accLog.currentGold)).toFixed(2);
    console.log(`${c.cy}⫸ ${c.b}${c.w}${acc.name || acc.deviceId.substring(0,12)} ${c.cy}⫷`);
    console.log(`${c.cy}⸽ ${c.rst}STATUS: ${currentStatus[acc.deviceId]}`);
    console.log(`${c.cy}⸽ ${c.y}${accLog.currentGold.toFixed(2)}${c.rst} ${c.gr}(${accLog.lastSync || '--'})${c.rst} ${c.gr}|${c.rst} ${c.g}+${dailyProfit}${c.rst} ${c.gr}DAY${c.rst}`);
    
    if (prevLog) {
        console.log(`${c.cy}⸽ ${c.rst}YST: ${c.w}${prevLog.currentGold.toFixed(2)}${c.rst} ${c.gr}@${prevLog.lastSync || 'EOD'}${c.rst}`);
    }

    const windowPairs = [[0,4], [8,12], [16,20]];
    windowPairs.forEach(pair => {
        const line = pair.map(h => {
            const k = h.toString().padStart(2, '0');
            const s = accLog.windows[k];
            if (s && s !== "DONE") return `${c.g}${k}(${s})${c.rst}`;
            if (s === "DONE") return `${c.y}${k}(DONE)${c.rst}`;
            return now.hour() >= (h + 4) ? `${c.r}${k}${c.rst}` : `${c.gr}${k}${c.rst}`;
        }).join(` ${c.gr}|${c.rst} `);
        console.log(`${c.cy}⸽ ${c.rst}${line}`);
    });

    const tM = forecasts[acc.deviceId] ? moment.duration(forecasts[acc.deviceId].diff(now)) : null;
    const cdStr = (tM && tM.asSeconds() > 0) ? ` (T-${tM.hours()}h ${tM.minutes()}m)` : " (SYNC)";
    console.log(`${c.cy}⫹── ${c.b}${c.cy}${forecasts[acc.deviceId] ? forecasts[acc.deviceId].local().format('HH:mm:ss') : "..."}${cdStr} ──⫺${c.rst}\n`);
    saveLogs(logs);
}

async function main() {
    while (true) {
        console.clear();
        const now = moment.utc();
        const winStart = Math.floor(now.hour() / 4) * 4;
        const winEnd = (winStart + 4) % 24;
        const diff = moment.utc().hour(winEnd === 0 ? 24 : winEnd).minute(0).second(0).diff(now);
        const rem = moment.duration(diff);

        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK FARMER: CORE EDITION${c.rst} ${c.m}══${c.rst}`);
        console.log(`${c.gr}GMT ${moment().format('Z')}${c.rst}`);
        console.log(`${c.w}WINDOW: ${winStart.toString().padStart(2,'0')}:00-${winEnd.toString().padStart(2,'0')}:00 | REMAINING: ${rem.hours()}h ${rem.minutes()}m${c.rst}\n`);

        if (!fs.existsSync(ACCOUNTS_JSON)) {
            console.log(`${c.r}Error: accounts.json not found!${c.rst}`);
            process.exit(1);
        }

        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        const proxies = fs.existsSync(PROXIES_TXT) ? fs.readFileSync(PROXIES_TXT, 'utf8').split('\n').filter(Boolean) : [];
        const logs = getLogs();

        accounts.forEach(acc => {
            if (!forecasts[acc.deviceId]) {
                const nW = getNextWindow(), curS = moment.utc(nW).subtract(4, 'hours');
                const winK = curS.hour().toString().padStart(2, '0'), today = moment.utc().format('YYYY-MM-DD');
                const rand = Math.floor(Math.random() * 15) + 5;
                let target = moment.utc(curS).add(rand, 'minutes');
                if (logs[today]?.[acc.deviceId]?.windows?.[winK]) forecasts[acc.deviceId] = moment.utc(nW).add(rand, 'minutes');
                else forecasts[acc.deviceId] = moment.utc().isAfter(target) ? moment.utc().add(1, 'minute') : target;
            }
        });

        for (let i = 0; i < accounts.length; i++) { await processAccount(accounts[i], i, proxies); await new Promise(r => setTimeout(r, 1000)); }
        for (let i = 60; i > 0; i--) { process.stdout.write(`\r ${c.cy}⫸${c.rst} HEARTBEAT: ${c.y}${i}s${c.rst} `); await new Promise(r => setTimeout(r, 1000)); }
    }
}
main().catch(err => console.log("FATAL:", err));
