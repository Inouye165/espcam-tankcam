import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import dgram from 'dgram';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());

// Verified SSIDs definition
const VERIFIED_SSIDS = ['Pumpkinpie', 'Dobby'];
let currentSSID = 'Unknown';
let isHostSecure = false;

// Helper to manually set network details (useful for tests)
function setSSIDInfo(ssid, secure) {
  currentSSID = ssid;
  isHostSecure = secure;
}

// Host Wi-Fi SSID network check (runs on Windows host)
async function checkWifiSSID() {
  let tempSSID = 'Unknown';
  let tempSecure = false;

  try {
    const { stdout } = await execAsync('netsh wlan show interfaces');
    const lines = stdout.split('\n');
    let ssidFound = false;

    for (const line of lines) {
      const trimmed = line.trim();
      // Match exactly "SSID" not "BSSID"
      if (trimmed.startsWith('SSID') && trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length > 1) {
          tempSSID = parts[1].trim();
          tempSecure = VERIFIED_SSIDS.includes(tempSSID);
          ssidFound = true;
          break;
        }
      }
    }

    if (!ssidFound) {
      tempSSID = 'Disconnected/Ethernet/Other';
      tempSecure = false;
    }
  } catch (err) {
    tempSSID = 'Ethernet/Non-WiFi';
    tempSecure = false;
  }

  // Fallback: Check network connection profiles (e.g. Ethernet) on Windows
  if (!tempSecure) {
    try {
      const { stdout: psOut } = await execAsync('powershell -Command "Get-NetConnectionProfile | Select-Object -ExpandProperty Name"');
      const names = psOut.split('\n').map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        if (VERIFIED_SSIDS.includes(name)) {
          tempSSID = name;
          tempSecure = true;
          break;
        }
      }
    } catch (psErr) {
      // Ignore powershell failures
    }
  }

  // Atomic update to prevent transient security lockouts during network checks
  currentSSID = tempSSID;
  isHostSecure = tempSecure;
}

// UDP Listener for ESP32-CAM Discovery
const cameras = {
  esp32cam: { ip: null, ssid: null, lastSeen: 0 },
  'espcam-seeed': { ip: null, ssid: null, lastSeen: 0 },
  'waveshare-esp32': { ip: null, ssid: null, lastSeen: 0, sensors: null }
};
const UDP_PORT = 3000;

const udpServer = dgram.createSocket('udp4');

// Active SSE clients for real-time telemetry streaming
let sseClients = [];

udpServer.on('error', (err) => {
  console.error(`UDP Server error:\n${err.stack}`);
  if (process.env.NODE_ENV !== 'test') {
    udpServer.close();
  }
});

udpServer.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    const device = data.device;
    if (cameras[device]) {
      cameras[device].ip = data.ip || rinfo.address;
      cameras[device].ssid = data.ssid;
      cameras[device].lastSeen = Date.now();
      if (data.sensors) {
        cameras[device].sensors = data.sensors;
      }
      // Broadcast incoming UDP beacon data to SSE clients in real-time
      const payload = JSON.stringify({
        device,
        ip: cameras[device].ip,
        ssid: cameras[device].ssid,
        sensors: cameras[device].sensors
      });
      sseClients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
      });
    }
  } catch (e) {
    // Ignore invalid JSON on the UDP channel
  }
});


// Mock camera info for testing
function setMockCamera(ip, ssid, lastSeenOffset = 0, device = 'esp32cam', sensors = null) {
  if (cameras[device]) {
    cameras[device].ip = ip;
    cameras[device].ssid = ssid;
    cameras[device].lastSeen = Date.now() - lastSeenOffset;
    cameras[device].sensors = sensors;
  }
}

// Server-Sent Events (SSE) stream for real-time telemetry updates
app.get('/api/telemetry-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Endpoint to fetch current network and camera status
app.get('/api/status', (req, res) => {

  const now = Date.now();
  const esp32camConnected = (now - cameras.esp32cam.lastSeen) < 6000;
  const seeedConnected = (now - cameras['espcam-seeed'].lastSeen) < 6000;
  const waveshareConnected = (now - cameras['waveshare-esp32'].lastSeen) < 6000;

  res.json({
    isHostSecure,
    hostSsid: currentSSID,
    // Backwards compatibility for single-camera tests
    cameraConnected: esp32camConnected,
    cameraIp: esp32camConnected ? cameras.esp32cam.ip : null,
    cameraSsid: esp32camConnected ? cameras.esp32cam.ssid : null,
    // Detailed multi-camera telemetry
    cameras: {
      esp32cam: {
        connected: esp32camConnected,
        ip: esp32camConnected ? cameras.esp32cam.ip : null,
        ssid: esp32camConnected ? cameras.esp32cam.ssid : null
      },
      'espcam-seeed': {
        connected: seeedConnected,
        ip: seeedConnected ? cameras['espcam-seeed'].ip : null,
        ssid: seeedConnected ? cameras['espcam-seeed'].ssid : null
      },
      'waveshare-esp32': {
        connected: waveshareConnected,
        ip: waveshareConnected ? cameras['waveshare-esp32'].ip : null,
        ssid: waveshareConnected ? cameras['waveshare-esp32'].ssid : null,
        sensors: waveshareConnected ? cameras['waveshare-esp32'].sensors : null
      }
    }
  });
});


// Warm TCP socket pool for low-latency command proxying (HTTP Keep-Alive)
// Constrained to 1 socket per host to prevent resource starvation on the ESP32
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1,
  maxFreeSockets: 1,
  timeout: 4000 // Close idle sockets after 4 seconds
});

// Helper to forward a GET request to an ESP device with a timeout and HTTP Keep-Alive
function forwardGetRequest({ clientReq, url, res, successMsg, errorLogPrefix, errorResponseMsg, timeoutMs = 1500 }) {
  const espReq = http.get(url, { agent: keepAliveAgent, timeout: timeoutMs }, (espRes) => {
    if (res.headersSent) return;
    res.status(espRes.statusCode).send(successMsg);
  });

  espReq.on('error', (err) => {
    if (res.headersSent) return;
    console.error(`${errorLogPrefix}:`, err.message);
    res.status(502).send(errorResponseMsg);
  });

  espReq.on('timeout', () => {
    espReq.destroy();
    if (res.headersSent) return;
    console.warn(`${errorLogPrefix} - Timeout after ${timeoutMs}ms`);
    res.status(504).send('Gateway Timeout');
  });
}

// Proxy route for MJPEG Stream
app.get('/api/stream', (req, res) => {
  // Network security check: halt video if server detects unverified network
  if (!isHostSecure) {
    console.warn(`Blocking stream request: Host is on unverified SSID '${currentSSID}'`);
    return res.status(403).send('Not on verified safe network');
  }

  const device = req.query.device || 'esp32cam';
  const cam = cameras[device];

  if (!cam) {
    return res.status(400).send('Invalid device');
  }

  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Camera disconnected');
  }

  console.log(`Proxying stream request to ${device} at ${cam.ip}`);
  const espUrl = `http://${cam.ip}/stream`;

  const espReq = http.get(espUrl, { timeout: 5000 }, (espRes) => {
    // Optimization: Disable Nagle's algorithm on sockets for lowest latency
    if (req.socket) req.socket.setNoDelay(true);
    if (espRes.socket) espRes.socket.setNoDelay(true);

    // Pipe the MJPEG headers and multipart body boundary directly to the client
    res.writeHead(espRes.statusCode, espRes.headers);
    espRes.pipe(res);
  });

  espReq.on('error', (err) => {
    console.error(`MJPEG Proxy connection error for ${device}:`, err.message);
    if (!res.headersSent) {
      res.status(502).send(`Bad gateway connection to ${device}`);
    }
  });

  espReq.on('timeout', () => {
    espReq.destroy();
    console.warn(`MJPEG Stream connection timeout for ${device}`);
    if (!res.headersSent) {
      res.status(504).send('Gateway Timeout');
    }
  });

  req.on('close', () => {
    espReq.destroy();
  });
});

// Control Endpoint for camera properties (e.g. Flash light)
app.get('/api/control', (req, res) => {
  if (!isHostSecure) {
    return res.status(403).send('Not on verified safe network');
  }

  const device = req.query.device || 'esp32cam';
  const cam = cameras[device];

  if (!cam) {
    return res.status(400).send('Invalid device');
  }

  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Camera disconnected');
  }

  const { var: variable, val } = req.query;
  if (!variable || val === undefined) {
    return res.status(400).send('Missing query parameters');
  }

  const espUrl = `http://${cam.ip}/control?var=${variable}&val=${val}`;
  console.log(`Forwarding control command to ${device}: ${espUrl}`);

  forwardGetRequest({
    clientReq: req,
    url: espUrl,
    res,
    successMsg: 'Control command forwarded',
    errorLogPrefix: `Control proxy error for ${device}`,
    errorResponseMsg: `Bad gateway communication with ${device}`
  });
});

// Proxy route for Drive controls: /api/drive?x=X&y=Y
app.get('/api/drive', (req, res) => {
  if (!isHostSecure) {
    return res.status(403).send('Not on verified safe network');
  }

  const cam = cameras['waveshare-esp32'];
  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Waveshare disconnected');
  }

  const { x, y } = req.query;
  if (x === undefined || y === undefined) {
    return res.status(400).send('Missing parameters');
  }

  const espUrl = `http://${cam.ip}/drive?x=${x}&y=${y}`;
  forwardGetRequest({
    clientReq: req,
    url: espUrl,
    res,
    successMsg: 'Drive command forwarded',
    errorLogPrefix: 'Drive proxy error',
    errorResponseMsg: 'Bad gateway connection to waveshare'
  });
});

// Proxy route for Speed Limit: /api/speed?val=VAL
app.get('/api/speed', (req, res) => {
  if (!isHostSecure) {
    return res.status(403).send('Not on verified safe network');
  }

  const cam = cameras['waveshare-esp32'];
  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Waveshare disconnected');
  }

  const { val } = req.query;
  if (val === undefined) {
    return res.status(400).send('Missing parameters');
  }

  const espUrl = `http://${cam.ip}/speed?val=${val}`;
  forwardGetRequest({
    clientReq: req,
    url: espUrl,
    res,
    successMsg: 'Speed command forwarded',
    errorLogPrefix: 'Speed proxy error',
    errorResponseMsg: 'Bad gateway connection to waveshare'
  });
});

// Proxy route for set_pwm: /api/set_pwm?motor=left|right&val=VAL
app.get('/api/set_pwm', (req, res) => {
  if (!isHostSecure) {
    return res.status(403).send('Not on verified safe network');
  }

  const cam = cameras['waveshare-esp32'];
  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Waveshare disconnected');
  }

  const { motor, val } = req.query;
  if (!motor || val === undefined) {
    return res.status(400).send('Missing parameters');
  }

  const espUrl = `http://${cam.ip}/set_pwm?motor=${motor}&val=${val}`;
  forwardGetRequest({
    clientReq: req,
    url: espUrl,
    res,
    successMsg: 'Set PWM command forwarded',
    errorLogPrefix: 'Set PWM proxy error',
    errorResponseMsg: 'Bad gateway connection to waveshare'
  });
});

// Proxy route for save calibration: /api/save?left=L&right=R
app.get('/api/save', (req, res) => {
  if (!isHostSecure) {
    return res.status(403).send('Not on verified safe network');
  }

  const cam = cameras['waveshare-esp32'];
  const cameraConnected = (Date.now() - cam.lastSeen) < 6000;
  if (!cameraConnected || !cam.ip) {
    return res.status(503).send('Waveshare disconnected');
  }

  const { left, right } = req.query;
  if (left === undefined || right === undefined) {
    return res.status(400).send('Missing parameters');
  }

  const espUrl = `http://${cam.ip}/save?left=${left}&right=${right}`;
  forwardGetRequest({
    clientReq: req,
    url: espUrl,
    res,
    successMsg: 'Save calibration command forwarded',
    errorLogPrefix: 'Save calibration proxy error',
    errorResponseMsg: 'Bad gateway connection to waveshare'
  });
});

// Serve frontend build static files
const frontendDistPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDistPath));

// Catch-all route to serve index.html for Single-Page App router
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// Self-start configuration: only run intervals and bind if NOT running in Jest environment
if (process.env.NODE_ENV !== 'test') {
  checkWifiSSID().then(() => {
    setInterval(checkWifiSSID, 5000);
    
    udpServer.on('listening', () => {
      const address = udpServer.address();
      console.log(`UDP Auto-Discovery listener active on port ${address.port}`);
    });
    
    udpServer.bind(UDP_PORT);

    app.listen(port, () => {
      console.log(`Node.js Backend Server running on port ${port}`);
    });
  });
}

export { app, checkWifiSSID, VERIFIED_SSIDS, setSSIDInfo, setMockCamera, udpServer };
