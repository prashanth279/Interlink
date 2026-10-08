const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const https = require('https');
const axios = require('axios');
const moment = require('moment');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// --- APP CONFIGURATION ---
const APP_VERSION = '6.0.0'; 
const API_BASE_URL = 'https://prod.interlinklabs.ai/api/v1';
const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const DEVICE_POOL = path.join(__dirname, 'devicepool.txt');

// Advanced 256-Color Palette
const c = { p: '\x1b[38;5;39m', s: '\x1b[38;5;198m', a: '\x1b[38;5;118m', w: '\x1b[38;5;220m', e: '\x1b[38;5;196m', g: '\x1b[38;5;46m', wh: '\x1b[97m', gr: '\x1b[38;5;245m', cy: '\x1b[36m', m: '\x1b[38;5;207m', b: '\x1b[1m', rst: '\x1b[0m' };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(`${c.cy}⸽ ${c.wh}${q}${c.rst}`, (a) => res(a.trim())));

const MODELS = [
    { brand: 'POCO', model: '25053PC47G' },
    { brand: 'Samsung', model: 'Galaxy S24 Ultra' },
    { brand: 'Google', model: 'Pixel 8 Pro' },
    { brand: 'XiaoMi', model: 'Redmi Note 13' }
];

function getAgent(proxy) {
    if (!proxy) return new https.Agent({ rejectUnauthorized: false });
    if (proxy.toUpperCase() === 'NONE') return new https.Agent({ rejectUnauthorized: false });
    return proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy);
}

function getJwtExp(token) {
    if (!token) return 0;
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).exp; }
    catch (e) { return 0; }
}

function getHeaders(acc) {
    return {
        'Host': 'prod.interlinklabs.ai', 
        'Accept': '*/*',                 
        'Version': APP_VERSION,
        'X-Platform': 'android',
        'X-System-Name': 'Android',
        'X-Date': Date.now().toString(),
        'X-Brand': acc.brand ? acc.brand : 'POCO',
        'X-Model': acc.model ? acc.model : '25053PC47G',
        'X-Unique-Id': acc.deviceId,
        'X-Device-Id': acc.deviceId,
        'X-Bundle-Id': 'org.ai.interlinklabs.interlinkId',
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'okhttp/4.12.0',
        'Content-Type': 'application/json'
    };
}

// --- TELEGRAM DISPATCH PIPELINE ---
async function sendTelegramAlert(botToken, chatId, message) {
    if (!botToken) return false;
    if (!chatId) return false;
    try {
        const endpoint = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
        await axios.post(endpoint, {
            chat_id: chatId.trim(),
            text: message,
            parse_mode: 'Markdown'
        }, { timeout: 8000 });
        return true;
    } catch (err) {
        return false;
    }
}

// --- NETWORK & REFRESH ENGINE ---
async function pulseCheck(proxyUrl) {
    const agent = getAgent(proxyUrl);
    try {
        await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 6000 });
        return true;
    } catch (e) {
        try {
            await axios.get('https://icanhazip.com', { httpsAgent: agent, timeout: 6000 });
            return true;
        } catch (e2) { return false; }
    }
}

async function doRefreshToken(acc) {
    if (!acc.refreshToken) return false;
    try {
        const client = axios.create({ baseURL: API_BASE_URL, headers: getHeaders(acc), httpsAgent: getAgent(acc.proxy) });
        const res = await client.post(`/auth/token`, { refreshToken: acc.refreshToken });
        if (res.data && res.data.data) {
            acc.token = res.data.data.accessToken ? res.data.data.accessToken : res.data.data.jwtToken;
            acc.refreshToken = res.data.data.refreshToken ? res.data.data.refreshToken : acc.refreshToken;
            return true;
        }
        return false;
    } catch (e) { return false; }
}

// --- SECURE PROFILE SYNC ENGINE ---
async function syncProfile(acc) {
    const isAlive = await pulseCheck(acc.proxy);
    if (!isAlive) {
        acc.syncStatus = 'CONN_FAIL';
        return acc;
    }

    const exp = getJwtExp(acc.token);
    const nowTs = Math.floor(Date.now() / 1000);

    if (exp > 0 && nowTs > exp) {
        const refreshed = await doRefreshToken(acc);
        if (!refreshed) {
            acc.syncStatus = 'EXP';
            return acc;
        }
    }

    const agent = getAgent(acc.proxy);
    const client = axios.create({
        baseURL: API_BASE_URL,
        headers: { ...getHeaders(acc), 'Authorization': `Bearer ${acc.token}` },
        httpsAgent: agent, timeout: 12000
    });

    try {
        const userRes = await client.get('/auth/current-user-full?include=userInfo,token,isClaimable');
        const rootData = (userRes.data && userRes.data.data) ? userRes.data.data : {};
        const userData = rootData.userInfo ? rootData.userInfo : rootData;

        let fName = acc.name;
        if (userData.name) fName = userData.name;
        if (userData.username) fName = userData.username;
        acc.name = fName;

        let fLogin = acc.loginId;
        if (userData.loginId) fLogin = userData.loginId;
        acc.loginId = fLogin;

        let fEmail = acc.registeredEmail;
        if (userData.email) fEmail = userData.email;
        acc.registeredEmail = fEmail;
        
        let foundWallet = 'None';
        if (rootData.walletAddress) foundWallet = rootData.walletAddress;
        else if (userData.walletAddress) foundWallet = userData.walletAddress;
        else if (rootData.wallet && rootData.wallet.address) foundWallet = rootData.wallet.address;
        else if (userData.wallet && userData.wallet.address) foundWallet = userData.wallet.address;
        else if (rootData.connectedAccounts && rootData.connectedAccounts.wallet && rootData.connectedAccounts.wallet.address) foundWallet = rootData.connectedAccounts.wallet.address;
        else if (userData.connectedAccounts && userData.connectedAccounts.wallet && userData.connectedAccounts.wallet.address) foundWallet = userData.connectedAccounts.wallet.address;
        else if (Array.isArray(rootData.wallets) && rootData.wallets[0] && rootData.wallets[0].address) foundWallet = rootData.wallets[0].address;
        else if (Array.isArray(userData.wallets) && userData.wallets[0] && userData.wallets[0].address) foundWallet = userData.wallets[0].address;

        if (foundWallet && foundWallet !== 'None') {
            acc.wallet = foundWallet;
        } else {
            let isNoWallet = false;
            if (!acc.wallet) isNoWallet = true;
            if (acc.wallet === 'None') isNoWallet = true;
            if (isNoWallet) acc.wallet = 'None';
        }
        
        acc.lastUpdate = moment().format('YYYY-MM-DD HH:mm:ss');
        acc.syncStatus = 'SYNCED';
        return acc;
    } catch (e) {
        let isExp = false;
        if (e.response && e.response.status === 400) isExp = true;
        if (e.response && e.response.status === 401) isExp = true;
        acc.syncStatus = isExp ? 'EXP' : 'CONN_FAIL';
        return acc;
    }
}

// --- DEVICE POOL BACKEND MANAGERS ---
function appendToDevicePool(email, brand, model, deviceId) {
    let poolText = fs.existsSync(DEVICE_POOL) ? fs.readFileSync(DEVICE_POOL, 'utf8') : '';
    if (!poolText.includes(email)) {
        fs.appendFileSync(DEVICE_POOL, `${email} \u007C ${brand} \u007C ${model} \u007C ${deviceId}\n`);
    }
}

function updateDevicePoolFile(email, brand, model, deviceId) {
    let poolLines = fs.existsSync(DEVICE_POOL) ? fs.readFileSync(DEVICE_POOL, 'utf8').split('\n') : [];
    let found = false;
    const updatedLines = poolLines.map(line => {
        if (line.trim() && !line.startsWith('#')) {
            const parts = line.split('\u007C').map(p => p.trim());
            if (parts[0] === email) {
                found = true;
                return `${email} \u007C ${brand} \u007C ${model} \u007C ${deviceId}`;
            }
        }
        return line;
    });
    if (!found) updatedLines.push(`${email} \u007C ${brand} \u007C ${model} \u007C ${deviceId}`);
    
    const finalData = updatedLines.filter((l, i) => {
        let keepLine = false;
        if (l.trim()) keepLine = true;
        if (i === updatedLines.length - 1) keepLine = true;
        return keepLine;
    }).join('\n') + '\n';
    
    fs.writeFileSync(DEVICE_POOL, finalData);
}

// --- CORE LOGIN LOGIC (V2 SECURED) ---
async function performLogin(targetAcc = null) {
    console.log(`\n${c.m}◢◤ ${c.cy}AUTH_PROTOCOL_INITIATED (v${APP_VERSION}) ${c.m}◥◣${c.rst}`);
    let loginId, passcode, email, proxy, deviceId, identity;

    if (targetAcc) {
        let dispName = targetAcc.name ? targetAcc.name : targetAcc.registeredEmail;
        console.log(`${c.g}⸽ Auto-loading credentials for: ${dispName}${c.rst}`);
        loginId = targetAcc.loginId;
        passcode = targetAcc.passcode;
        email = targetAcc.registeredEmail ? targetAcc.registeredEmail : targetAcc.email;
        proxy = targetAcc.proxy;
        deviceId = targetAcc.deviceId;
        identity = { brand: targetAcc.brand, model: targetAcc.model };
    } else {
        loginId = await prompt('LOGIN ID: ');
        passcode = await prompt('PASSCODE: ');
        email = await prompt('EMAIL: ');
        proxy = await prompt('PROXY (leave blank for None): ');
        deviceId = crypto.randomBytes(8).toString('hex');
        identity = MODELS[Math.floor(Math.random() * MODELS.length)];
        appendToDevicePool(email, identity.brand, identity.model, deviceId);
    }

    const tempAcc = { deviceId, brand: identity.brand, model: identity.model, proxy };
    const client = axios.create({ baseURL: API_BASE_URL, headers: getHeaders(tempAcc), httpsAgent: getAgent(proxy) });

    try {
        console.log(`${c.gr}⸽ Requesting OTP...${c.rst}`);
        await client.post('/auth/send-otp-email-verify-login', { loginId, passcode, email, deviceId });
        console.log(`${c.g}⫸ OTP SENT TO EMAIL!${c.rst}`);

        const otp = await prompt('ENTER OTP: ');
        console.log(`${c.gr}⸽ Verifying OTP (v2 Security Handshake)...${c.rst}`);
        const verifyRes = await client.post(`/auth/check-otp-email-verify-login?v=2`, { loginId, otp, deviceId });

        let finalToken = null;
        if (verifyRes.data && verifyRes.data.data) {
            if (verifyRes.data.data.jwtToken) finalToken = verifyRes.data.data.jwtToken;
            if (verifyRes.data.data.accessToken) finalToken = verifyRes.data.data.accessToken;
        }
        const token = finalToken;

        let finalRef = null;
        if (verifyRes.data && verifyRes.data.data && verifyRes.data.data.refreshToken) {
            finalRef = verifyRes.data.data.refreshToken;
        }
        const refreshToken = finalRef;

        if (token) {
            console.log(`${c.g}✅ AUTHENTICATED SUCCESSFULLY${c.rst}`);
            let pStr = proxy ? proxy : 'NONE';
            let newAcc = { name: loginId, loginId, registeredEmail: email, passcode, token, refreshToken, deviceId, proxy: pStr, paused: false, ...identity };
            
            if (targetAcc && targetAcc.telegramBotToken) newAcc.telegramBotToken = targetAcc.telegramBotToken;
            if (targetAcc && targetAcc.telegramChatId) newAcc.telegramChatId = targetAcc.telegramChatId;
            if (targetAcc && targetAcc.wallet && targetAcc.wallet !== 'None') newAcc.wallet = targetAcc.wallet;

            newAcc = await syncProfile(newAcc);
            saveAccount(newAcc);

            if (newAcc.telegramBotToken && newAcc.telegramChatId) {
                const regReport = `✅ *[INTERLINK REGISTRATION]*\n\n*Profile Name:* \`${newAcc.name}\`\n*Login ID:* \`${newAcc.loginId}\`\n*Wallet:* \`${newAcc.wallet}\`\n*Status:* \`Synchronized & Saved Complete\``;
                await sendTelegramAlert(newAcc.telegramBotToken, newAcc.telegramChatId, regReport);
            }
            await prompt('\nPress Enter to return to menu...');
        }
    } catch (e) {
        let errMsg = e.message;
        if (e.response && e.response.data && e.response.data.message) errMsg = e.response.data.message;
        console.log(`\n${c.e}❌ AUTH_FAILED: ${errMsg}${c.rst}`);
        await prompt('\nPress Enter to return to menu...');
    }
}

// --- CRITICAL ISOLATED DATA COMMS ---
function saveAccount(acc) {
    let accounts = fs.existsSync(ACCOUNTS_JSON) ? JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')) : [];
    const idx = accounts.findIndex(a => a.loginId.toLowerCase() === acc.loginId.toLowerCase());
    
    if (idx !== -1) {
        let needsWallet = false;
        if (!acc.wallet) needsWallet = true;
        if (acc.wallet === 'None') needsWallet = true;

        let hasLegacyWallet = false;
        if (accounts[idx].wallet && accounts[idx].wallet !== 'None') hasLegacyWallet = true;

        if (needsWallet && hasLegacyWallet) {
            acc.wallet = accounts[idx].wallet;
        }
        accounts[idx] = acc;
    } else {
        accounts.push(acc);
    }
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

function saveAllAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_JSON, JSON.stringify(accounts, null, 2));
}

// --- MAIN UI DASHBOARD ---
async function main() {
    while (true) {
        console.clear();
        console.log(`${c.m}══ ${c.b}${c.cy}INTERLINK LOGIN ${APP_VERSION}${c.rst} ${c.m}══${c.rst}\n`);
        
        let accounts = fs.existsSync(ACCOUNTS_JSON) ? JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')) : [];

        if (accounts.length > 0) {
            accounts.forEach((a, i) => {
                let statusTag = '';
                if (a.syncStatus === 'SYNCED') statusTag = `${c.g}[🟢 SYNCED]${c.rst}`;
                else if (a.syncStatus === 'EXP') statusTag = `${c.e}[🔴 EXP - FIX REQ]${c.rst}`;
                else if (a.syncStatus === 'CONN_FAIL') statusTag = `${c.w}[🟡 CONN FAIL]${c.rst}`;
                else statusTag = `${c.gr}[⚪ INSTANT LOADED]${c.rst}`;

                const pauseTag = a.paused ? `${c.gr}[PAUSED]${c.rst}` : `${c.wh}[WORKING]${c.rst}`;
                const walletTag = (a.wallet && a.wallet !== 'None') ? `${c.g}[W]${c.rst}` : `${c.gr}[X]${c.rst}`;

                let dispName = a.name ? a.name.padEnd(14) : 'Unknown'.padEnd(14);
                console.log(`${c.cy}⫸${c.wh}${i+1}.${dispName}${c.rst} -${pauseTag} ${statusTag}${walletTag}`);
            });
        } else {
            console.log(`${c.gr}⸽ NO_ACCOUNTS_FOUND_IN_SYSTEM${c.rst}`);
        }

        console.log(`\n${c.cy}⫹── ${c.b}${c.wh}1. ADD/FIX - 2. REMOVE - 3. PAUSE - 4. INDEX.JS - 5. TELEGRAM - 6. DEVICES${c.rst} ──⫺`);
        const choice = await prompt('ACTION: ');

        if (choice === '1') {
            const id = await prompt('SELECT NUMBER TO FIX (OR LEAVE BLANK FOR NEW): ');
            if (id.trim() === '') {
                await performLogin(null);
            } else if (accounts[id-1]) {
                await performLogin(accounts[id-1]);
            } else {
                console.log(`${c.e}❌ Invalid selection index.${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '2') {
            const id = await prompt('SELECT NUMBER TO REMOVE: ');
            if (accounts[id-1]) {
                console.log(`${c.w}Removed ${accounts[id-1].name}${c.rst}`);
                accounts.splice(id-1, 1);
                saveAllAccounts(accounts);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '3') {
            const id = await prompt('SELECT NUMBER TO TOGGLE PAUSE: ');
            if (accounts[id-1]) {
                accounts[id-1].paused = !accounts[id-1].paused;
                saveAllAccounts(accounts);
                console.log(`${c.g}✅${accounts[id-1].name} Paused status changed to: ${accounts[id-1].paused}${c.rst}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else if (choice === '4') {
            console.clear();
            console.log(`${c.g}🚀 LAUNCHING INDEX.JS ENVIRONMENT...${c.rst}\n`);
            const child = spawn('node', ['index.js'], { stdio: 'inherit' });
            child.on('close', (code) => { process.exit(code); });
            break;
        } 
        else if (choice === '5') {
            console.clear();
            console.log(`${c.m}══ ${c.b}${c.cy}TELEGRAM NOTIFICATION CONFIG MANAGER${c.rst} ${c.m}══${c.rst}\n`);
            
            const currentTg = accounts.find(a => a.telegramBotToken && a.telegramChatId);
            if (currentTg) {
                console.log(`${c.g}Active Configuration Found:${c.rst}`);
                console.log(`Token: ${c.w}${currentTg.telegramBotToken}${c.rst}`);
                console.log(`Chat ID: ${c.w}${currentTg.telegramChatId}${c.rst}\n`);
            } else {
                console.log(`${c.gr}No current centralized Telegram endpoint saved.${c.rst}\n`);
            }

            console.log(`${c.cy}1.${c.wh} Configure / Update Central Telegram IDs`);
            console.log(`${c.cy}2.${c.wh} Send Consolidated Status Report For All Accounts At Once`);
            console.log(`${c.cy}3.${c.wh} Dispatch Instant Baseline Diagnostic Test Message`);
            console.log(`${c.cy}4.${c.wh} Disable / Pause All Telegram Notifications`);
            const subAction = await prompt('ACTION NUMBER: ');

            if (subAction === '1') {
                const token = await prompt('ENTER NEW TELEGRAM BOT TOKEN: ');
                const chatId = await prompt('ENTER NEW TELEGRAM CHAT ID: ');

                if (token && chatId) {
                    accounts.forEach(a => {
                        a.telegramBotToken = token;
                        a.telegramChatId = chatId;
                    });
                    saveAllAccounts(accounts);
                    console.log(`\n${c.g}✅ Configuration saved and applied to all profile nodes.${c.rst}`);
                } else {
                    console.log(`\n${c.e}❌ Properties configuration aborted.${c.rst}`);
                }
            } else if (subAction === '2') {
                const tgActive = currentTg ? currentTg : accounts.find(a => a.telegramBotToken && a.telegramChatId);
                if (tgActive && accounts.length > 0) {
                    console.log(`${c.w}⏳ Formatting database and shipping full asset overview...${c.rst}`);
                    
                    let overviewReport = `📋 *[INTERLINK ALL-ACCOUNTS REPORT]*\n\n`;
                    accounts.forEach((acc, idx) => {
                        let statusIndicator = '🟡';
                        if (acc.syncStatus === 'SYNCED') statusIndicator = '🟢';
                        if (acc.syncStatus === 'EXP') statusIndicator = '🔴';
                        
                        let aName = acc.name ? acc.name : acc.loginId;
                        overviewReport += `*${idx + 1}.${aName}*\n`;
                        
                        let syncDisp = acc.syncStatus ? acc.syncStatus : 'LOADED';
                        overviewReport += `• Status: ${statusIndicator} \`${syncDisp}\`\n`;
                        
                        let walletDisp = acc.wallet ? acc.wallet : 'None';
                        overviewReport += `• Wallet: \`${walletDisp}\`\n`;
                        overviewReport += `• Engine Mode: \`${acc.paused ? 'PAUSED' : 'WORKING'}\`\n\n`;
                    });
                    overviewReport += `*Total Saved Accounts:* \`${accounts.length}\`\n*Timestamp:* \`${moment().format('YYYY-MM-DD HH:mm:ss')}\``;

                    const sentOk = await sendTelegramAlert(tgActive.telegramBotToken, tgActive.telegramChatId, overviewReport);
                    if (sentOk) {
                        console.log(`${c.g}✅ Massive unified account report deployed successfully!${c.rst}`);
                    } else {
                        console.log(`${c.e}❌ Broadcast delivery transmission failed.${c.rst}`);
                    }
                } else {
                    console.log(`${c.e}❌ Verification aborted. Verify IDs are established and accounts exist.${c.rst}`);
                }
            } else if (subAction === '3') {
                const tgActive = currentTg ? currentTg : accounts.find(a => a.telegramBotToken && a.telegramChatId);
                if (tgActive) {
                    console.log(`${c.w}🚀 Delivering instant communication pipeline check...${c.rst}`);
                    const testMsg = `🧪 *[TELEGRAM TEST REPORT]*\n\n*Status:* \`Online\`\n*Agent:* \`Interlink Authorization Architect\`\n*Time:* \`${moment().format('HH:mm:ss LZ')}\``;
                    const ok = await sendTelegramAlert(tgActive.telegramBotToken, tgActive.telegramChatId, testMsg);
                    if (ok) console.log(`${c.g}✅ Test Message Delivered!${c.rst}`);
                    else console.log(`${c.e}❌ Pipeline check failed.${c.rst}`);
                } else {
                    console.log(`${c.e}❌ No valid active target credentials to execute check with.${c.rst}`);
                }
            } else if (subAction === '4') {
                if (accounts.length > 0) {
                    accounts.forEach(a => {
                        delete a.telegramBotToken;
                        delete a.telegramChatId;
                    });
                    saveAllAccounts(accounts);
                    console.log(`\n${c.g}✅ Telegram notifications disabled and paused across all profiles.${c.rst}`);
                } else {
                    console.log(`\n${c.gr}No accounts found to update.${c.rst}`);
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        } 
        else if (choice === '6') {
            console.clear();
            console.log(`${c.m}══ ${c.b}${c.cy}DEVICE HARDWARE PROFILE ARCHITECT${c.rst} ${c.m}══${c.rst}\n`);
            const id = await prompt('SELECT TARGET ACCOUNT NUMBER: ');
            const idx = parseInt(id) - 1;

            if (accounts[idx]) {
                const acc = accounts[idx];
                let pName = acc.name ? acc.name : acc.loginId;
                console.log(`\nProfile: ${c.p}${pName}${c.rst}`);
                let cBrand = acc.brand ? acc.brand : 'POCO';
                console.log(`Current Brand: ${c.w}${cBrand}${c.rst}`);
                let cModel = acc.model ? acc.model : '25053PC47G';
                console.log(`Current Model: ${c.w}${cModel}${c.rst}`);
                let cDevId = acc.deviceId ? acc.deviceId : 'N/A';
                console.log(`Current Unique Device ID: ${c.w}${cDevId}${c.rst}\n`);

                console.log(`${c.cy}1.${c.wh} Apply New Preset Model Variant`);
                console.log(`${c.cy}2.${c.wh} Input Custom Hardware Device ID String`);
                console.log(`${c.cy}3.${c.wh} Generate Fresh Randomized Hardware Signature`);
                const subChoice = await prompt('ACTION NUMBER: ');

                if (subChoice === '1') {
                    console.log(`\nAvailable Device Presets:`);
                    MODELS.forEach((m, mIdx) => { console.log(`  ${mIdx + 1}. ${m.brand} (${m.model})`); });
                    const presetId = await prompt('SELECT PRESET NUMBER: ');
                    const pIdx = parseInt(presetId) - 1;
                    if (MODELS[pIdx]) {
                        acc.brand = MODELS[pIdx].brand;
                        acc.model = MODELS[pIdx].model;
                        console.log(`${c.g}✅ Preset configuration updated successfully.${c.rst}`);
                    }
                } else if (subChoice === '2') {
                    const customId = await prompt('PASTE NEW HEX DEVICE ID STRING: ');
                    if (customId.trim()) {
                        acc.deviceId = customId.trim();
                        console.log(`${c.g}✅ Unique structural ID changed.${c.rst}`);
                    }
                } else if (subChoice === '3') {
                    acc.deviceId = crypto.randomBytes(8).toString('hex');
                    const randPreset = MODELS[Math.floor(Math.random() * MODELS.length)];
                    acc.brand = randPreset.brand;
                    acc.model = randPreset.model;
                    console.log(`${c.g}✅ Generated a completely random identity template.${c.rst}`);
                }

                let targetEmailKey = acc.loginId;
                if (acc.email) targetEmailKey = acc.email;
                if (acc.registeredEmail) targetEmailKey = acc.registeredEmail;
                
                updateDevicePoolFile(targetEmailKey, acc.brand, acc.model, acc.deviceId);
                saveAllAccounts(accounts);
            } else {
                console.log(`${c.e}❌ Selection array index out of bounds.${c.rst}`);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}

main().catch(err => console.error(err));
