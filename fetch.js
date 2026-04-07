const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ACCOUNTS_JSON = path.join(__dirname, 'accounts.json');
const API_BASE = 'https://prod.interlinklabs.ai/api/v1';

async function dumpData() {
    console.log("🔍 INTERLINK DATA DUMPER INITIALIZED...\n");

    let accounts = [];
    try { 
        accounts = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')); 
    } catch(e) { 
        return console.log("❌ Failed to read accounts.json");
    }

    if (accounts.length === 0) return console.log("❌ No accounts found.");
    
    // We only need to test the first account
    const acc = accounts[0];
    console.log(`Testing Account: ${acc.name || acc.loginId}`);

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
        console.log("\n=========================================");
        console.log("📡 FETCHING: /token/get-token");
        console.log("=========================================");
        const tokenRes = await client.get('/token/get-token');
        console.log(JSON.stringify(tokenRes.data, null, 2));

        console.log("\n=========================================");
        console.log("📡 FETCHING: /auth/current-user");
        console.log("=========================================");
        const userRes = await client.get('/auth/current-user');
        console.log(JSON.stringify(userRes.data, null, 2));

        console.log("\n=========================================");
        console.log("📡 FETCHING: /token/check-is-claimable");
        console.log("=========================================");
        const claimRes = await client.get('/token/check-is-claimable');
        console.log(JSON.stringify(claimRes.data, null, 2));

    } catch (e) {
        console.log("\n❌ ERROR ENCOUNTERED:");
        if (e.response && e.response.data) {
            console.log(JSON.stringify(e.response.data, null, 2));
        } else {
            console.log(e.message);
        }
    }
}

dumpData();
