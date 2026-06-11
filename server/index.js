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
          currentSSID = parts[1].trim();
          isHostSecure = VERIFIED_SSIDS.includes(currentSSID);
          ssidFound = true;
          break;
        }
      }
    }

    if (!ssidFound) {
      currentSSID = 'Disconnected/Ethernet/Other';
      isHostSecure = false;
    }
  } catch (err) {
    currentSSID = 'Ethernet/Non-WiFi';
    isHostSecure = false;
  }
}

// UDP Listener for ESP32-CAM Discovery
let cameraIp = null;
let cameraSsid = null;
let cameraLastSeen = 0;
const UDP_PORT = 3000;

const udpServer = dgram.createSocket('udp4');

udpServer.on('error', (err) => {
  console.error(`UDP Server error:\n${err.stack}`);
  if (process.env.NODE_ENV !== 'test') {
    udpServer.close();
  }
});

udpServer.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data.device === 'esp32cam') {
      cameraIp = data.ip || rinfo.address;
      cameraSsid = data.ssid;
      cameraLastSeen = Date.now();
    }
  } catch (e) {
    // Ignore invalid JSON on the UDP channel
  }
});

// Mock camera info for testing
function setMockCamera(ip, ssid, lastSeenOffset = 0) {
  cameraIp = ip;
  cameraSsid = ssid;
  cameraLastSeen = Date.now() - lastSeenOffset;
}

// Endpoint to fetch current network and camera status
app.get('/api/status', (req, res) => {
  const cameraConnected = (Date.now() - cameraLastSeen) < 6000; // 6s timeout window
  res.json({
    isHostSecure,
    hostSsid: currentSSID,
    cameraConnected,
    cameraIp: cameraConnected ? cameraIp : null,
    cameraSsid: cameraConnected ? cameraSsid : null
  });
});

// Proxy route for MJPEG Stream
app.get('/api/stream', (req, res) => {
  // Network security check: halt video if server detects unverified network
  if (!isHostSecure) {
    console.warn(`Blocking stream request: Host is on unverified SSID '${currentSSID}'`);
    return res.status(403).send('Not on verified safe network');
  }

  const cameraConnected = (Date.now() - cameraLastSeen) < 6000;
  if (!cameraConnected || !cameraIp) {
    return res.status(503).send('Camera disconnected');
  }

  console.log(`Proxying stream request to ESP32-CAM at ${cameraIp}`);
  const espUrl = `http://${cameraIp}/stream`;

  const espReq = http.get(espUrl, (espRes) => {
    // Optimization: Disable Nagle's algorithm on sockets for lowest latency
    if (req.socket) req.socket.setNoDelay(true);
    if (espRes.socket) espRes.socket.setNoDelay(true);

    // Pipe the MJPEG headers and multipart body boundary directly to the client
    res.writeHead(espRes.statusCode, espRes.headers);
    espRes.pipe(res);
  });

  espReq.on('error', (err) => {
    console.error('MJPEG Proxy connection error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Bad gateway connection to ESP32-CAM');
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

  const cameraConnected = (Date.now() - cameraLastSeen) < 6000;
  if (!cameraConnected || !cameraIp) {
    return res.status(503).send('Camera disconnected');
  }

  const { var: variable, val } = req.query;
  if (!variable || val === undefined) {
    return res.status(400).send('Missing query parameters');
  }

  const espUrl = `http://${cameraIp}/control?var=${variable}&val=${val}`;
  console.log(`Forwarding control command to ESP32: ${espUrl}`);

  const controlReq = http.get(espUrl, (espRes) => {
    res.status(espRes.statusCode).send('Control command forwarded');
  });

  controlReq.on('error', (err) => {
    console.error('Control proxy error:', err.message);
    res.status(502).send('Bad gateway communication with camera');
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
