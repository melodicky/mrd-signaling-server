const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

// Load SSL certificates dynamically if they exist in the root folder or paths defined in env
const sslKeyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'key.pem');
const sslCertPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem');
let server;
let protocol = 'http';

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
    try {
        const options = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };
        server = https.createServer(options, app);
        protocol = 'https';
        console.log('[Server] Initialized secure HTTPS server');
    } catch (e) {
        console.error('[Server] Failed to load SSL certificates. Falling back to HTTP:', e.message);
        server = http.createServer(app);
    }
} else {
    server = http.createServer(app);
    console.log('[Server] SSL certificates (key.pem, cert.pem) not found. Initialized HTTP server.');
}

const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const MAX_ACTIVE_HOSTS = 50; // Prevent memory exhaustion from too many abandoned sessions

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// SPA Routing: Serve index.html for known client-side routes
app.get(['/', '/home', '/access', '/support', '/headless', '/settings'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Store active hosts
// Structure: { [code]: { hostWs, controllerWs, psProcess, lastActivity, pin } }
const activeHosts = {};

// ICE / STUN / TURN servers configuration
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: process.env.TURN_URL || 'turn:global.relay.metered.ca:80',
        username: process.env.TURN_USERNAME || 'openrelayproject',
        credential: process.env.TURN_CREDENTIAL || 'openrelayproject'
    },
    {
        urls: process.env.TURN_URL_SECURE || 'turn:global.relay.metered.ca:443',
        username: process.env.TURN_USERNAME || 'openrelayproject',
        credential: process.env.TURN_CREDENTIAL || 'openrelayproject'
    },
    {
        urls: process.env.TURNS_URL_SECURE || 'turns:global.relay.metered.ca:443',
        username: process.env.TURN_USERNAME || 'openrelayproject',
        credential: process.env.TURN_CREDENTIAL || 'openrelayproject'
    }
];

// ── Session Timeout: clean up sessions idle for more than 10 minutes ──────────
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const code of Object.keys(activeHosts)) {
        const session = activeHosts[code];
        const idle = now - (session.lastActivity || now);
        if (idle > SESSION_TIMEOUT_MS) {
            console.log(`[Timeout] Session ${code} idle for ${Math.round(idle/60000)}m. Cleaning up.`);
            try {
                if (session.hostWs) session.hostWs.send(JSON.stringify({ type: 'session_timeout' }));
                if (session.controllerWs) session.controllerWs.send(JSON.stringify({ type: 'session_timeout' }));
                if (session.hostWs) session.hostWs.close();
                if (session.controllerWs) session.controllerWs.close();
                if (session.psProcess) { try { session.psProcess.kill(); } catch(e){} }
            } catch (e) { /* ignore close errors */ }
            delete activeHosts[code];
        }
    }
}, 60 * 1000); // Check every minute

// Helper to generate a 9-digit code like "123 456 789"
function generateHostCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < 9; i++) {
            code += Math.floor(Math.random() * 10);
            if (i === 2 || i === 5) {
                code += ' ';
            }
        }
    } while (activeHosts[code]); // Ensure uniqueness
    return code;
}

wss.on('connection', (ws) => {
    let clientRole = null; // 'host', 'controller', or 'local_agent'
    let clientCode = null; // The 9-digit connection code

    console.log('[WS] New client connected');

    // Send configuration (such as ICE Servers) dynamically to client
    ws.send(JSON.stringify({
        type: 'config',
        iceServers: ICE_SERVERS
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register_local_agent': {
                    // Local agent running on Host PC for direct input injection
                    // Spawns the PowerShell agent dedicated for this connection
                    clientRole = 'local_agent';
                    console.log('[LocalAgent] Local agent registered on Host PC');
                    
                    let psProcess = null;
                    try {
                        psProcess = spawn('powershell', [
                            '-ExecutionPolicy', 'Bypass',
                            '-File', path.join(__dirname, 'input_agent.ps1')
                        ]);
                        
                        psProcess.stdout.on('data', (out) => {
                            console.log(`[PS LocalAgent stdout]: ${out.toString().trim()}`);
                        });
                        psProcess.stderr.on('data', (err) => {
                            console.error(`[PS LocalAgent stderr]: ${err.toString().trim()}`);
                        });
                        psProcess.on('close', (code) => {
                            console.log(`[PS LocalAgent] Exited with code ${code}`);
                        });
                    } catch (err) {
                        console.error('[LocalAgent] Failed to spawn PowerShell:', err);
                    }
                    
                    // Store on ws object so inject_input can find it
                    ws._psProcess = psProcess;
                    ws.send(JSON.stringify({ type: 'local_agent_ready' }));
                    break;
                }

                case 'register_host': {
                    // Reject if too many sessions to prevent resource exhaustion
                    if (Object.keys(activeHosts).length >= MAX_ACTIVE_HOSTS) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Server at capacity. Try again later.' }));
                        break;
                    }
                    
                    clientRole = 'host';
                    
                    // If host requests a code, verify it is unoccupied or matches this client's existing host session
                    const requestedCode = data.code ? data.code.trim() : null;
                    if (requestedCode && (!activeHosts[requestedCode] || activeHosts[requestedCode].hostWs === ws)) {
                        clientCode = requestedCode;
                        console.log(`[Host] Registering host under claimed code: ${clientCode} (PIN set: ${!!data.pin})`);
                        activeHosts[clientCode] = {
                            hostWs: ws,
                            controllerWs: activeHosts[clientCode] ? activeHosts[clientCode].controllerWs : null,
                            psProcess: null,
                            lastActivity: Date.now(),
                            pin: data.pin || null
                        };
                    } else {
                        clientCode = generateHostCode();
                        console.log(`[Host] Registering host under new code: ${clientCode} (PIN set: ${!!data.pin})`);
                        activeHosts[clientCode] = {
                            hostWs: ws,
                            controllerWs: null,
                            psProcess: null, // no longer spawned here
                            lastActivity: Date.now(),
                            pin: data.pin || null
                        };
                    }

                    ws.send(JSON.stringify({
                        type: 'host_registered',
                        code: clientCode
                    }));
                    break;
                }

                case 'connect_host': {
                    const code = data.code ? data.code.trim() : '';
                    const pin = data.pin ? data.pin.trim() : '';
                    console.log(`[Controller] Connection request for code: ${code}`);

                    const hostSession = activeHosts[code];
                    if (hostSession) {
                        if (hostSession.controllerWs) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Host already has a controller connected' }));
                            break;
                        }

                        // PIN Authentication check
                        if (hostSession.pin && hostSession.pin !== pin) {
                            ws.send(JSON.stringify({
                                type: 'auth_required',
                                message: pin ? 'Incorrect PIN code' : 'PIN required to connect'
                            }));
                            break;
                        }

                        clientRole = 'controller';
                        clientCode = code;
                        
                        hostSession.controllerWs = ws;
                        
                        console.log(`[Controller] Connected to host ${code}`);
                        
                        // Spawn PowerShell input agent on HOST side (via host's signaling WS)
                        // This is the fallback path when the Chrome extension can't open a
                        // separate local-agent WebSocket connection to localhost:3000.
                        if (!hostSession.psProcess) {
                            try {
                                const psProc = spawn('powershell', [
                                    '-ExecutionPolicy', 'Bypass',
                                    '-File', path.join(__dirname, 'input_agent.ps1')
                                ]);
                                psProc.stdout.on('data', (out) => {
                                    console.log(`[PS Host stdout]: ${out.toString().trim()}`);
                                });
                                psProc.stderr.on('data', (err) => {
                                    console.error(`[PS Host stderr]: ${err.toString().trim()}`);
                                });
                                psProc.on('close', (code) => {
                                    console.log(`[PS Host] PowerShell exited with code ${code}`);
                                    if (activeHosts[clientCode]) {
                                        activeHosts[clientCode].psProcess = null;
                                    }
                                });
                                hostSession.psProcess = psProc;
                                console.log('[PS Host] Spawned input agent for host session');
                            } catch (err) {
                                console.error('[PS Host] Failed to spawn PowerShell input agent:', err);
                            }
                        }
                        
                        // Notify both peers
                        ws.send(JSON.stringify({ type: 'connection_established', role: 'controller' }));
                        hostSession.hostWs.send(JSON.stringify({ type: 'controller_connected' }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Host code not found or offline'
                        }));
                    }
                    break;
                }

                case 'signal': {
                    // Forward signaling messages (SDP offer/answer, ICE candidates)
                    // Also update lastActivity to keep session alive
                    const hostSession = activeHosts[clientCode];
                    if (hostSession) {
                        hostSession.lastActivity = Date.now(); // Reset idle timer
                        if (clientRole === 'host' && hostSession.controllerWs) {
                            hostSession.controllerWs.send(JSON.stringify({ type: 'signal', data: data.data }));
                        } else if (clientRole === 'controller' && hostSession.hostWs) {
                            hostSession.hostWs.send(JSON.stringify({ type: 'signal', data: data.data }));
                        }
                    }
                    break;
                }

                case 'control_input': {
                    const hostSession = activeHosts[clientCode];
                    if (hostSession && clientRole === 'controller' && hostSession.hostWs) {
                        hostSession.hostWs.send(JSON.stringify({
                            type: 'control_input',
                            data: data.data
                        }));
                    }
                    break;
                }

                case 'inject_input': {
                    console.log(`[Server] inject_input received. Role: ${clientRole}, Command: ${data.command}`);
                    // Handle injection for both local_agent and host roles
                    if (clientRole === 'local_agent') {
                        // Direct injection via dedicated local agent WebSocket
                        const psProc = ws._psProcess;
                        if (psProc && psProc.stdin.writable) {
                            psProc.stdin.write(`${data.command}\n`);
                        } else {
                            console.warn('[Server] local_agent psProcess not writable or null');
                        }
                    } else if (clientRole === 'host') {
                        // Legacy: Host forwards inputs received over WebRTC to its local PowerShell subprocess
                        const hostSession = activeHosts[clientCode];
                        if (hostSession) {
                            if (hostSession.psProcess && hostSession.psProcess.stdin.writable) {
                                hostSession.psProcess.stdin.write(`${data.command}\n`);
                            } else {
                                console.warn('[Server] hostSession psProcess not writable or null');
                            }
                        } else {
                            console.warn(`[Server] Host session not found for code ${clientCode}`);
                        }
                    }
                    break;
                }
                
                case 'ping': {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                }
            }
        } catch (err) {
            console.error('[WS Error] Processing message failed:', err);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Connection closed for role: ${clientRole}, code: ${clientCode}`);
        
        // Clean up local agent PowerShell process
        if (clientRole === 'local_agent' && ws._psProcess) {
            try {
                ws._psProcess.stdin.write('exit\n');
                ws._psProcess.stdin.end();
                ws._psProcess.kill();
            } catch (e) {}
            console.log('[LocalAgent] PowerShell agent terminated');
        }
        
        if (clientCode && activeHosts[clientCode]) {
            const session = activeHosts[clientCode];
            
            if (clientRole === 'host') {
                // Host disconnected, shut down everything
                console.log(`[Host] Host disconnected. Terminating session ${clientCode}`);
                
                if (session.controllerWs) {
                    session.controllerWs.send(JSON.stringify({ type: 'host_disconnected' }));
                    session.controllerWs.close();
                }

                // Shutdown PS agent (legacy path - local_agent now handles this)
                if (session.psProcess) {
                    try {
                        session.psProcess.stdin.write("exit\n");
                        session.psProcess.stdin.end();
                        session.psProcess.kill();
                    } catch (e) { /* ignore */ }
                }
                
                delete activeHosts[clientCode];
            } else if (clientRole === 'controller') {
                // Controller disconnected, notify Host to reset peer connection
                console.log(`[Controller] Controller disconnected from session ${clientCode}`);
                session.controllerWs = null;
                
                // Kill the session's PowerShell input agent (will be respawned on next connect)
                if (session.psProcess) {
                    try {
                        session.psProcess.stdin.write('exit\n');
                        session.psProcess.stdin.end();
                        session.psProcess.kill();
                    } catch (e) { /* ignore */ }
                    session.psProcess = null;
                    console.log('[PS Host] PowerShell agent terminated on controller disconnect');
                }
                
                if (session.hostWs) {
                    session.hostWs.send(JSON.stringify({ type: 'controller_disconnected' }));
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`=============================================================`);
    console.log(`   MRD Server is running at ${protocol}://localhost:${PORT}  `);
    console.log(`=============================================================`);
});
