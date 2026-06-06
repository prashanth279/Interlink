const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const LOGS_JSON = path.join(__dirname, 'logs.json');
const DEVICE_POOL = path.join(__dirname, 'devicepool.txt');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';
const WINDOWS = [0, 4, 8, 12, 16, 20];
const APP_VERSION = '5.0.2.a'; 

// Advanced 256-Color Palette
const c = {
    p: '\x1b[38;5;39m',   // Blue
    s: '\x1b[38;5;198m',  // Pink
    a: '\x1b[38;5;118m',  // Light Green
    w: '\x1b[38;5;220m',  // Yellow
    e: '\x1b[38;5;196m',  // Red
    g: '\x1b[38;5;46m',   // Green
    wh: '\x1b[97m',       // White
    gr: '\x1b[38;5;245m', // Grey
    cy: '\x1b[36m',       // Cyan
    m: '\x1b[38;5;207m',  // Magenta (For Coins)
    b: '\x1b[1m',         // Bold
    rst: '\x1b[0m'        // Reset
};

// Global State
let forecasts = {};
let currentStatus = {};
let proxyStatus = {};
let sessionSynced = new Set();
let isShuttingDown = false;
let isWritingLogs = false; 

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

// --- DEVICE POOL AUTO-SYNC ENGINE ---
function syncDevicePool(accounts) {
    let poolData = {};
    
    if (fs.existsSync(DEVICE_POOL)) {
        const lines = fs.readFileSync(DEVICE_POOL, 'utf8').split('\n');
        lines.forEach(line => {
            if (line.trim() && !line.startsWith('#')) {
                const parts = line.split('|').map(p => p.trim());
                if (parts.length >= 1) {
                    poolData[parts[0]] = {
                        brand: parts[1] || '',
                        model: parts[2] || '',
                        deviceId: parts[3] || ''
                    };
                }
            }
        });
    }

    const defaultDevices = [
        { brand: 'POCO', model: '25053PC47G' },
        { brand: 'Samsung', model: 'Galaxy S24 Ultra' },
        { brand: 'Google', model: 'Pixel 8 Pro' },
        { brand: 'XiaoMi', model: 'Redmi Note 13' }
    ];

    let poolModified = false;
    let accountsModified = false;

    accounts.forEach(acc => {
        const idKey = acc.registeredEmail || acc.email || acc.loginId; 
        let pData = poolData[idKey];

        if (!pData) {
            const randomDevice = defaultDevices[Math.floor(Math.random() * defaultDevices.length)];
            pData = {
                brand: acc.brand || randomDevice.brand,
                model: acc.model || randomDevice.model,
                deviceId: acc.deviceId || crypto.randomBytes(8).toString('hex')
            };
            poolData[idKey] = pData;
            poolModified = true;
        } 
        else if (!pData.deviceId || pData.deviceId === '') {
            pData.deviceId = acc.deviceId || crypto.randomBytes(8).toString('hex');
            poolModified = true;
        }

        if (acc.deviceId !== pData.deviceId || acc.brand !== pData.brand || acc.model !== pData.model) {
            acc.deviceId = pData.deviceId;
            acc.brand = pData.brand;
            acc.model = pData.model;
            accountsModified = true;
        }
    });

    if (poolModified) {
        let newPoolText = "# Format: email | Brand | Model | DeviceID (Leave DeviceID blank to auto-generate it once)\n";
        for (const [key, data] of Object.entries(poolData)) {
            newPoolText += `${key} | ${data.brand} | ${data.model} | ${data.deviceId}\n`;
        }
        fs.writeFileSync(DEVICE_POOL, newPoolText);
    }

    if (accountsModified) {
        fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
    }
}

function updateAccountTokens(accId, newToken, newRefreshToken) {
    try {
        let accs = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8'));
        if (!Array.isArray(accs)) return;
        let idx = accs.findIndex(a => (a.email || a.registeredEmail || a.deviceId || a.loginId) === accId);
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
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).exp; } 
    catch (e) { return 0; }
}

function getNextWindow() {
    const now = moment.utc();
    let next = WINDOWS.find(h => h > now.hour());
    if (next === undefined) next = 0;
    let nextDate = moment.utc().hour(next).minute(0).second(0).millisecond(0);
    if (next === 0 && now.hour() >= 20) nextDate.add(1, 'day');
    return nextDate;
}

// --- CORE API CLIENT (WITH ADVANCED ANTI-BAN SPOOFING) ---
function createClient(acc, proxy) {
    const agent = (proxy && proxy.toUpperCase() !== 'NONE') ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy.trim()) : new HttpsProxyAgent(proxy.trim())) : new https.Agent({ rejectUnauthorized: false });

    return axios.create({
        baseURL: API_BASE,
        headers: {
            'Authorization': `Bearer ${acc.token}`,
            'Version': APP_VERSION,
            'X-Platform': 'android',
            'X-System-Name': 'Android',
            'X-Date': Date.now().toString(), 
            'X-Brand': acc.brand || 'POCO',
            'X-Model': acc.model || '25053PC47G',
            'X-Unique-Id': acc.deviceId,
            'X-Device-Id': acc.deviceId,
            'X-Bundle-Id': 'org.ai.interlinklabs.interlinkId',
            'Accept-Encoding': 'gzip, deflate',
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
        const client = createClient(acc, acc.proxy);
        const res = await client.post(`/auth/token`, { refreshToken: acc.refreshToken });

        if (res.data && res.data.data) {
            acc.token = res.data.data.accessToken || res.data.data.jwtToken;
            acc.refreshToken = res.data.data.refreshToken || acc.refreshToken;
            const id = acc.registeredEmail || acc.email || acc.deviceId || acc.loginId;
            updateAccountTokens(id, acc.token, acc.refreshToken);
            return true;
        }
        return false;
    } catch (e) { return false; }
}

async function pulseCheck(proxyUrl) {
    const agent = (proxyUrl && proxyUrl.toUpperCase() !== 'NONE') ? (proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl.trim()) : new HttpsProxyAgent(proxyUrl.trim())) : null;
    try {
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
        return true;
    } catch (e) { 
        // Fallback network check if ipify is down
        try {
            await axios.get('https://icanhazip.com', { httpsAgent: agent, timeout: 10000 });
            return true;
        } catch (e2) {
            return false; 
        }
    }
}

// --- ACCOUNT PROCESSING ---
async function processAccount(acc, idx) {
    const today = moment.utc().format('YYYY-MM-DD');
    const yesterday = moment.utc().subtract(1, 'day').format('YYYY-MM-DD');
    let logs = getLogs();

    const id = acc.registeredEmail || acc.email || acc.deviceId || acc.loginId;
    if (!logs[today]) logs[today] = {};
    if (!logs[today][id]) {
        logs[today][id] = { startBal: null, windows: {}, tokens: { G: 0 }, lastSync: null, lastClaimServer: null, groupClaimDate: null, groupState: null, curatorSyncDate: null };
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
    const winHour = ([...WINDOWS].reverse().find(h => h <= moment.utc().hour()) || 0).toString().padStart(2, '0');

    // Initial Balance & TRUE Server Sync (Optimized Master API)
    if (!sessionSynced.has(id)) {
        try {
            const masterRes = await client.get('/auth/current-user-full?include=userInfo,token,isClaimable');
            const uData = masterRes.data?.data || {};
            const tData = uData.token || {};
            
            accLog.tokens.G = parseFloat(tData.interlinkGoldTokenAmount || 0);
            
            if (tData.lastClaimTime) accLog.lastClaimServer = moment(tData.lastClaimTime).format('YYYY-MM-DD HH:mm:ss');
            accLog.lastSync = moment().format('HH:mm'); 
            if (accLog.startBal === null) accLog.startBal = prevLog ? prevLog.tokens.G : accLog.tokens.G;

            const isClaimable = uData.isClaimable?.isClaimable;
            const nextFrame = uData.isClaimable?.nextFrame;

            if (isClaimable) {
                forecasts[id] = moment.utc(); 
            } else if (nextFrame) {
                forecasts[id] = moment(nextFrame).add(Math.floor(Math.random() * 5), 'minutes'); 
                if (!accLog.windows[winHour]) accLog.windows[winHour] = "DONE";
                currentStatus[id] = `${c.a}ALREADY CLAIMED${c.rst}`;
            }

            sessionSynced.add(id);
            saveLogs(logs);
        } catch (e) {
            currentStatus[id] = `${c.e}SYNC_FAIL${c.rst}`;
        }
    }

    // --- DOMINO 1: SMART GROUP MINING ENGINE ---
    if (accLog.groupClaimDate !== today && parseInt(winHour) >= 4) {
        try {
            const gRes = await client.post('/group-mining/get-list-group-mining', {});
            const groups = gRes.data?.data?.groups || [];
            
            let bestGroup = null;
            let highestReward = -1;

            groups.forEach(g => {
                if (g.secure && g.canClaim) {
                    const r = parseFloat(g.totalReward || 0);
                    if (r > highestReward) { highestReward = r; bestGroup = g; }
                }
            });

            if (bestGroup) {
                currentStatus[id] = `${c.w}GROUP FOUND. JITTERING...${c.rst}`;
                displayAccount(acc, idx, accLog, prevLog, logs, today);
                
                const jitterMs = Math.floor(Math.random() * 30000) + 15000; // 15-45s
                await new Promise(r => setTimeout(r, jitterMs));

                const cRes = await client.post('/group-mining/claim-group-mining', { groupId: bestGroup.groupId });
                const msg = (cRes.data?.message || '').toLowerCase();
                
                if ((cRes.data && cRes.data.success) || msg.includes('success')) {
                    accLog.groupClaimDate = today;
                    accLog.groupState = { name: bestGroup.groupId, reward: highestReward };
                    
                    const fastBal = await client.get('/token/get-token');
                    accLog.tokens.G = parseFloat(fastBal.data?.data?.interlinkGoldTokenAmount || accLog.tokens.G);
                    accLog.lastSync = moment().format('HH:mm'); 
                    saveLogs(logs);
                }
            } else {
                accLog.groupClaimDate = today;
                accLog.groupState = null; 
                saveLogs(logs);
            }
        } catch(e) { /* Silently fail group mining to protect main loop */ }
    }

    // --- DOMINO 2: SILENT CURATOR SYNC ---
    if (accLog.curatorSyncDate !== today && parseInt(winHour) >= 4) {
        try {
            // Micro-Jitter (3-7s) to prevent bot-like instant consecutive requests
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 4000) + 3000));
            
            const syncCheck = await client.get('/synchronize-curator');
            if (syncCheck.data?.data?.canClick) {
                await client.post('/synchronize-curator', {});
            }
            accLog.curatorSyncDate = today;
            saveLogs(logs);
        } catch(e) { /* Silently fail curator sync to protect main loop */ }
    }

    // --- DOMINO 3: AIRDROP CLAIMING (Stale Clock Fix) ---
    // Re-evaluate live UTC time right before checking, accounting for any jitter delays
    const isClaimNeeded = (forecasts[id] && moment.utc().isSameOrAfter(forecasts[id]));

    if (!isClaimNeeded) {
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
            const newTData = postBal.data?.data || {};
            
            accLog.tokens.G = parseFloat(newTData.interlinkGoldTokenAmount || 0);
            if (newTData.lastClaimTime) accLog.lastClaimServer = moment(newTData.lastClaimTime).format('YYYY-MM-DD HH:mm:ss');
            
            accLog.lastSync = moment().format('HH:mm'); 
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
    const id = acc.registeredEmail || acc.email || acc.deviceId || acc.loginId;
    const baseBal = prevLog ? (prevLog.tokens.G || 0) : (accLog.startBal || accLog.tokens.G || 0);
    const rawProfit = ((accLog.tokens.G || 0) - baseBal);
    
    // Profit Color Logic: Red for negative, Green with '+' for positive
    let profitStr = rawProfit >= 0 ? `${c.g}+${rawProfit.toFixed(2)}${c.rst}` : `${c.e}${rawProfit.toFixed(2)}${c.rst}`;

    const stat = currentStatus[id] || `${c.gr}WAITING${c.rst}`;
    const pStat = proxyStatus[id] || `${c.gr}CHECKING${c.rst}`;

    const uName = acc.name || 'Unknown';
    const lId = acc.loginId || acc.email || 'N/A';
    const nextClaimTarget = forecasts[id] ? forecasts[id].local().format('HH:mm') : "--:--";
    
    // Line 1: Header (Blue Time)
    let lastClaimStr = accLog.lastClaimServer ? moment(accLog.lastClaimServer, 'YYYY-MM-DD HH:mm:ss').format('HH:mm') : 'N/A';
    console.log(`${c.cy}⫸ ${c.wh}${c.b}Acc ${idx + 1}:${c.rst} ${c.p}${uName}${c.rst} | ${c.wh}${lId}${c.rst} | ${c.s}Last Claim: ${c.p}${lastClaimStr}${c.rst}`);

    // Line 2: Status
    console.log(`${c.cy}⸽ Status: ${stat}${c.rst}`);

    // Line 3: Magenta Coins & Group UI
    let groupStr = `${c.gr}Waiting till ${nextClaimTarget}${c.rst}`;
    if (accLog.groupClaimDate === today) {
        if (accLog.groupState) {
            groupStr = `${c.g}${accLog.groupState.name} (+${accLog.groupState.reward})${c.rst}`;
        } else {
            groupStr = `${c.w}Manually Claimed${c.rst}`; 
        }
    }
    console.log(`${c.cy}⸽ ${c.rst}Coins: ${c.m}${(accLog.tokens.G || 0).toFixed(2)}${c.rst} | Group: ${groupStr}`);

    // Line 4: Profit (Dynamic Color)
    let ystStr = prevLog ? (prevLog.tokens.G || 0).toFixed(2) : '0.00';
    let syncTime = accLog.lastSync ? accLog.lastSync : '--:--';
    console.log(`${c.cy}⸽ ${c.rst}Profit: ${profitStr} ${c.gr}(${syncTime})${c.rst} | YST: ${c.wh}${ystStr}${c.rst}`);

    // Line 5: Wallet & Proxy (Spin Removed)
    let walletWord = (acc.wallet && acc.wallet !== 'None') ? `${c.g}Wallet${c.rst}` : `${c.gr}Wallet${c.rst}`;
    console.log(`${c.cy}⸽ ${c.rst}${walletWord} | Proxy: ${pStat}`);

    // Line 6 & 7: Windows Grid
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
    console.log(`${c.cy}⫹── ${c.rst}Next Claim: ${c.b}${c.wh}${nextClaimTarget}${c.rst}\n`);
}

// --- PM2 SMART SLEEP ENGINE ---
async function interruptibleSleep(ms, logIntervalMs = 0) {
    const steps = Math.floor(ms / 1000);
    let nextLog = logIntervalMs;
    for (let i = 0; i < steps; i++) {
        if (isShuttingDown) return; 
        
        if (moment().format('HH:mm:ss') === '00:00:01') trimLogs();

        await new Promise(r => setTimeout(r, 1000));
        
        if (logIntervalMs > 0) {
            nextLog -= 1000;
            if (nextLog <= 0) {
                const dur = moment.duration((steps - i) * 1000);
                const h = Math.floor(dur.asHours());
                const m = dur.minutes().toString().padStart(2, '0');
                console.log(`${c.cy}⸽${c.rst} Remaining : ${h}:${m} Hrs`);
                nextLog = logIntervalMs;
            }
        }
    }
}

// --- MAIN LOOP ---
async function main() {
    console.clear();
    console.log(`${c.cy}=================================================${c.rst}`);
    console.log(`         ${c.s}${c.b}INTERLINK FARMER ${APP_VERSION}: by PRASHANTH${c.rst}`);
    console.log(`${c.cy}=================================================${c.rst}`);

    let { accounts, logs } = migrateData();
    const logsTrimmed = trimLogs();
    if (logsTrimmed) {
        console.log(`\n${c.g}✅ [Log Manager] Excess history removed.${c.rst}`);
    }

    syncDevicePool(accounts);
    accounts = migrateData().accounts; 

    await new Promise(r => setTimeout(r, 1000));
    const today = moment.utc().format('YYYY-MM-DD');

    if (!Array.isArray(accounts) || accounts.length === 0) {
        console.log(`\n${c.e}No valid accounts found. Please check accounts.json.${c.rst}\n`);
        process.exit(1);
    }

    accounts.forEach(acc => {
        const id = acc.registeredEmail || acc.email || acc.deviceId || acc.loginId;
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

        const localWinStart = moment.utc().hour(winStartUtc).minute(0).local().format('HH:mm');
        const localWinEnd = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).local().format('HH:mm');          
        const diff = moment.utc().hour(winEndUtc === 0 ? 24 : winEndUtc).minute(0).second(0).diff(now);
        const rem = moment.duration(diff);

        console.log(`\n           ${c.s}${c.b}INTERLINK FARMER ${APP_VERSION}: by PRASHANTH${c.rst}`);
        console.log(`      ${c.gr}GMT ${moment().format('Z')} | Window: ${localWinStart}-${localWinEnd} | Rem: ${Math.floor(rem.asHours())}h ${rem.minutes()}m${c.rst}\n`);                               
        console.log(`${c.cy}─${c.rst}`.repeat(60) + `\n`);

        for (let i = 0; i < accounts.length; i++) {
            if (isShuttingDown) break;
            await processAccount(accounts[i], i);
            console.log(`${c.cy}─${c.rst}`.repeat(60) + `\n`);
            
            // Inter-Account Jitter (3-8 seconds)
            if (i < accounts.length - 1 && !isShuttingDown) {
                const interJitter = Math.floor(Math.random() * 5000) + 3000;
                await new Promise(r => setTimeout(r, interJitter));
            }
        }

        if (isShuttingDown) break;

        const activeAccs = accounts.filter(a => !a.paused);
        let allAccountsDone = true;
        let earliestNextFrame = null;

        activeAccs.forEach(a => {
            const aId = a.registeredEmail || a.email || a.deviceId || a.loginId;
            const targetTime = forecasts[aId];
            if (!targetTime || moment.utc().isSameOrAfter(targetTime)) {
                allAccountsDone = false; 
            } else {
                if (!earliestNextFrame || targetTime.isBefore(earliestNextFrame)) {
                    earliestNextFrame = targetTime;
                }
            }
        });

        if (allAccountsDone && earliestNextFrame) {
            const waitMs = earliestNextFrame.diff(moment.utc());
            const nextTimeStr = earliestNextFrame.local().format('HH:mm');
            
            console.log(`\n${c.p}⫸${c.rst} ${c.b}Deep Sleep Till ${nextTimeStr}${c.rst}\n`);
            
            await interruptibleSleep(waitMs, 600000); 
            
        } else {
            const retryDelayMs = Math.floor(Math.random() * 60000) + 60000; 
            console.log(`${c.p}⫸${c.rst} ${c.w}ACTIVE PURSUIT MODE:${c.rst} Accounts pending or failed.`);
            console.log(`${c.gr}>> Retrying operations in ${Math.floor(retryDelayMs / 1000)} seconds...${c.rst}\n`);
            
            await interruptibleSleep(retryDelayMs);
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
