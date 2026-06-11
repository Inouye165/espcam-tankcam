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
      cameraSsid: null
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
      cameraSsid: 'Dobby'
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
});
