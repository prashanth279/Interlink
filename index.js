const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { spawn } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const WINDOWS = [0, 4, 8, 12, 16, 20];

// Advanced 256-Color Palette
const c = {
    p: '\x1b[38;5;39m',   // Primary Blue (For positive growth)
    s: '\x1b[38;5;198m',  
    a: '\x1b[38;5;118m',  
    w: '\x1b[38;5;220m',  
    e: '\x1b[38;5;196m',  // Error Red (For negative growth)
    g: '\x1b[38;5;46m',   
    wh: '\x1b[97m',       
    gr: '\x1b[38;5;245m', 
    cy: '\x1b[36m',       
    b: '\x1b[1m',         
    rst: '\x1b[0m'        
};

// Global State
let forecasts = {};
let currentStatus = {};
let proxyStatus = {};
let sessionSynced = new Set();
let isShuttingDown = false;
let isWritingLogs = false; 
let enableSpin = false;
let lastSpinWindow = null;

// --- UTILITIES & LOG MANAGEMENT ---
function migrateData() {
    let accounts = [];
    try { 
        const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); 
        if (Array.isArray(parsed)) accounts = parsed;
    } catch(e) { accounts = []; }
    
    let logs = {};
    try { logs = JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch(e) { logs = {}; }
    return { accounts, logs };
}

const getLogs = () => {
    if (!fs.existsSync(LOGS_JSON)) return {};
    try { return JSON.parse(fs.readFileSync(LOGS_JSON, 'utf8')); } catch (e) { return {}; }
};

const saveLogs = (l, force = false) => {
    if ((isShuttingDown && !force) || isWritingLogs) return;
    isWritingLogs = true;
    try { fs.writeFileSync(LOGS_JSON, JSON.stringify(l, null, 2)); } catch(e) {}
    isWritingLogs = false;
};

// --- LOG TRIMMER (KEEPS 2 DAYS) ---
function trimLogs() {
    let logs = getLogs();
    const dates = Object.keys(logs).sort((a, b) => moment(b).diff(moment(a))); 
    
    let trimmed = false;
    if (dates.length > 2) {
        const keysToDelete = dates.slice(2);
        keysToDelete.forEach(k => delete logs[k]);
        trimmed = true;
        saveLogs(logs, true);
    }
    return trimmed;
}

function updateAccountTokens(accId, newToken, newRefreshToken) {
    try {
        let accs = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        if (!Array.isArray(accs)) return;
        let idx = accs.findIndex(a => (a.email || a.deviceId || a.loginId) === accId);
        if (idx !== -1) {
            accs[idx].token = newToken;
            if (newRefreshToken) accs[idx].refreshToken = newRefreshToken;
            fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accs, null, 2));
        }
    } catch (e) { }
}

function extractIp(proxyUrl) {
    if (!proxyUrl || proxyUrl.toUpperCase() === 'NONE') return 'NONE';
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

// --- CORE API CLIENT ---
function createClient(acc, proxy) {
    const agent = (proxy && proxy.toUpperCase() !== 'NONE') ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : new https.Agent({ rejectUnauthorized: false });

    return axios.create({
        baseURL: API_BASE,
        headers: {
            'Authorization': `Bearer ${acc.token}`,
            'User-Agent': 'okhttp/4.12.0',
            'Content-Type': 'application/json'
        },
        httpsAgent: agent,
        timeout: 15000
    });
}

// --- AUTO-REFRESH ENGINE ---
async function doRefreshToken(acc) {
    if (!acc.refreshToken) return false;
    try {
        const agent = (acc.proxy && acc.proxy.toUpperCase() !== 'NONE') ? (acc.proxy.startsWith('socks') ? new SocksProxyAgent(acc.proxy.trim()) : new HttpsProxyAgent(acc.proxy.trim())) : new https.Agent({ rejectUnauthorized: false });

        const res = await axios.post(`${API_BASE}/auth/token`,
            { refreshToken: acc.refreshToken },
            {
                headers: {
                    'Authorization': `Bearer ${acc.token}`,
                    'User-Agent': 'okhttp/4.12.0',
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent,
                timeout: 15000
            }
        );

        if (res.data && res.data.data) {
            acc.token = res.data.data.accessToken || res.data.data.jwtToken;
            acc.refreshToken = res.data.data.refreshToken || acc.refreshToken;

            const id = acc.email || acc.deviceId || acc.loginId;
            updateAccountTokens(id, acc.token, acc.refreshToken);
            return true;
        }
        return false;
    } catch (e) { return false; }
}

// --- PULSE CHECK ---
async function pulseCheck(proxyUrl) {
    try {
        const agent = (proxyUrl && proxyUrl.toUpperCase() !== 'NONE') ? (proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl.trim()) : new HttpsProxyAgent(proxyUrl.trim())) : null;
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
        return true;
    } catch (e) { return false; }
}

// --- ACCOUNT PROCESSING ---
async function processAccount(acc, idx) {
    const now = moment.utc();
    const today = now.format('YYYY-MM-DD');
    const yesterday = moment.utc().subtract(1, 'day').format('YYYY-MM-DD');
    let logs = getLogs();

    const id = acc.email || acc.deviceId || acc.loginId;
    if (!logs[today]) logs[today] = {};
    if (!logs[today][id]) {
        logs[today][id] = { startBal: null, windows: {}, tokens: { G: 0, dailyRate: 0, dailyGrowth: 0, groupRate: 0, groupGrowth: 0 }, lastSync: null, lastClaimServer: null, spinProfit: 0 };
    }
    let accLog = logs[today][id];
    let prevLog = logs[yesterday]?.[id] || null;

    if (acc.paused) {
        currentStatus[id] = `${c.e}PAUSED${c.rst}`;
        proxyStatus[id] = `${c.gr}N/A${c.rst}`;
        displayAccount(acc, idx, accLog, prevLog, logs, today);
        return;
    }

    const exp = getJwtExp(acc.token);
    const nowTs = Math.floor(Date.now() / 1000);
    if (exp > 0 && nowTs > exp) {
        currentStatus[id] = `${c.w}REFRESHING...${c.rst}`;
        const refreshed = await doRefreshToken(acc);
        if (!refreshed) {
            currentStatus[id] = `${c.e}AUTH_EXP${c.rst}`;
            displayAccount(acc, idx, accLog, prevLog, logs, today);
            return;
        } else {
            currentStatus[id] = `${c.g}TOKEN_REFRESHED${c.rst}`;
        }
    }

    const hasProxy = !!acc.proxy && acc.proxy.toUpperCase() !== 'NONE';
    const proxyIp = extractIp(acc.proxy);
    const isAlive = await pulseCheck(acc.proxy);

    if (!isAlive) {
        proxyStatus[id] = hasProxy ? `${c.e}${proxyIp} ● DEAD${c.rst}` : `${c.e}LOCAL_NET ● DEAD${c.rst}`;
        currentStatus[id] = `${c.e}CONN_FAIL${c.rst}`;
        displayAccount(acc, idx, accLog, prevLog, logs, today);
        return;
    }

    proxyStatus[id] = hasProxy ? `${c.gr}${proxyIp}${c.rst}` : `${c.gr}NONE${c.rst}`;
    const client = createClient(acc, acc.proxy);
    const winHour = ([...WINDOWS].reverse().find(h => h <= now.hour()) || 0).toString().padStart(2, '0');

    // Initial Balance & TRUE Server Sync
    if (!sessionSynced.has(id)) {
        try {
            const balRes = await client.get('/token/get-token');
            const tData = balRes.data.data;
            
            // Extract core tokens and new rate data
            accLog.tokens = {
                G: parseFloat(tData.interlinkGoldTokenAmount || 0),
                dailyRate: parseFloat(tData.dailyMiningRate || 0),
                dailyGrowth: parseFloat(tData.dailyMining7dGrowthRate || 0),
                groupRate: parseFloat(tData.groupMiningRate || 0),
                groupGrowth: parseFloat(tData.groupMining7dGrowthRate || 0)
            };
            
            if (tData.lastClaimTime) accLog.lastClaimServer = moment(tData.lastClaimTime).format('YYYY-MM-DD HH:mm:ss');
            accLog.lastSync = moment().format('HH:mm:ss');
            if (accLog.startBal === null) accLog.startBal = prevLog ? prevLog.tokens.G : accLog.tokens.G;

            const claimCheck = await client.get('/token/check-is-claimable');
            if (claimCheck.data?.data?.isClaimable) {
                forecasts[id] = moment.utc(); 
            } else if (claimCheck.data?.data?.nextFrame) {
                forecasts[id] = moment(claimCheck.data.data.nextFrame).add(Math.floor(Math.random() * 5), 'minutes'); 
                // Manual Claim Startup Fix
                if (!accLog.windows[winHour]) accLog.windows[winHour] = "DONE";
                currentStatus[id] = `${c.a}ALREADY CLAIMED${c.rst}`;
            }

            sessionSynced.add(id);
            saveLogs(logs);
        } catch (e) {
            currentStatus[id] = `${c.e}SYNC_FAIL${c.rst}`;
        }
    }

    const isClaimNeeded = (forecasts[id] && now.isSameOrAfter(forecasts[id]));

    if (!isClaimNeeded) {
        // Keep it on ALREADY CLAIMED until the next window triggers
        if (!currentStatus[id]?.includes('ALREADY CLAIMED')) {
            currentStatus[id] = `${c.gr}STEALTH MODE${c.rst}`;
        }
        displayAccount(acc, idx, accLog, prevLog, logs, today);
        return;
    }

    try {
        const check = await client.get('/token/check-is-claimable');
        if (check.data?.data?.isClaimable) {
            await client.post('/token/claim-airdrop', {});
            accLog.windows[winHour] = moment().format('HH:mm');

            const postBal = await client.get('/token/get-token');
            const newTData = postBal.data.data;
            
            accLog.tokens.G = parseFloat(newTData.interlinkGoldTokenAmount || 0);
            accLog.tokens.dailyRate = parseFloat(newTData.dailyMiningRate || 0);
            accLog.tokens.dailyGrowth = parseFloat(newTData.dailyMining7dGrowthRate || 0);
            accLog.tokens.groupRate = parseFloat(newTData.groupMiningRate || 0);
            accLog.tokens.groupGrowth = parseFloat(newTData.groupMining7dGrowthRate || 0);
            
            if (newTData.lastClaimTime) accLog.lastClaimServer = moment(newTData.lastClaimTime).format('YYYY-MM-DD HH:mm:ss');
            currentStatus[id] = `${c.g}CLAIM SUCCESS${c.rst}`;
        } else {
            currentStatus[id] = `${c.a}WINDOW COMPLETE${c.rst}`;
            if (!accLog.windows[winHour]) accLog.windows[winHour] = "DONE";
        }

        forecasts[id] = moment.utc(getNextWindow()).add(Math.floor(Math.random() * 15) + 5, 'minutes');
        saveLogs(logs);

    } catch (e) {
        if (e.response) currentStatus[id] = `${c.e}ERR_${e.response.status}${c.rst}`;
        else currentStatus[id] = `${c.e}API_DOWN${c.rst}`;
    }

    displayAccount(acc, idx, accLog, prevLog, logs, today);
}

// --- DISPLAY LOGIC ---
function displayAccount(acc, idx, accLog, prevLog, logs, today) {
    const id = acc.email || acc.deviceId || acc.loginId;
    const baseBal = prevLog ? (prevLog.tokens.G || 0) : (accLog.startBal || accLog.tokens.G || 0);
    const dailyProfit = ((accLog.tokens.G || 0) - baseBal).toFixed(2);

    const stat = currentStatus[id] || `${c.gr}WAITING${c.rst}`;
    const pStat = proxyStatus[id] || `${c.gr}CHECKING${c.rst}`;

    const uName = acc.name || 'Unknown';
    const lId = acc.loginId || acc.email || 'N/A';
    
    // Line 1: Header (Referral Removed, Last Claim Moved Here)
    let lastClaimStr = accLog.lastClaimServer ? moment(accLog.lastClaimServer, 'YYYY-MM-DD HH:mm:ss').format('HH:mm DD-MM-YY') : 'N/A';
    console.log(`${c.cy}⫸ ${c.wh}${c.b}Acc ${idx + 1}:${c.rst} ${c.p}${uName}${c.rst} | ${c.wh}${lId}${c.rst} | ${c.s}Last Claim: ${lastClaimStr}${c.rst}`);

    // Line 2: Status
    console.log(`${c.cy}⸽ Status: ${stat}${c.rst}`);

    // Line 3: Coins & Colored Rates
    let dColor = (accLog.tokens.dailyGrowth > 0) ? c.p : ((accLog.tokens.dailyGrowth < 0) ? c.e : c.wh);
    let gColor = (accLog.tokens.groupGrowth > 0) ? c.p : ((accLog.tokens.groupGrowth < 0) ? c.e : c.wh);
    console.log(`${c.cy}⸽ ${c.rst}Coins: ${c.w}${(accLog.tokens.G || 0).toFixed(2)}${c.rst} | Daily Rate: ${dColor}${(accLog.tokens.dailyRate || 0).toFixed(2)}${c.rst} | Group Rate: ${gColor}${(accLog.tokens.groupRate || 0).toFixed(2)}${c.rst}`);

    // Line 4: Profit
    let ystStr = prevLog ? (prevLog.tokens.G || 0).toFixed(2) : '0.00';
    let syncTime = accLog.lastSync ? accLog.lastSync.substring(0, 5) : '--:--';
    console.log(`${c.cy}⸽ ${c.rst}Profit: ${c.g}+${dailyProfit}${c.rst} ${c.gr}(${syncTime})${c.rst} | YST: ${c.wh}${ystStr}${c.rst} ${c.gr}(EOD)${c.rst}`);

    // Line 5: Spin & Wallet
    let walletWord = (acc.wallet && acc.wallet !== 'None') ? `${c.g}Wallet${c.rst}` : `${c.gr}Wallet${c.rst}`;
    let spinWord = enableSpin ? `${c.g}Spin${c.rst}` : `${c.gr}Spin${c.rst}`;
    let allTimeSpin = logs[today]?.[id]?.spinProfit || 0;
    let spinPnLColor = allTimeSpin > 0 ? c.g : (allTimeSpin < 0 ? c.e : c.gr);
    let spinPnLSign = allTimeSpin > 0 ? '+' : '';
    console.log(`${c.cy}⸽ ${c.rst}${walletWord} | ${spinWord} (${spinPnLColor}${spinPnLSign}${allTimeSpin.toFixed(2)}${c.rst}) | Proxy: ${pStat}`);

    // Line 6 & 7: Windows Grid (3x2)
    const windowTriplets = [[0, 4, 8], [12, 16, 20]];
    const now = moment.utc();

    windowTriplets.forEach(triplet => {
        const line = triplet.map(h => {
            const k = h.toString().padStart(2, '0');
            const localWin = moment.utc().hour(h).minute(0).local().format('HH:mm');
            const s = accLog.windows[k];
            const winEnd = moment.utc().hour(h).minute(0).add(4, 'hours');
            const isPast = now.isSameOrAfter(winEnd);

            if (s && s !== "DONE") return `${c.g}${localWin}(${s})${c.rst}`;
            if (s === "DONE") return `${c.w}${localWin}(DONE)${c.rst}`;
            return isPast ? `${c.e}${localWin}${c.gr}(00:00)${c.rst}` : `${c.gr}${localWin}(00:00)${c.rst}`;
        }).join(` ${c.gr}|${c.rst} `);
        console.log(`${c.cy}⸽ ${c.rst}${line}`);
    });

    // Line 8: Next Claim
    const nextStr = forecasts[id] ? forecasts[id].local().format('HH:mm:ss') : "CALCULATING";
    console.log(`${c.cy}⫹── ${c.rst}Next Claim: ${c.b}${c.wh}${nextStr}${c.rst}\n`);
}

// --- MASTER CONTROLLER SPIN LAUNCHER ---
function launchSpinScript() {
    return new Promise((resolve) => {
        console.clear();
        console.log(`\n${c.p}⫸${c.rst} ${c.b}HANDING OVER CONTROL TO SPIN.JS...${c.rst}\n`);
        
        const spinPath = path.join(__dirname, 'spin.js');
        const child = spawn('node', [spinPath], { stdio: 'inherit' });
        
        child.on('close', () => {
            resolve();
        });
    });
}

// --- STARTUP PROMPT ---
function askSpinPrompt() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;

        const timer = setTimeout(() => {
            if (!answered) {
                console.log(`\n${c.gr}[Timeout] Defaulting to No.${c.rst}`);
                rl.close();
                resolve(false);
            }
        }, 5000);

        rl.question(`\n${c.cy}⸽ ${c.w}Run with Lucky Spin automation? (Y/n) ${c.gr}[Auto-skipping in 5s...]: ${c.rst}`, (answer) => {
            answered = true;
            clearTimeout(timer);
            rl.close();
            if (answer.trim().toLowerCase() === 'y') resolve(true);
            else resolve(false);
        });
    });
}

// --- MAIN LOOP ---
async function main() {
    console.clear();
    console.log(`${c.cy}=================================================${c.rst}`);
    console.log(`         ${c.s}${c.b}INTERLINK MASTER CONTROLLER${c.rst}`);
    console.log(`${c.cy}=================================================${c.rst}`);

    const logsTrimmed = trimLogs();
    if (logsTrimmed) {
        console.log(`\n${c.g}✅ [Log Manager] Excess history removed. Keeping last 2 days.${c.rst}`);
    }

    enableSpin = await askSpinPrompt();
    if (enableSpin) console.log(`\n${c.g}✅ Lucky Spin Automation Enabled.${c.rst}\n`);

    await new Promise(r => setTimeout(r, 1000));

    const { accounts, logs } = migrateData();
    const today = moment.utc().format('YYYY-MM-DD');

    if (!Array.isArray(accounts) || accounts.length === 0) {
        console.log(`\n${c.e}No valid accounts found. Please check accounts.json.${c.rst}\n`);
        process.exit(1);
    }

    accounts.forEach(acc => {
        const id = acc.email || acc.deviceId || acc.loginId;
        if (!forecasts[id]) {
            const now = moment.utc();
            const curWinStartHour = Math.floor(now.hour() / 4) * 4;
            const winK = curWinStartHour.toString().padStart(2, '0');

            if (logs[today]?.[id]?.windows?.[winK]) {
                const nW = getNextWindow();
                forecasts[id] = moment.utc(nW).add(Math.floor(Math.random() * 15) + 5, 'minutes');
            } else {
                forecasts[id] = moment.utc().add(2, 'seconds');
            }
        }
    });

    while (!isShuttingDown) {
        console.clear();
        const now = moment.utc();
        const winStartUtc = Math.floor(now.hour() / 4) * 4;
        const winEndUtc = (winStartUtc + 4) % 24;
        const winHourKey = winStartUtc.toString().padStart(2, '0');

        const localWinStart = moment.utc().hour(winStartUtc).minute(0).local().format('HH:mm');
        const localWinEnd = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).local().format('HH:mm');          
        const diff = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).second(0).diff(now);
        const rem = moment.duration(diff);

        console.log(`\n           ${c.s}${c.b}INTERLINK FARMER: by PRASHANTH${c.rst}`);
        console.log(`      ${c.gr}GMT ${moment().format('Z')} | Window: ${localWinStart}-${localWinEnd} | Rem: ${rem.hours()}h ${rem.minutes()}m${c.rst}`);
        if (enableSpin) console.log(`      ${c.w}Lucky Spin Module: Active${c.rst}\n`);
        else console.log(`\n`);                               
        console.log(`${c.cy}─${c.rst}`.repeat(60) + `\n`);

        for (let i = 0; i < accounts.length; i++) {
            if (isShuttingDown) break;
            await processAccount(accounts[i], i);
            console.log(`${c.cy}─${c.rst}`.repeat(60) + `\n`);
        }

        if (enableSpin && !isShuttingDown) {
            const activeAccs = accounts.filter(a => !a.paused);
            const allClaimedForWindow = activeAccs.every(a => {
                const aId = a.email || a.deviceId || a.loginId;
                return getLogs()[today]?.[aId]?.windows?.[winHourKey] === "DONE" || getLogs()[today]?.[aId]?.windows?.[winHourKey] !== undefined;
            });

            if (allClaimedForWindow && lastSpinWindow !== winHourKey) {
                console.log(`\n${c.g}${c.b}>>> ALL CLAIMS COMPLETE FOR ${localWinStart} WINDOW. TRIGGERING SPIN SCRIPT... <<<${c.rst}`);
                await new Promise(r => setTimeout(r, 3000));

                await launchSpinScript();

                lastSpinWindow = winHourKey; 
                console.log(`\n${c.p}⫸${c.rst} ${c.b}SPIN SCRIPT COMPLETE. RESUMING NORMAL FARMING...${c.rst}\n`);
                await new Promise(r => setTimeout(r, 2000));
                continue; 
            }
        }

        for (let i = 60; i > 0; i--) {
            if (isShuttingDown) break;
            process.stdout.write(`\r ${c.p}⫸${c.rst} HEARTBEAT: ${c.w}${i}s${c.rst}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

process.on('SIGINT', () => {
    isShuttingDown = true;
    console.log(`\n\n${c.e}${c.b}>>> SHUTTING DOWN SAFELY... Saving logs.json... <<<${c.rst}\n`);
    saveLogs(getLogs(), true);
    process.exit(0);
});

main().catch(err => console.log(`\n${c.e}FATAL ERROR: ${err.message}${c.rst}`));
