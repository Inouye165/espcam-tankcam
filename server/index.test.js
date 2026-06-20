import request from 'supertest';
import { app, setSSIDInfo, setMockCamera, udpServer } from './index.js';

describe('ESP32-CAM Server Backend Regression Tests', () => {
  
  afterAll(() => {
    // Close the UDP socket so that Jest can exit cleanly
    udpServer.close();
  });

  test('GET /api/status - verified SSID (Pumpkinpie) with camera offline', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera(null, null, 10000); // Last seen 10 seconds ago (disconnected)

    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      isHostSecure: true,
      hostSsid: 'Pumpkinpie',
      cameraConnected: false,
      cameraIp: null,
      cameraSsid: null,
      cameras: {
        esp32cam: { connected: false, ip: null, ssid: null },
        'espcam-seeed': { connected: false, ip: null, ssid: null },
        'maker-esp32': { connected: false, ip: null, ssid: null, sensors: null }
      }
    });
  });

  test('GET /api/status - verified SSID (Dobby) with camera online', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.50', 'Dobby', 0); // Connected just now

    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      isHostSecure: true,
      hostSsid: 'Dobby',
      cameraConnected: true,
      cameraIp: '192.168.1.50',
      cameraSsid: 'Dobby',
      cameras: {
        esp32cam: { connected: true, ip: '192.168.1.50', ssid: 'Dobby' },
        'espcam-seeed': { connected: false, ip: null, ssid: null },
        'maker-esp32': { connected: false, ip: null, ssid: null, sensors: null }
      }
    });
  });


  test('GET /api/status - unverified SSID (HackNet)', async () => {
    setSSIDInfo('HackNet', false);
    setMockCamera('192.168.1.50', 'Pumpkinpie', 0);

    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.isHostSecure).toBe(false);
    expect(response.body.hostSsid).toBe('HackNet');
  });

  test('GET /api/stream - block stream on unverified SSID', async () => {
    setSSIDInfo('UnsecuredWiFi', false);
    setMockCamera('192.168.1.50', 'Dobby', 0);

    const response = await request(app).get('/api/stream');
    expect(response.status).toBe(403);
    expect(response.text).toBe('Not on verified safe network');
  });

  test('GET /api/stream - return 503 if camera is offline', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera(null, null, 10000);

    const response = await request(app).get('/api/stream');
    expect(response.status).toBe(503);
    expect(response.text).toBe('Camera disconnected');
  });

  test('GET /api/control - block control endpoint on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    setMockCamera('192.168.1.50', 'Pumpkinpie', 0);

    const response = await request(app).get('/api/control?var=flash&val=1');
    expect(response.status).toBe(403);
    expect(response.text).toBe('Not on verified safe network');
  });

  test('GET /api/control - check 400 parameter errors', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera('192.168.1.50', 'Pumpkinpie', 0);

    const response = await request(app).get('/api/control');
    expect(response.status).toBe(400);
    expect(response.text).toBe('Missing query parameters');
  });

  test('GET /api/status - multi-camera support verification', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera('192.168.1.50', 'Pumpkinpie', 0, 'esp32cam');
    setMockCamera('192.168.1.60', 'Pumpkinpie', 0, 'espcam-seeed');

    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.cameras).toBeDefined();
    expect(response.body.cameras.esp32cam.connected).toBe(true);
    expect(response.body.cameras.esp32cam.ip).toBe('192.168.1.50');
    expect(response.body.cameras['espcam-seeed'].connected).toBe(true);
    expect(response.body.cameras['espcam-seeed'].ip).toBe('192.168.1.60');
  });

  test('GET /api/stream - route targeting espcam-seeed', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera(null, null, 10000, 'espcam-seeed');

    const response = await request(app).get('/api/stream?device=espcam-seeed');
    expect(response.status).toBe(503);
    expect(response.text).toBe('Camera disconnected');
  });

  test('GET /api/control - target espcam-seeed with missing parameters', async () => {
    setSSIDInfo('Pumpkinpie', true);
    setMockCamera('192.168.1.60', 'Pumpkinpie', 0, 'espcam-seeed');

    const response = await request(app).get('/api/control?device=espcam-seeed');
    expect(response.status).toBe(400);
    expect(response.text).toBe('Missing query parameters');
  });

  test('GET /api/status - maker-esp32 telemetry reporting', async () => {
    setSSIDInfo('Pumpkinpie', true);
    const mockSensors = {
      voltage: 12.24,
      current: 145.2,
      power: 1777.2,
      temp: 31.4,
      accel: { x: 0.1, y: -0.2, z: 9.81 },
      gyro: { x: 1.2, y: -2.3, z: 0.5 },
      mag: { x: 30.0, y: 15.0, z: -45.0 }
    };
    setMockCamera('192.168.1.70', 'Pumpkinpie', 0, 'maker-esp32', mockSensors);

    const response = await request(app).get('/api/status');
    expect(response.status).toBe(200);
    expect(response.body.cameras['maker-esp32'].connected).toBe(true);
    expect(response.body.cameras['maker-esp32'].ip).toBe('192.168.1.70');
    expect(response.body.cameras['maker-esp32'].sensors).toEqual(mockSensors);
  });

  // New Drive & Calibration Endpoints Tests
  test('GET /api/drive - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/drive?x=1.0&y=0.0');
    expect(response.status).toBe(403);
  });

  test('GET /api/drive - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/drive?x=1.0&y=0.0');
    expect(response.status).toBe(503);
  });

  test('GET /api/drive - return 400 if parameters are missing', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.70', 'Dobby', 0, 'maker-esp32');
    const response = await request(app).get('/api/drive?x=1.0');
    expect(response.status).toBe(400);
  });

  test('GET /api/speed - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/speed?val=200');
    expect(response.status).toBe(403);
  });

  test('GET /api/speed - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/speed?val=200');
    expect(response.status).toBe(503);
  });

  test('GET /api/speed - return 400 if parameters are missing', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.70', 'Dobby', 0, 'maker-esp32');
    const response = await request(app).get('/api/speed');
    expect(response.status).toBe(400);
  });

  test('GET /api/set_pwm - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/set_pwm?motor=left&val=100');
    expect(response.status).toBe(403);
  });

  test('GET /api/set_pwm - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/set_pwm?motor=left&val=100');
    expect(response.status).toBe(503);
  });

  test('GET /api/set_pwm - return 400 if parameters are missing', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.70', 'Dobby', 0, 'maker-esp32');
    const response = await request(app).get('/api/set_pwm?val=100');
    expect(response.status).toBe(400);
  });

  test('GET /api/save - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/save?left=50&right=50');
    expect(response.status).toBe(403);
  });

  test('GET /api/save - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/save?left=50&right=50');
    expect(response.status).toBe(503);
  });

  test('GET /api/save - return 400 if parameters are missing', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.70', 'Dobby', 0, 'maker-esp32');
    const response = await request(app).get('/api/save?left=50');
    expect(response.status).toBe(400);
  });

  test('GET /api/stop - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/stop');
    expect(response.status).toBe(403);
  });

  test('GET /api/stop - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/stop');
    expect(response.status).toBe(503);
  });

  test('GET /api/test_motor - block on unverified network', async () => {
    setSSIDInfo('HackNet', false);
    const response = await request(app).get('/api/test_motor?motor=left&dir=forward&pwm=80&duration=500');
    expect(response.status).toBe(403);
  });

  test('GET /api/test_motor - return 503 if maker-esp32 is disconnected', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera(null, null, 10000, 'maker-esp32');
    const response = await request(app).get('/api/test_motor?motor=left&dir=forward&pwm=80&duration=500');
    expect(response.status).toBe(503);
  });

  test('GET /api/test_motor - return 400 if parameters are missing', async () => {
    setSSIDInfo('Dobby', true);
    setMockCamera('192.168.1.70', 'Dobby', 0, 'maker-esp32');
    const response = await request(app).get('/api/test_motor?motor=left');
    expect(response.status).toBe(400);
  });
});
