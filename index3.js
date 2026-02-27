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
const MINI_API = 'https://interlink-mini-app.interlinklabs.ai/api';
const WINDOWS = [0, 4, 8, 12, 16, 20];
const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', w: '\x1b[37m', cy: '\x1b[36m', gr: '\x1b[90m', rs: '\x1b[0m', m: '\x1b[35m', b: '\x1b[1m' };

let forecasts = {};
let currentStatus = {}; // To track progress message per account

// --- UTILITIES ---
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

// --- CLIENT CREATOR (With v1.1.8 Signing) ---
function createClient(acc, proxy) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : null;
    const instance = axios.create({
        baseURL: API_BASE,
        headers: {
            'Authorization': `Bearer ${acc.token}`,
            'User-Agent': 'okhttp/4.12.0',
            'x-unique-id': acc.deviceId,
            'x-device-id': acc.deviceId,
            'x-model': acc.model || 'Redmi Note 8 Pro',
            'x-brand': acc.brand || 'XiaoMi',
            'x-system-name': 'Android',
            'x-bundle-id': 'org.ai.interlinklabs.interlinkId',
            'version': '1.1.8'
        },
        httpsAgent: agent || new https.Agent({ rejectUnauthorized: false }),
        timeout: 25000
    });

    instance.interceptors.request.use((conf) => {
        conf.headers['x-date'] = Date.now().toString();
        if (conf.method === 'post' && conf.data) {
            const body = typeof conf.data === 'object' ? JSON.stringify(conf.data) : (conf.data || "").toString();
            conf.headers['x-content-hash'] = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
        }
        return conf;
    });
    return instance;
}

// --- LUCKY SPIN HANDLER ---
async function handleSpins(acc, proxy) {
    if (!acc.miniToken) return "No Spin Token";
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : null;
    const mini = axios.create({
        baseURL: MINI_API,
        headers: { 'Authorization': `Bearer ${acc.miniToken}`, 'User-Agent': 'okhttp/4.12.0', 'origin': 'https://interlink-mini-app.interlinklabs.ai' },
        httpsAgent: agent || new https.Agent({ rejectUnauthorized: false })
    });

    try {
        const ticketRes = await mini.get('/spin-ticket/get-number-of-tickets');
        let { numberOfTickets, isFirstTicket } = ticketRes.data.data;
        
        if (numberOfTickets === 0 && isFirstTicket) {
            await mini.post('/spin-ticket/buy', {}, { headers: { 'x-ref-id': crypto.randomUUID() } });
            numberOfTickets = 1;
        }

        if (numberOfTickets > 0) {
            const spin = await mini.get('/spin-reward/generate-random');
            return `Won ${spin.data.data.spinRewardValue} ${spin.data.data.spinRewardType}`;
        }
        return "No tickets";
    } catch (e) { return "Spin Failed"; }
}

// --- MAIN ACCOUNT PROCESSOR ---
async function processAccount(acc, index, proxies) {
    const proxy = acc.proxy || proxies[index % proxies.length] || null;
    const client = createClient(acc, proxy);
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    let logs = getLogs();

    if (!logs[today]) logs[today] = {};
    if (!logs[today][acc.deviceId]) {
        logs[today][acc.deviceId] = { startBal: null, endBal: null, windows: {}, currentGold: 0, currentITLG: 0 };
    }
    const accLog = logs[today][acc.deviceId];
    const lastWindowHour = [...WINDOWS].reverse().find(h => h <= now.hour()) || 0;
    const winKey = lastWindowHour.toString().padStart(2, '0');

    try {
        const schedTime = forecasts[acc.deviceId];
        const isMineTime = schedTime && now.isSameOrAfter(schedTime);
        const nextWin = getNextWindow();
        const isSafetyTime = now.isAfter(moment.utc(nextWin).subtract(15, 'minutes')) && !accLog.windows[winKey];

        if (isMineTime || isSafetyTime || accLog.startBal === null) {
            currentStatus[acc.deviceId] = `${c.y}Syncing Data...${c.rs}`;
            const bRes = await client.get('/token/get-token');
            const data = bRes.data.data;
            accLog.currentGold = parseFloat(data.interlinkGoldTokenAmount);
            accLog.currentITLG = parseFloat(data.interlinkTokenAmount);
            
            if (accLog.startBal === null) accLog.startBal = accLog.currentGold;
            accLog.endBal = accLog.currentGold; // Always update end balance on every successful sync

            const check = await client.get('/token/check-is-claimable');
            if (check.data?.data?.isClaimable) {
                currentStatus[acc.deviceId] = `${c.m}Claiming Airdrop...${c.rs}`;
                await client.post('/token/claim-airdrop', {});
                accLog.windows[winKey] = moment().format('HH:mm');
                
                currentStatus[acc.deviceId] = `${c.cy}Checking Spins...${c.rs}`;
                const spinResult = await handleSpins(acc, proxy);
                currentStatus[acc.deviceId] = `${c.g}Claimed (${spinResult})${c.rs}`;
                
                forecasts[acc.deviceId] = null;
            } else {
                if (isSafetyTime || isMineTime) {
                    if (!accLog.windows[winKey]) accLog.windows[winKey] = "MISS";
                    forecasts[acc.deviceId] = null;
                }
                currentStatus[acc.deviceId] = `${c.gr}Waiting for Forecast${c.rs}`;
            }
        } else {
            currentStatus[acc.deviceId] = `${c.gr}Idle (Stealth)${c.rs}`;
        }

        // Dashboard Display
        const earned = (accLog.currentGold - accLog.startBal) || 0;
        console.log(`${c.cy}╭ Account #${index + 1} ❯ ${c.w}${acc.name || acc.deviceId.substring(0,8)}${c.rs} [${currentStatus[acc.deviceId]}]`);
        console.log(`${c.cy}┣ GOLD     : ${c.y}${accLog.currentGold.toFixed(2)}${c.rs} ${c.gr}|${c.cy} ITLG: ${accLog.currentITLG.toFixed(2)}${c.rs}`);
        console.log(`${c.cy}┣ TODAY    : ${c.g}+${earned.toFixed(2)} GOLD${c.rs}`);
        
        let winBar = WINDOWS.map(h => {
            const key = h.toString().padStart(2, '0');
            const isPast = now.hour() >= (h + 4);
            const status = accLog.windows[key] || (isPast ? "MISS" : "----");
            const color = status === "MISS" ? c.r : (status.includes(':') ? c.g : c.gr);
            return `${c.w}${key}${c.rs}:${color}${status}${c.rs}`;
        }).join(`${c.gr} | ${c.rs}`);

        console.log(`${c.cy}┣ WINDOWS  : ${winBar}`);
        const fTime = forecasts[acc.deviceId] ? forecasts[acc.deviceId].local().format('HH:mm') : "Shifting...";
        console.log(`${c.cy}╰ FORECAST : ${c.cy}${fTime}${c.rs}\n`);

        saveLogs(logs);
    } catch (e) {
        console.log(`${c.cy}╰ ERROR    : ${c.r}Sync Failed (Network/Proxy)${c.rs}\n`);
    }
}

// --- EXECUTION LOOP ---
async function main() {
    while (true) {
        console.clear();
        console.log(`${c.m}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${c.rs}`);
        console.log(`${c.m}┃${c.b}${c.w} INTERLINK PRECISION FARMER ${c.rs}     ${c.b}${c.cy}BY PRASHANTH ${c.m}┃${c.rs}`);
        console.log(`${c.m}┃${c.gr} UTC: ${moment.utc().format('HH:mm:ss')} | MODE: STEALTH + SPINS    ${c.m}┃${c.rs}`);
        console.log(`${c.m}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${c.rs}\n`);

        let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        const proxies = fs.existsSync(PROXIES_TXT) ? fs.readFileSync(PROXIES_TXT, 'utf8').split('\n').filter(Boolean) : [];
        const logs = getLogs();

        accounts.forEach(acc => {
            if (!forecasts[acc.deviceId]) {
                const nextWin = getNextWindow();
                const curWinStart = moment.utc(nextWin).subtract(4, 'hours');
                const winKey = curWinStart.hour().toString().padStart(2, '0');
                const today = moment.utc().format('YYYY-MM-DD');

                if (!logs[today]?.windows?.[winKey]) {
                    const rand = Math.floor(Math.random() * 20) + 2;
                    let target = moment.utc(curWinStart).add(rand, 'minutes');
                    if (moment.utc().isAfter(target)) target = moment.utc().add(1, 'minute');
                    forecasts[acc.deviceId] = target;
                } else {
                    const rand = Math.floor(Math.random() * 20) + 2;
                    forecasts[acc.deviceId] = moment.utc(nextWin).add(rand, 'minutes');
                }
            }
        });

        for (let i = 0; i < accounts.length; i++) {
            await processAccount(accounts[i], i, proxies);
            await new Promise(r => setTimeout(r, 2000));
        }

        for (let i = 60; i > 0; i--) {
            process.stdout.write(`\r ${c.cy}●${c.rs} ${c.w}Next Sync in ${c.y}${i}s${c.w}...${c.rs}   `);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
main();
