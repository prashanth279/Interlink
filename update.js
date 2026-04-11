const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Advanced 256-Color Palette 
const c = {
    p: '\x1b[38;5;39m',   
    w: '\x1b[38;5;220m',  
    e: '\x1b[38;5;196m',  
    g: '\x1b[38;5;46m',   
    wh: '\x1b[97m',       
    gr: '\x1b[38;5;245m', 
    cy: '\x1b[36m',       
    b: '\x1b[1m',         
    rst: '\x1b[0m'        
};

console.clear();
console.log(`${c.cy}=================================================${c.rst}`);
console.log(`         ${c.p}${c.b}INTERLINK AUTO-UPDATER${c.rst}`);
console.log(`${c.cy}=================================================${c.rst}\n`);

// Phase 0: Setup Auto-Boot for Termux
console.log(`${c.p}⫸${c.rst} ${c.wh}Step 0: Checking Termux Auto-Boot...${c.rst}`);
const bashrcPath = path.join(os.homedir(), '.bashrc');
const bootCmd = 'cd ~/interlink && node index.js';

try {
    let bashrcContent = '';
    if (fs.existsSync(bashrcPath)) {
        bashrcContent = fs.readFileSync(bashrcPath, 'utf8');
    }
    
    if (!bashrcContent.includes(bootCmd)) {
        fs.appendFileSync(bashrcPath, `\n# Interlink Auto-Boot\n${bootCmd}\n`);
        console.log(`${c.g}✅ Auto-Boot configured successfully.${c.rst}\n`);
    } else {
        console.log(`${c.gr}⚡ Auto-Boot is already configured. Skipping.${c.rst}\n`);
    }
} catch (e) {
    console.log(`${c.e}⚠️ Could not configure Auto-Boot, but proceeding anyway.${c.rst}\n`);
}

// Phase 1: Force Sync from GitHub
console.log(`${c.p}⫸${c.rst} ${c.wh}Step 1: Connecting to GitHub...${c.rst}`);
console.log(`${c.cy}⸽${c.rst} ${c.gr}Running: git fetch origin && git reset --hard origin/main${c.rst}\n`);

const gitCommand = 'git fetch origin && git reset --hard origin/main';

exec(gitCommand, (error, stdout, stderr) => {
    if (error) {
        console.log(`${c.e}❌ GIT UPDATE FAILED!${c.rst}\n`);
        console.log(`${c.wh}${error.message}${c.rst}`);
        
        if (error.message.includes('unknown revision')) {
            console.log(`\n${c.w}Tip: If your GitHub branch is named 'master' instead of 'main', open update.js and change 'origin/main' to 'origin/master'.${c.rst}\n`);
        }
        process.exit(1);
    }

    if (stdout) console.log(`${c.gr}${stdout.trim()}${c.rst}`);
    console.log(`${c.g}✅ Files synced perfectly.${c.rst}\n`);

    // Phase 2: Install Node Modules
    console.log(`${c.p}⫸${c.rst} ${c.wh}Step 2: Checking Dependencies...${c.rst}`);
    console.log(`${c.cy}⸽${c.rst} ${c.gr}Running: npm install${c.rst}\n`);

    exec('npm install', (npmError, npmStdout, npmStderr) => {
        if (npmError) {
            console.log(`${c.e}❌ NPM INSTALL FAILED!${c.rst}\n`);
            console.log(`${c.wh}${npmError.message}${c.rst}`);
            process.exit(1);
        }

        console.log(`\n${c.g}✅ UPDATE & INSTALL SUCCESSFUL!${c.rst}`);
        console.log(`${c.cy}⫹──${c.rst} ${c.wh}Launching Interlink Miner...${c.rst}\n`);
        
        // Phase 3: Launch index.js
        setTimeout(() => {
            const indexPath = path.join(__dirname, 'index.js');
            const child = spawn('node', [indexPath], { stdio: 'inherit' });
            
            child.on('close', (code) => {
                process.exit(code);
            });
        }, 1500); 
    });
});
