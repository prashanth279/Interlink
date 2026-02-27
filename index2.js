const fs = require('fs');
const axios = require('axios');

async function checkAuth() {
    // 1. Check if accounts.json exists
    if (!fs.existsSync('accounts.json')) {
        console.error("❌ Error: accounts.json not found. Run node login.js first.");
        return;
    }

    const accounts = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
    console.log(`\n🔍 Found ${accounts.length} account(s). Starting verification...\n`);

    for (const [index, acc] of accounts.entries()) {
        try {
            // 2. Attempt a simple profile or balance request to verify token
            const response = await axios.get('https://api.interlink.gold/user/profile', {
                headers: {
                    'Authorization': `Bearer ${acc.token}`,
                    'X-Device-Id': acc.deviceId,
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 10)'
                }
            });

            if (response.status === 200) {
                console.log(`✅ Account ${index + 1} [${acc.email}]: AUTH OK`);
                console.log(`   💰 Balance: ${response.data.balance_gold} GOLD`);
            }
        } catch (error) {
            console.log(`❌ Account ${index + 1} [${acc.email}]: AUTH FAILED`);
            if (error.response) {
                console.log(`   Reason: ${error.response.data.message || 'Invalid Token'}`);
            } else {
                console.log(`   Reason: Network Error/Proxy Issue`);
            }
        }
    }
    console.log(`\nVerification complete.`);
}

checkAuth();
