import React, { useState, useEffect, useRef } from 'react';

function App() {
  const [status, setStatus] = useState({
    isHostSecure: false,
    hostSsid: 'Checking...',
    cameras: {
      esp32cam: { connected: false, ip: null, ssid: null },
      'espcam-seeed': { connected: false, ip: null, ssid: null }
    }
  });

  const [activeKeys, setActiveKeys] = useState({
    w: false,
    a: false,
    s: false,
    d: false
  });

  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [systemTime, setSystemTime] = useState(new Date().toLocaleTimeString());
  const [flashStates, setFlashStates] = useState({
    esp32cam: false,
    'espcam-seeed': false
  });
  const joystickRef = useRef(null);

  // Poll server status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          const data = await res.json();
          setStatus(data);
          // Auto reset flash states if a camera disconnects
          setFlashStates(prev => {
            const next = { ...prev };
            Object.keys(data.cameras || {}).forEach(name => {
              if (!data.cameras[name].connected) {
                next[name] = false;
              }
            });
            return next;
          });
        } else {
          setStatus(prev => ({ ...prev, isHostSecure: false, hostSsid: 'Unverified' }));
        }
      } catch (err) {
        console.error('Failed to fetch status:', err);
        setStatus(prev => ({
          ...prev,
          isHostSecure: false,
          hostSsid: 'Server Offline',
          cameras: {
            esp32cam: { connected: false, ip: null, ssid: null },
            'espcam-seeed': { connected: false, ip: null, ssid: null }
          }
        }));
      }
    };

    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 2000);
    return () => clearInterval(statusInterval);
  }, []);

  // Update clock
  useEffect(() => {
    const clockInterval = setInterval(() => {
      setSystemTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  // Keyboard Event Listeners for WASD Visualizer
  useEffect(() => {
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(key)) {
        setActiveKeys(prev => ({ ...prev, [key]: true }));
      }
    };

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(key)) {
        setActiveKeys(prev => ({ ...prev, [key]: false }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Interactive Joystick Handling
  const handlePointerDown = (e) => {
    setIsDragging(true);
    e.target.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!isDragging || !joystickRef.current) return;
    
    const rect = joystickRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    let dx = e.clientX - rect.left - centerX;
    let dy = e.clientY - rect.top - centerY;
    
    const maxRadius = 40;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance > maxRadius) {
      dx = (dx / distance) * maxRadius;
      dy = (dy / distance) * maxRadius;
    }
    
    setJoystickPos({ x: dx, y: dy });
  };

  const handlePointerUp = () => {
    setIsDragging(false);
    setJoystickPos({ x: 0, y: 0 });
  };

  // Toggle Camera Flash LED
  const toggleFlash = async (deviceName) => {
    const cam = status.cameras?.[deviceName];
    if (!cam || !cam.connected || !status.isHostSecure) return;
    
    const nextState = !flashStates[deviceName];
    try {
      const res = await fetch(`/api/control?device=${deviceName}&var=flash&val=${nextState ? 1 : 0}`);
      if (res.ok) {
        setFlashStates(prev => ({ ...prev, [deviceName]: nextState }));
      } else {
        console.error(`Failed to toggle camera flash for ${deviceName}`);
      }
    } catch (err) {
      console.error(`Error toggling flash for ${deviceName}:`, err);
    }
  };

  return (
    <>
      <header>
        <div className="logo-container">
          <span className="logo-icon">🤖</span>
          <div>
            <h1>ESPCam Tank Console</h1>
          </div>
        </div>
        <div className="sys-info">
          <div className="info-tag">TIME: {systemTime}</div>
          <div className={`info-tag ${status.isHostSecure ? 'stat-val success' : 'stat-val danger'}`}>
            NET: {status.isHostSecure ? 'VERIFIED' : 'UNSECURE'}
          </div>
        </div>
      </header>

      <main className="dashboard">
        {/* Left Video Stream Area (Multi-feed Grid) */}
        <section className="feeds-grid">
          {Object.entries(status.cameras || {}).map(([deviceName, cam]) => {
            const displayName = deviceName === 'esp32cam' ? 'ESP32-CAM (AI-Thinker)' : 'espcam-seeed (XIAO)';
            return (
              <div key={deviceName} className="glass-panel feed-container">
                <div className="feed-header">
                  <div className="feed-title">
                    {cam.connected && status.isHostSecure && <span className="feed-title-dot" />}
                    <span>{displayName}</span>
                  </div>
                  {cam.connected && status.isHostSecure && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-primary)' }}>
                      IP: {cam.ip} | {cam.ssid}
                    </div>
                  )}
                </div>

                <div className="feed-body">
                  {!status.isHostSecure ? (
                    <div className="warning-screen">
                      <div className="warning-icon">⚠</div>
                      <h2 className="warning-title">Not on verified safe network</h2>
                      <p className="warning-desc">
                        Connection blocked. Current network SSID <strong style={{color: 'var(--color-warning)'}}>'{status.hostSsid}'</strong> is unverified.
                        The system will only operate when connected to Pumpkinpie or Dobby.
                      </p>
                    </div>
                  ) : !cam.connected ? (
                    <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
                      <div className="warning-icon" style={{ color: 'var(--color-accent)', animation: 'pulse 1.5s infinite' }}>📡</div>
                      <div style={{ textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' }}>Waiting for {deviceName}...</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '5px' }}>
                        Make sure the device is powered, connected to Pumpkinpie or Dobby, and sending UDP beacons.
                      </div>
                    </div>
                  ) : (
                    <img
                      src={`/api/stream?device=${deviceName}`}
                      alt={`${displayName} Live Feed`}
                      className="mjpeg-stream"
                      onError={(e) => {
                        console.error(`MJPEG Stream error loading for ${deviceName}`);
                      }}
                    />
                  )}
                </div>

                <div className="feed-controls">
                  <button
                    onClick={() => toggleFlash(deviceName)}
                    disabled={!cam.connected || !status.isHostSecure}
                    className={`flash-btn ${flashStates[deviceName] ? 'active' : 'inactive'}`}
                  >
                    🔦 Flash Light: {flashStates[deviceName] ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        {/* Right Dashboard Panels */}
        <aside className="glass-panel">
          {/* Telemetry Status */}
          <div className="panel-section">
            <h3 className="section-title">Telemetry & System</h3>
            <div className="telemetry-grid">
              <div className="stat-box">
                <span className="stat-lbl">Host Net Check</span>
                <span className={`stat-val ${status.isHostSecure ? 'success' : 'danger'}`}>
                  {status.isHostSecure ? 'Secure' : 'Unverified'}
                </span>
              </div>
              <div className="stat-box">
                <span className="stat-lbl">Host Wi-Fi SSID</span>
                <span className="stat-val" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {status.hostSsid}
                </span>
              </div>
              <div className="stat-box">
                <span className="stat-lbl">esp32cam Link</span>
                <span className={`stat-val ${status.cameras?.esp32cam?.connected ? 'success' : 'warning'}`}>
                  {status.cameras?.esp32cam?.connected ? 'Connected' : 'Offline'}
                </span>
              </div>
              <div className="stat-box">
                <span className="stat-lbl">seeed Link</span>
                <span className={`stat-val ${status.cameras?.['espcam-seeed']?.connected ? 'success' : 'warning'}`}>
                  {status.cameras?.['espcam-seeed']?.connected ? 'Connected' : 'Offline'}
                </span>
              </div>
              <div className="stat-box" style={{ gridColumn: 'span 2' }}>
                <span className="stat-lbl">esp32cam IP</span>
                <span className="stat-val active" style={{ fontSize: '0.8rem' }}>
                  {status.cameras?.esp32cam?.connected ? status.cameras.esp32cam.ip : 'N/A'}
                </span>
              </div>
              <div className="stat-box" style={{ gridColumn: 'span 2' }}>
                <span className="stat-lbl">espcam-seeed IP</span>
                <span className="stat-val active" style={{ fontSize: '0.8rem' }}>
                  {status.cameras?.['espcam-seeed']?.connected ? status.cameras['espcam-seeed'].ip : 'N/A'}
                </span>
              </div>
            </div>
          </div>

          {/* Driving HUD controls */}
          <div className="panel-section" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 className="section-title">Drive Controller HUD</h3>
            <div className="controls-layout">
              {/* Keyboard WASD Indicators */}
              <div style={{ textAlign: 'center' }}>
                <span className="stat-lbl" style={{ marginBottom: '5px', display: 'block' }}>Keyboard Inputs</span>
                <div className="wasd-keys">
                  <div className={`key w-key ${activeKeys.w ? 'active' : ''}`}>W</div>
                  <div className={`key ${activeKeys.a ? 'active' : ''}`}>A</div>
                  <div className={`key ${activeKeys.s ? 'active' : ''}`}>S</div>
                  <div className={`key ${activeKeys.d ? 'active' : ''}`}>D</div>
                </div>
              </div>

              {/* Joystick simulation */}
              <div style={{ textAlign: 'center', marginTop: '10px' }}>
                <span className="stat-lbl" style={{ marginBottom: '10px', display: 'block' }}>Analog Joystick</span>
                <div className="joystick-area" ref={joystickRef}>
                  <div
                    className="joystick-pad"
                    style={{
                      transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)`,
                      transition: isDragging ? 'none' : 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  />
                </div>
                {isDragging && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '10px', color: 'var(--color-primary)' }}>
                    X: {Math.round(joystickPos.x)} | Y: {Math.round(-joystickPos.y)}
                  </div>
                )}
              </div>


            </div>
          </div>
        </aside>
      </main>

      <footer>
        🤖 ESP32-CAM Robot Tank control terminal v1.0.0 | Secured by Network Signature Verification
      </footer>
    </>
  );
}

export default App;
