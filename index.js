const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');

const accountData = {}; 

const c = {
    g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', w: '\x1b[37m', 
    cy: '\x1b[36m', gr: '\x1b[90m', rs: '\x1b[0m', b: '\x1b[1m', m: '\x1b[35m'
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.w}${q}${c.rs}`, res));

function alertUser() { process.stdout.write('\x07'); }

// --- LOGGING SYSTEM ---
function getDailyLogs() {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8'));
        const today = moment.utc().format('YYYY-MM-DD');
        return data[today] || {};
    } catch (e) { return {}; }
}

function updateDailyLog(deviceId, amount) {
    let data = {};
    if (fs.existsSync(LOGS_JSON)) data = JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8'));
    
    const today = moment.utc().format('YYYY-MM-DD');
    if (!data[today]) data[today] = {};
    if (!data[today][deviceId]) data[today][deviceId] = 0;
    
    data[today][deviceId] += amount;
    fs.writeFileSync(LOGS_JSON, JSON.stringify(data, null, 2));
}

function getProxyAgent(proxyUrl) {
    if (!proxyUrl) return new https.Agent({ rejectUnauthorized: false });
    return proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

function createApiClient(token, proxy = null, deviceId = "default") {
    const instance = axios.create({
        baseURL: API_BASE_URL,
        headers: {
            'Authorization': token ? `Bearer ${token}` : undefined,
            'User-Agent': 'okhttp/4.12.0',
            'x-unique-id': deviceId,
            'x-device-id': deviceId,
            'x-brand': 'Nothing',
            'x-model': 'Nothing Phone (2a)',
            'version': '1.1.8'
        },
        httpsAgent: getProxyAgent(proxy),
        timeout: 25000
    });
    
    instance.interceptors.request.use((conf) => {
        conf.headers['x-date'] = Date.now().toString();
        if (conf.method === 'post' && conf.data) {
            const body = typeof conf.data === 'object' ? JSON.stringify(conf.data) : (conf.data || "").toString();
            const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
            conf.headers['x-content-hash'] = hash;
        }
        return conf;
    });
    return instance;
}

async function performLogin(deviceId, proxy) {
    alertUser();
    console.log(`\n${c.y}${c.b}[!] AUTH REQUIRED: ${c.rs}${c.w}${deviceId}${c.rs}`);
    const email = await prompt(' ➔ Enter Email: ');
    const loginId = await prompt(' ➔ Enter Login ID (Email): ');
    const passcode = await prompt(' ➔ Enter Passcode: ');

    const client = createApiClient(null, proxy, deviceId);
    try {
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email });
        console.log(`${c.g}[✓] OTP Sent to ${email}!${c.rs}`);
        alertUser();
        const otp = await prompt(' ➔ Enter OTP Code: ');
        const res = await client.post('/auth/check-otp-email-verify-login', { loginId, otp });
        return res.data.data.jwtToken;
    } catch (e) {
        console.log(`${c.r}[✗] Login Failed: ${e.response?.data?.message || e.message}${c.rs}`);
        return null;
    }
}

function getNextWindow() {
    const now = moment.utc();
    const nextHour = Math.ceil((now.hour() + 0.1) / 4) * 4;
    return moment.utc().startOf('day').add(nextHour, 'hours');
}

async function processAccount(acc, index, proxies) {
    const proxy = proxies[index % proxies.length] || null;
    let token = acc.token;

    if (!token || token === "") {
        const newToken = await performLogin(acc.deviceId, proxy);
        if (newToken) {
            const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
            accounts[index].token = newToken;
            fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2), 'utf8');
            token = newToken;
        } else return;
    }

    const client = createApiClient(token, proxy, acc.deviceId);
    const dailyLogs = getDailyLogs();
    
    if (!accountData[acc.deviceId]) {
        accountData[acc.deviceId] = { lastBal: 0, offset: Math.floor(Math.random() * 40) + 10 };
    }

    try {
        const userRes = await client.get('/auth/current-user');
        const u = userRes.data.data;
        const balRes = await client.get('/token/get-token');
        const b = balRes.data.data;
        
        const currentBal = parseFloat(b.interlinkTokenAmount);
        const dailyTotal = dailyLogs[acc.deviceId] || 0;
        const nextWin = getNextWindow();
        const schedTime = moment(nextWin).add(accountData[acc.deviceId].offset, 'minutes').local().format('hh:mm A');

        console.log(`${c.cy}╭ Account #${index + 1} ❯ ${c.w}${u.username.toUpperCase()}${c.rs}`);
        console.log(`${c.cy}┣ IDENTITY : ${c.gr}${u.email}${c.rs}`);
        console.log(`${c.cy}┣ TOTAL    : ${c.g}${currentBal.toFixed(2)} ITLG${c.rs} │ ${c.y}${b.interlinkGoldTokenAmount} GOLD${c.rs}`);
        console.log(`${c.cy}┣ TODAY    : ${c.b}${c.cy}+${dailyTotal.toFixed(2)} ITLG EARNED${c.rs}`);
        
        const claimCheck = await client.get('/token/check-is-claimable');
        if (claimCheck.data?.data?.isClaimable) {
            if (moment().minute() >= accountData[acc.deviceId].offset) {
                const res = await client.post('/token/claim-airdrop', {});
                let amt = parseFloat(res.data?.data?.amount) || 0;
                
                // Fallback math if API returns 0
                if (amt === 0 && accountData[acc.deviceId].lastBal > 0 && currentBal > accountData[acc.deviceId].lastBal) {
                    amt = currentBal - accountData[acc.deviceId].lastBal;
                }
                
                if (amt > 0) {
                    updateDailyLog(acc.deviceId, amt);
                    console.log(`${c.cy}┣ STATUS   : ${c.b}${c.g}CLAIM SUCCESS: +${amt.toFixed(2)}${c.rs}`);
                } else {
                    console.log(`${c.cy}┣ STATUS   : ${c.y}Claiming...${c.rs}`);
                }
            } else {
                console.log(`${c.cy}┣ STATUS   : ${c.y}Staggered (Slot :${accountData[acc.deviceId].offset})${c.rs}`);
            }
        } else {
            console.log(`${c.cy}┣ STATUS   : ${c.gr}Mining...${c.rs}`);
        }
        accountData[acc.deviceId].lastBal = currentBal;
        console.log(`${c.cy}╰ NEXT WIN : ${c.w}${schedTime}${c.rs}\n`);

    } catch (e) {
        if (e.response?.status === 401) {
            const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
            accounts[index].token = "";
            fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
            console.log(`${c.r}[!] Auth Expired. Resetting...${c.rs}\n`);
        } else {
            console.log(`${c.cy}╰ ERROR    : ${c.r}Connection Busy${c.rs}\n`);
        }
    }
}

async function main() {
    const tz = (new Date().getTimezoneOffset() / -60);
    const gmtStr = `GMT ${tz >= 0 ? '+' : ''}${tz}`;

    while (true) {
        if (!fs.existsSync(ACCOUNTS_JSON)) break;
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        const proxies = fs.existsSync(PROXIES_TXT) ? fs.readFileSync(PROXIES_TXT, 'utf8').split('\n').filter(Boolean) : [];

        console.clear();
        console.log(`${c.m}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${c.rs}`);
        console.log(`${c.m}┃${c.b}${c.w} INTERLINK FARMING ${c.rs}            ${c.b}${c.cy}BY PRASHANTH ${c.m}┃${c.rs}`);
        console.log(`${c.m}┃${c.gr} DEVICE TIME: ${gmtStr} ${c.rs}                               ${c.m}┃${c.rs}`);
        console.log(`${c.m}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${c.rs}\n`);

        for (let i = 0; i < accounts.length; i++) {
            await processAccount(accounts[i], i, proxies);
            await new Promise(r => setTimeout(r, 1500));
        }

        const nextUTC = getNextWindow();
        const isNow = nextUTC.isBefore(moment());
        const diff = isNow ? 300 : nextUTC.diff(moment(), 'seconds');
        const msg = isNow ? "WINDOW OPEN - RECHECKING" : "NEXT WINDOW OPENS IN";

        for (let i = diff; i > 0; i--) {
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(` ${c.cy}●${c.rs} ${c.w}${msg}: ${Math.floor(i/3600)}h ${Math.floor((i%3600)/60)}m ${i%60}s${c.rs}   `);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

main();
