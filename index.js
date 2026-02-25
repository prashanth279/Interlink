const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');

const WINDOWS = [0, 4, 8, 12, 16, 20]; 
const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', w: '\x1b[37m', cy: '\x1b[36m', gr: '\x1b[90m', rs: '\x1b[0m', b: '\x1b[1m', m: '\x1b[35m' };

let forecasts = {};

function getLogs() {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
}

function saveLogs(logs) {
    fs.writeFileSync(LOGS_JSON, JSON.stringify(logs, null, 2));
}

function getNextWindow() {
    const now = moment.utc();
    let next = WINDOWS.find(h => h > now.hour());
    if (next === undefined) next = 0;
    let nextDate = moment.utc().hour(next).minute(0).second(0).millisecond(0);
    if (next === 0 && now.hour() >= 20) nextDate.add(1, 'day');
    return nextDate;
}

function createApiClient(token, proxy, deviceId) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : null;
    return axios.create({
        baseURL: API_BASE_URL,
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'okhttp/4.12.0', 'x-unique-id': deviceId, 'x-device-id': deviceId, 'version': '1.1.8' },
        httpsAgent: agent, timeout: 30000
    });
}

async function processAccount(acc, index, proxies) {
    const proxy = proxies[index % proxies.length] || null;
    const client = createApiClient(acc.token, proxy, acc.deviceId);
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    let logs = getLogs();

    if (!logs[today]) logs[today] = {};
    if (!logs[today][acc.deviceId]) {
        logs[today][acc.deviceId] = { startBal: null, windows: {}, currentGold: 0, currentITLG: 0 };
    }
    const accLog = logs[today][acc.deviceId];
    if (!accLog.windows) accLog.windows = {};

    const lastWindowHour = [...WINDOWS].reverse().find(h => h <= now.hour()) || 0;
    const winKey = lastWindowHour.toString().padStart(2, '0');

    try {
        const scheduledTime = forecasts[acc.deviceId];
        const isMineTime = scheduledTime && now.isSameOrAfter(scheduledTime);
        const nextWin = getNextWindow();
        const isSafetyTime = now.isAfter(moment.utc(nextWin).subtract(15, 'minutes')) && !accLog.windows[winKey];

        // Stealth: Only call API if it's time to mine, safety check, or initial setup
        if (isMineTime || isSafetyTime || accLog.startBal === null) {
            const bRes = await client.get('/token/get-token');
            const data = bRes.data.data;
            accLog.currentGold = parseFloat(data.interlinkGoldTokenAmount) || 0;
            accLog.currentITLG = parseFloat(data.interlinkTokenAmount) || 0;

            if (accLog.startBal === null) accLog.startBal = accLog.currentGold;

            const check = await client.get('/token/check-is-claimable');
            if (check.data?.data?.isClaimable) {
                await client.post('/token/claim-airdrop', {});
                accLog.windows[winKey] = moment().format('HH:mm');
                forecasts[acc.deviceId] = null; 
            } else if (isSafetyTime || isMineTime) {
                if (!accLog.windows[winKey]) accLog.windows[winKey] = "MISS";
                forecasts[acc.deviceId] = null;
            }
        }

        const earned = (accLog.currentGold - accLog.startBal) || 0;

        console.log(`${c.cy}╭ Account #${index + 1} ❯ ${c.w}${acc.deviceId.substring(0,8)}${c.rs}`);
        console.log(`${c.cy}┣ GOLD     : ${c.y}${accLog.currentGold.toFixed(2)}${c.rs} ${c.gr}|${c.cy} ITLG: ${accLog.currentITLG.toFixed(2)}${c.rs}`);
        console.log(`${c.cy}┣ TODAY    : ${c.g}+${earned.toFixed(2)} GOLD${c.rs}`);
        
        // Window Status Bar Logic
        let winBar = WINDOWS.map(h => {
            const key = h.toString().padStart(2, '0');
            const isPastFullWindow = now.hour() >= (h + 4) || (h > now.hour() && now.day() > moment.utc().day());
            const status = accLog.windows[key] || (isPastFullWindow ? "MISS" : "----");
            const color = status === "MISS" ? c.r : (status.includes(':') ? c.g : c.gr);
            return `${c.w}${key}${c.rs}:${color}${status}${c.rs}`;
        }).join(`${c.gr} | ${c.rs}`);

        console.log(`${c.cy}┣ WINDOWS  : ${winBar}`);
        const fTime = forecasts[acc.deviceId] ? forecasts[acc.deviceId].local().format('HH:mm') : "Shifting...";
        console.log(`${c.cy}╰ FORECAST : ${c.cy}${fTime}${c.rs}\n`);

        saveLogs(logs);
    } catch (e) {
        console.log(`${c.cy}╰ ERROR    : ${c.r}Sync Error (Network/Proxy)${c.rs}\n`);
    }
}

async function main() {
    while (true) {
        const now = moment.utc();
        console.clear();
        console.log(`${c.m}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${c.rs}`);
        console.log(`${c.m}┃${c.b}${c.w} INTERLINK PRECISION FARMER ${c.rs}     ${c.b}${c.cy}BY PRASHANTH ${c.m}┃${c.rs}`);
        console.log(`${c.m}┃${c.gr} UTC: ${now.format('HH:mm:ss')} | MODE: STEALTH PRECISION    ${c.m}┃${c.rs}`);
        console.log(`${c.m}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${c.rs}\n`);

        let accounts = [];
        try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); } catch (e) { console.log("Account file error"); process.exit(1); }

        const proxies = fs.existsSync(PROXIES_TXT) ? fs.readFileSync(PROXIES_TXT, 'utf8').split('\n').filter(Boolean).map(p => p.trim()) : [];
        const logs = getLogs();

        accounts.forEach(acc => {
            if (!forecasts[acc.deviceId]) {
                const nextWin = getNextWindow();
                const currentWindowStart = moment.utc(nextWin).subtract(4, 'hours');
                const winKey = currentWindowStart.hour().toString().padStart(2, '0');
                const today = now.format('YYYY-MM-DD');
                
                if (!logs[today]?.[acc.deviceId]?.windows?.[winKey]) {
                    const randomMins = Math.floor(Math.random() * 22) + 2; 
                    let target = moment.utc(currentWindowStart).add(randomMins, 'minutes');
                    if (now.isAfter(target)) target = moment.utc().add(1, 'minute');
                    forecasts[acc.deviceId] = target;
                } else {
                    const randomMins = Math.floor(Math.random() * 22) + 2;
                    forecasts[acc.deviceId] = moment.utc(nextWin).add(randomMins, 'minutes');
                }
            }
        });

        for (let i = 0; i < accounts.length; i++) {
            await processAccount(accounts[i], i, proxies);
            if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 2000));
        }

        // Live Countdown
        for (let i = 60; i > 0; i--) {
            process.stdout.write(`\r ${c.cy}●${c.rs} ${c.w}Heartbeat: Rescan in ${c.y}${i}s${c.w}...${c.rs}   `);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

main();
