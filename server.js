const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active hosts
// Structure: { [code]: { hostWs, controllerWs, psProcess } }
const activeHosts = {};

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
    let clientRole = null; // 'host' or 'controller'
    let clientCode = null; // The 9-digit connection code

    console.log('[WS] New client connected');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'register_host': {
                    clientRole = 'host';
                    clientCode = generateHostCode();
                    
                    console.log(`[Host] Registering host under code: ${clientCode}`);
                    
                    // Spawn persistent PowerShell automation agent for this host
                    let psProcess = null;
                    try {
                        psProcess = spawn('powershell', [
                            '-ExecutionPolicy', 'Bypass',
                            '-File', path.join(__dirname, 'input_agent.ps1')
                        ]);
                        
                        psProcess.stdout.on('data', (out) => {
                            console.log(`[PS Agent ${clientCode} stdout]: ${out.toString().trim()}`);
                        });
                        
                        psProcess.stderr.on('data', (err) => {
                            console.error(`[PS Agent ${clientCode} stderr]: ${err.toString().trim()}`);
                        });

                        psProcess.on('error', (err) => {
                            console.error(`[PS Agent ${clientCode} Failed to start]:`, err);
                        });

                        psProcess.on('close', (code) => {
                            console.log(`[PS Agent ${clientCode}] Exited with code ${code}`);
                        });
                    } catch (err) {
                        console.error('[Host] Failed to spawn PowerShell agent:', err);
                    }

                    activeHosts[clientCode] = {
                        hostWs: ws,
                        controllerWs: null,
                        psProcess: psProcess
                    };

                    ws.send(JSON.stringify({
                        type: 'host_registered',
                        code: clientCode
                    }));
                    break;
                }

                case 'connect_host': {
                    const code = data.code ? data.code.trim() : '';
                    console.log(`[Controller] Connection request for code: ${code}`);

                    const hostSession = activeHosts[code];
                    if (hostSession && !hostSession.controllerWs) {
                        clientRole = 'controller';
                        clientCode = code;
                        
                        hostSession.controllerWs = ws;
                        
                        console.log(`[Controller] Connected to host ${code}`);
                        
                        // Notify both peers
                        ws.send(JSON.stringify({ type: 'connection_established', role: 'controller' }));
                        hostSession.hostWs.send(JSON.stringify({ type: 'controller_connected' }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: hostSession ? 'Host already has a controller connected' : 'Host code not found or offline'
                        }));
                    }
                    break;
                }

                case 'signal': {
                    // Forward signaling messages (SDP offer/answer, ICE candidates)
                    const hostSession = activeHosts[clientCode];
                    if (hostSession) {
                        if (clientRole === 'host' && hostSession.controllerWs) {
                            hostSession.controllerWs.send(JSON.stringify({ type: 'signal', data: data.data }));
                        } else if (clientRole === 'controller' && hostSession.hostWs) {
                            hostSession.hostWs.send(JSON.stringify({ type: 'signal', data: data.data }));
                        }
                    }
                    break;
                }

                case 'inject_input': {
                    // Host forwards inputs received over WebRTC to its local PowerShell subprocess
                    if (clientRole === 'host') {
                        const hostSession = activeHosts[clientCode];
                        if (hostSession && hostSession.psProcess && hostSession.psProcess.stdin.writable) {
                            hostSession.psProcess.stdin.write(`${data.command}\n`);
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
        
        if (clientCode && activeHosts[clientCode]) {
            const session = activeHosts[clientCode];
            
            if (clientRole === 'host') {
                // Host disconnected, shut down everything
                console.log(`[Host] Host disconnected. Terminating session ${clientCode}`);
                
                if (session.controllerWs) {
                    session.controllerWs.send(JSON.stringify({ type: 'host_disconnected' }));
                    session.controllerWs.close();
                }

                // Shutdown PS agent
                if (session.psProcess) {
                    try {
                        session.psProcess.stdin.write("exit\n");
                        session.psProcess.stdin.end();
                        session.psProcess.kill();
                    } catch (e) {
                        console.error('[Server] Error killing PS Process:', e);
                    }
                }
                
                delete activeHosts[clientCode];
            } else if (clientRole === 'controller') {
                // Controller disconnected, notify Host to reset peer connection
                console.log(`[Controller] Controller disconnected from session ${clientCode}`);
                session.controllerWs = null;
                if (session.hostWs) {
                    session.hostWs.send(JSON.stringify({ type: 'controller_disconnected' }));
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`=============================================================`);
    console.log(`   MRD Server is running at http://localhost:${PORT}      `);
    console.log(`=============================================================`);
});
