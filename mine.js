const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const readline = require('readline');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const MINI_API = 'https://interlink-mini-app.interlinklabs.ai/api';
const WINDOWS = [0, 4, 8, 12, 16, 20];

const c = { 
    cy: '\x1b[36m', m: '\x1b[35m', y: '\x1b[33m', g: '\x1b[32m', 
    r: '\x1b[31m', w: '\x1b[37m', gr: '\x1b[90m', b: '\x1b[1m', rst: '\x1b[0m' 
};

let forecasts = {};
let currentStatus = {};
let spinEnabled = true;

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
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : new https.Agent({ rejectUnauthorized: false });
    return axios.create({
        baseURL: API_BASE,
        headers: { 'Authorization': `Bearer ${acc.token}`, 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': acc.deviceId, 'version': '1.1.8' },
        httpsAgent: agent, timeout: 15000
    });
}

async function handleSpins(acc, proxy) {
    if (!acc.miniToken || !spinEnabled) return { msg: "OFF", profit: 0 };
    try {
        const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : new https.Agent({ rejectUnauthorized: false });
        const mini = axios.create({ baseURL: MINI_API, headers: { 'Authorization': `Bearer ${acc.miniToken}`, 'origin': 'https://interlink-mini-app.interlinklabs.ai' }, httpsAgent: agent });
        const tktRes = await mini.get('/spin-ticket/get-number-of-tickets');
        let { numberOfTickets, isFirstTicket } = tktRes.data.data;
        if (numberOfTickets === 0 && isFirstTicket) {
            await mini.post('/spin-ticket/buy', {}, { headers: { 'x-ref-id': crypto.randomUUID() } });
            numberOfTickets = 1;
        }
        if (numberOfTickets > 0) {
            const spin = await mini.get('/spin-reward/generate-random');
            return { msg: `+${spin.data.data.spinRewardValue} SPN`, profit: parseFloat(spin.data.data.spinRewardValue) || 0 };
        }
        return { msg: "0 TKT", profit: 0 };
    } catch (e) { return { msg: "ERR", profit: 0 }; }
}

async function processAccount(acc, index, proxies) {
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    let logs = getLogs();

    if (!logs[today]) logs[today] = {};
    if (!logs[today][acc.deviceId]) {
        logs[today][acc.deviceId] = { startBal: null, endBal: null, endBalTime: null, windows: {}, currentGold: 0, spinProfit: 0, lastSync: null };
    }
    let accLog = logs[today][acc.deviceId];
    const proxyList = [acc.proxy, ...proxies].filter(p => p && p.trim().length > 0);
    const winHour = ([...WINDOWS].reverse().find(h => h <= now.hour()) || 0).toString().padStart(2, '0');
    
    // RADIO SILENT LOGIC
    const isInitial = accLog.lastSync === null;
    const isClaimNeeded = !accLog.windows[winHour] && (forecasts[acc.deviceId] && now.isSameOrAfter(forecasts[acc.deviceId]));
    
    let client = null, data = null;

    if (isInitial || isClaimNeeded) {
        if (proxyList.length > 0) {
            for (let p of proxyList.slice(0, 3)) {
                try {
                    const test = createClient(acc, p);
                    const res = await test.get('/token/get-token');
                    data = res.data.data; client = test; break;
                } catch (e) {}
            }
        }
        if (!client) {
            try {
                const direct = createClient(acc, null);
                const res = await direct.get('/token/get-token');
                data = res.data.data; client = direct;
            } catch (e) { currentStatus[acc.deviceId] = `${c.r}CONN_FAIL${c.rst}`; }
        }
    } else {
        currentStatus[acc.deviceId] = `${c.gr}STEALTH MODE (RADIO SILENT)${c.rst}`;
    }

    if (client && data) {
        accLog.currentGold = parseFloat(data.interlinkGoldTokenAmount);
        accLog.lastSync = moment().format('HH:mm:ss');
        if (accLog.startBal === null) accLog.startBal = accLog.currentGold;

        if (now.hour() >= 23 && now.minute() >= 50) {
            accLog.endBal = accLog.currentGold;
            accLog.endBalTime = accLog.lastSync;
        }

        const check = await client.get('/token/check-is-claimable');
        if (check.data?.data?.isClaimable) {
            currentStatus[acc.deviceId] = `${c.g}CLAIMING...${c.rst}`;
            await client.post('/token/claim-airdrop', {});
            accLog.windows[winHour] = moment().format('HH:mm');
            const spin = await handleSpins(acc, proxyList[0] || null);
            accLog.spinProfit += spin.profit;
            currentStatus[acc.deviceId] = `${c.g}SUCCESS (${spin.msg})${c.rst}`;
            forecasts[acc.deviceId] = null;
        } else {
            currentStatus[acc.deviceId] = `${c.gr}WINDOW_COMPLETE${c.rst}`;
        }
    }

    // --- DISPLAY ---
    const dailyProfit = (accLog.currentGold - (accLog.startBal || accLog.currentGold)).toFixed(2);
    const winStr = WINDOWS.map(h => {
        const k = h.toString().padStart(2, '0');
        const s = accLog.windows[k] || (now.hour() >= (h + 4) ? "MISS" : "--:--");
        const clr = s.includes(':') && s !== "--:--" ? c.g : (s==="MISS"?c.r:c.gr);
        return `${clr}${k}${c.rst}`;
    }).join(`${c.gr}|${c.rst}`);

    console.log(`${c.cy}⫸ ${c.b}${c.w}${acc.name || acc.deviceId.substring(0,8)} ${c.cy}⫷`);
    console.log(`${c.cy}⸽ ${c.rst}${currentStatus[acc.deviceId]}`);
    console.log(`${c.cy}⸽ ${c.y}${accLog.currentGold.toFixed(2)}${c.rst} ${c.gr}(${accLog.lastSync || '--'})${c.rst} ${c.gr}|${c.rst} ${c.g}+${dailyProfit}${c.rst} ${c.gr}DAY${c.rst} ${c.gr}|${c.rst} ${c.m}+${(accLog.spinProfit || 0).toFixed(2)}${c.rst} ${c.gr}SPN${c.rst}`);
    console.log(`${c.cy}⸽ ${c.rst}WIN: ${winStr}`);
    if (accLog.endBal) console.log(`${c.cy}⸽ ${c.rst}EOD: ${c.w}${accLog.endBal.toFixed(2)}${c.rst} ${c.gr}@${accLog.endBalTime || 'RECO'}${c.rst}`);
    console.log(`${c.cy}⫹── ${c.b}${c.cy}${forecasts[acc.deviceId] ? forecasts[acc.deviceId].local().format('HH:mm:ss') : "SHIFTING..." } ──⫺${c.rst}\n`);
    
    saveLogs(logs);
}

async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const spinPrompt = await new Promise(res => rl.question(`${c.cy}ENABLE_SPINS? (y/n): ${c.rst}`, a => { rl.close(); res(a.toLowerCase()==='y'); }));
    spinEnabled = spinPrompt;

    while (true) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK FARMER: STEALTH EDITION by PRASHANTH${c.rst} ${c.m}══${c.rst}`);
        console.log(`${c.gr}UTC: ${moment.utc().format('HH:mm:ss')} | SPINS: ${spinEnabled ? c.g + 'ON' : c.r + 'OFF'}${c.rst} | HEARTBEAT: 60s${c.rst}\n`);

        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        const proxies = fs.existsSync(PROXIES_TXT) ? fs.readFileSync(PROXIES_TXT, 'utf8').split('\n').filter(Boolean) : [];
        const logs = getLogs();

        accounts.forEach(acc => {
            if (!forecasts[acc.deviceId]) {
                const nW = getNextWindow(), curS = moment.utc(nW).subtract(4, 'hours');
                const winK = curS.hour().toString().padStart(2, '0'), today = moment.utc().format('YYYY-MM-DD');
                const rand = Math.floor(Math.random() * 20) + 5;
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
