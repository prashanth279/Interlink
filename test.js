const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';

async function testAccount(acc, idx) {
    console.log(`\n=========================================`);
    console.log(`🔍 TESTING ACCOUNT ${idx + 1}: ${acc.name || acc.loginId}`);
    console.log(`=========================================`);

    // Basic bypass client
    const client = axios.create({
        baseURL: API_BASE,
        headers: { 
            'Authorization': `Bearer ${acc.token}`, 
            'User-Agent': 'okhttp/4.12.0',
            'Content-Type': 'application/json'
        },
        timeout: 10000
    });

    try {
        // TEST 1: check-is-claimable
        console.log(`\n[TEST 1] Hitting /token/check-is-claimable...`);
        const claimCheck = await client.get('/token/check-is-claimable');
        const isClaimable = claimCheck.data?.data?.isClaimable;
        const nextFrameRaw = claimCheck.data?.data?.nextFrame;
        console.log(`  -> Server says isClaimable: ${isClaimable ? 'TRUE (Ready)' : 'FALSE (Not Ready)'}`);
        console.log(`  -> Server nextFrame UTC:    ${nextFrameRaw ? moment(nextFrameRaw).utc().format('YYYY-MM-DD HH:mm:ss') : 'N/A'}`);

        // TEST 2: get-token
        console.log(`\n[TEST 2] Hitting /token/get-token...`);
        const tokenCheck = await client.get('/token/get-token');
        const lastClaimRaw = tokenCheck.data?.data?.lastClaimTime;
        console.log(`  -> Server lastClaimTime:    ${lastClaimRaw ? moment(lastClaimRaw).format('YYYY-MM-DD HH:mm:ss') : 'N/A'}`);
        console.log(`  -> Current Gold Balance:    ${tokenCheck.data?.data?.interlinkGoldTokenAmount}`);

        // TEST 3: claim-airdrop
        console.log(`\n[TEST 3] Attempting Claim...`);
        if (isClaimable) {
            const claimRes = await client.post('/token/claim-airdrop', {});
            console.log(`  -> ✅ CLAIM SUCCESSFUL! Response:`);
            console.log(claimRes.data);
        } else {
            console.log(`  -> ⚠️ SKIPPING CLAIM: Server explicitly said isClaimable is false.`);
            console.log(`     (If we tried to claim now, the server would throw an ERR_400).`);
        }

    } catch (e) {
        console.log(`\n❌ ERROR ENCOUNTERED:`);
        if (e.response && e.response.data) {
            console.log(`Status: ${e.response.status}`);
            console.log(e.response.data);
        } else {
            console.log(e.message);
        }
    }
}

async function main() {
    let accounts = [];
    try { 
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); 
    } catch(e) { 
        console.log(`Failed to read accounts.json`);
        return;
    }

    for (let i = 0; i < accounts.length; i++) {
        await testAccount(accounts[i], i);
    }
    console.log(`\n🏁 DIAGNOSTIC COMPLETE.`);
}

main();
