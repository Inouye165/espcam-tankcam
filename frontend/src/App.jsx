import React, { useState, useEffect, useRef } from 'react';

const getCompassDirection = (deg) => {
  if (deg === undefined || isNaN(deg)) return 'N/A';
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return directions[idx];
};

function App() {
  const [status, setStatus] = useState({
    isHostSecure: false,
    hostSsid: 'Checking...',
    cameras: {
      esp32cam: { connected: false, ip: null, ssid: null },
      'espcam-seeed': { connected: false, ip: null, ssid: null },
      'waveshare-esp32': { connected: false, ip: null, ssid: null, sensors: null }
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
    'espcam-seeed': false,
    'waveshare-esp32': false
  });
  const joystickRef = useRef(null);
  const [tankYaw, setTankYaw] = useState(0);
  const [boardYaw, setBoardYaw] = useState(0);
  const boardYawRef = useRef(0);
  const lastUpdateRef = useRef(Date.now());
  const [smoothedOrientation, setSmoothedOrientation] = useState({ pitch: 0, roll: 0, yaw: 0 });
  const smoothedRef = useRef({ pitch: 0, roll: 0, yaw: 0 });
  const [motionStats, setMotionStats] = useState({ speed: 0, distance: 0, dirAngle: 0, compassHeading: 0 });
  const localVelRef = useRef({ x: 0, y: 0 });
  const lastAccelRef = useRef({ x: 0, y: 0, z: 1000 });
  const distanceRef = useRef(0);
  const accelBiasRef = useRef(null);
  const compassHeadingRef = useRef(null);
  const rawHeadingRef = useRef(0);
  const calMinRef = useRef({ x: Infinity, y: Infinity });
  const calMaxRef = useRef({ x: -Infinity, y: -Infinity });

  const [calibrating, setCalibrating] = useState(false);
  const [calParams, setCalParams] = useState(() => {
    const saved = localStorage.getItem('waveshare_compass_cal');
    return saved ? JSON.parse(saved) : { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, headingOffset: 0 };
  });


  // Listen to Server-Sent Events (SSE) for real-time telemetry streaming and gyro yaw integration
  useEffect(() => {
    const eventSource = new EventSource('/api/telemetry-stream');

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const device = data.device;
        
        setStatus(prev => {
          const nextCameras = { ...prev.cameras };
          if (nextCameras[device]) {
            nextCameras[device] = {
              ...nextCameras[device],
              connected: true,
              ip: data.ip,
              ssid: data.ssid,
              sensors: data.sensors
            };
          }
          return {
            ...prev,
            cameras: nextCameras
          };
        });

        // Integrate Gyro Z angular velocity to track boardYaw in real-time
        if (device === 'waveshare-esp32' && data.sensors) {
          const accel = data.sensors.accel || { x: 0, y: 0, z: 9.8 };
          const mag = data.sensors.mag || { x: 0, y: 0, z: 0 };
          const pitchRad = Math.atan2(-accel.x, Math.sqrt(accel.y * accel.y + accel.z * accel.z));
          const rollRad = Math.atan2(accel.y, accel.z);
          const pitchRaw = (pitchRad * 180) / Math.PI;
          const rollRaw = (rollRad * 180) / Math.PI;

          const now = Date.now();
          const dt = (now - lastUpdateRef.current) / 1000;
          lastUpdateRef.current = now;

          // Calculate absolute tilt-compensated compass heading
          let compassHeading = 0;
          if (mag.x !== 0 || mag.y !== 0 || mag.z !== 0) {
            // If calibrating, capture raw values in ref
            if (calibrating) {
              if (mag.x < calMinRef.current.x) calMinRef.current.x = mag.x;
              if (mag.x > calMaxRef.current.x) calMaxRef.current.x = mag.x;
              if (mag.y < calMinRef.current.y) calMinRef.current.y = mag.y;
              if (mag.y > calMaxRef.current.y) calMaxRef.current.y = mag.y;
            }

            // Apply hard-iron offset and soft-iron scale factors
            const mx = (mag.x - calParams.offsetX) * calParams.scaleX;
            const my = (mag.y - calParams.offsetY) * calParams.scaleY;
            const mz = mag.z;

            const cosRoll = Math.cos(rollRad);
            const sinRoll = Math.sin(rollRad);
            const cosPitch = Math.cos(pitchRad);
            const sinPitch = Math.sin(pitchRad);

            // Project magnetic field vectors onto the horizontal plane
            const xh = mx * cosPitch + my * sinRoll * sinPitch + mz * cosRoll * sinPitch;
            const yh = my * cosRoll - mz * sinRoll;

            // Raw heading before relative zero offset is applied
            let rawHeading = Math.atan2(-yh, xh) * 180 / Math.PI;
            if (rawHeading < 0) {
              rawHeading += 360;
            }
            rawHeadingRef.current = rawHeading;

            // Apply heading zero offset (zeroing alignment)
            compassHeading = (rawHeading - calParams.headingOffset + 360) % 360;

            // Smooth compass readings with a wrap-around-aware low-pass filter to eliminate jitter
            if (compassHeadingRef.current === null) {
              compassHeadingRef.current = compassHeading;
            } else {
              let headingDiff = compassHeading - compassHeadingRef.current;
              if (headingDiff > 180) headingDiff -= 360;
              if (headingDiff < -180) headingDiff += 360;
              // 8% weight on new values for robust and smooth drift/jitter damping
              compassHeadingRef.current = (compassHeadingRef.current + headingDiff * 0.08 + 360) % 360;
            }
            compassHeading = compassHeadingRef.current;
          }

          let nextYaw = boardYawRef.current;
          if (data.sensors.gyro) {
            const gz = Number(data.sensors.gyro.z) || 0;
            // Apply a noise gate to ignore drift when stationary
            if (Math.abs(gz) > 1.5) {
              nextYaw = nextYaw - gz * dt;
            }
          }

          // Fuse compass heading using complementary filter to resolve gyro Z-axis drift
          if (mag.x !== 0 || mag.y !== 0 || mag.z !== 0) {
            let diff = compassHeading - nextYaw;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            nextYaw = nextYaw + diff * 0.08; // 8% pull towards absolute compass heading
          }
          nextYaw = (nextYaw + 360) % 360;
          boardYawRef.current = nextYaw;
          setBoardYaw(nextYaw);

          // Apply low-pass filter (exponential smoothing) to filter raw accelerometer/gyro/yaw jitter
          const alpha = 0.20; // 20% new value, 80% old value
          const smoothedPitch = alpha * pitchRaw + (1 - alpha) * smoothedRef.current.pitch;
          const smoothedRoll = alpha * rollRaw + (1 - alpha) * smoothedRef.current.roll;

          // Correctly handle yaw wrap-around (0 <=> 360 transition) to prevent spin-around glitch
          let diffYaw = nextYaw - smoothedRef.current.yaw;
          if (diffYaw > 180) diffYaw -= 360;
          if (diffYaw < -180) diffYaw += 360;
          const smoothedYaw = (smoothedRef.current.yaw + alpha * diffYaw + 360) % 360;

          smoothedRef.current = { pitch: smoothedPitch, roll: smoothedRoll, yaw: smoothedYaw };
          setSmoothedOrientation({ pitch: smoothedPitch, roll: smoothedRoll, yaw: smoothedYaw });

          // Estimate local velocity and distance from accelerometer using LPF gravity/bias tracking
          if (!accelBiasRef.current) {
            accelBiasRef.current = { x: accel.x, y: accel.y };
          } else {
            // Slow low-pass filter to track stationary/slowly changing gravity components (tilt)
            accelBiasRef.current.x = accelBiasRef.current.x * 0.98 + accel.x * 0.02;
            accelBiasRef.current.y = accelBiasRef.current.y * 0.98 + accel.y * 0.02;
          }

          // Subtract gravity/tilt offset to get dynamic linear acceleration in local frame
          const linAx = ((accel.x - accelBiasRef.current.x) / 1000) * 9.8;
          const linAy = ((accel.y - accelBiasRef.current.y) / 1000) * 9.8;

          // Save current raw accelerometer reading for reference/compat
          lastAccelRef.current = accel;

          // Noise gate to suppress drift from small vibrations/sensor noise
          const accelThreshold = 0.12; 
          let instAx = Math.abs(linAx) > accelThreshold ? linAx : 0;
          let instAy = Math.abs(linAy) > accelThreshold ? linAy : 0;

          // Integrate acceleration to estimate velocity vector (local coordinates)
          localVelRef.current.x += instAx * dt;
          localVelRef.current.y += instAy * dt;

          // Leaky integrator decay to pull velocity back to zero when movement stops
          localVelRef.current.x *= 0.95;
          localVelRef.current.y *= 0.95;

          const speed = Math.sqrt(localVelRef.current.x * localVelRef.current.x + localVelRef.current.y * localVelRef.current.y);

          // Integrate speed over time to track total estimated travel distance
          distanceRef.current += speed * dt;

          const dirAngle = Math.atan2(localVelRef.current.y, localVelRef.current.x) * 180 / Math.PI;

          setMotionStats({
            speed: speed,
            distance: distanceRef.current,
            dirAngle: dirAngle,
            compassHeading: compassHeading
          });
        }
      } catch (err) {
        console.error('Error parsing SSE telemetry payload:', err);
      }
    };

    // Update timestamp even if no packets are received, to keep dt accurate
    const tickInterval = setInterval(() => {
      lastUpdateRef.current = Date.now();
    }, 100);

    return () => {
      eventSource.close();
      clearInterval(tickInterval);
    };
  }, []);




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
            'espcam-seeed': { connected: false, ip: null, ssid: null },
            'waveshare-esp32': { connected: false, ip: null, ssid: null, sensors: null }
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

  // Update yaw state based on steering inputs (A/D keys or Joystick X displacement)
  useEffect(() => {
    const steeringInterval = setInterval(() => {
      let delta = 0;
      if (activeKeys.a) delta = -3;
      if (activeKeys.d) delta = 3;
      if (Math.abs(joystickPos.x) > 5) {
        delta = (joystickPos.x / 40) * 3;
      }
      if (delta !== 0) {
        setTankYaw(prev => (prev + delta + 360) % 360);
      }
    }, 30);
    return () => clearInterval(steeringInterval);
  }, [activeKeys, joystickPos]);


  const handleToggleCalibration = () => {
    if (calibrating) {
      // Save calibration
      if (calMaxRef.current.x > calMinRef.current.x && calMaxRef.current.y > calMinRef.current.y) {
        const offsetX = (calMaxRef.current.x + calMinRef.current.x) / 2;
        const offsetY = (calMaxRef.current.y + calMinRef.current.y) / 2;
        const rangeX = (calMaxRef.current.x - calMinRef.current.x) / 2;
        const rangeY = (calMaxRef.current.y - calMinRef.current.y) / 2;
        const avgRange = (rangeX + rangeY) / 2;
        const scaleX = rangeX > 0 ? avgRange / rangeX : 1;
        const scaleY = rangeY > 0 ? avgRange / rangeY : 1;

        const newParams = { ...calParams, offsetX, offsetY, scaleX, scaleY };
        setCalParams(newParams);
        localStorage.setItem('waveshare_compass_cal', JSON.stringify(newParams));
        console.log('Compass calibrated successfully:', newParams);
      }
      setCalibrating(false);
    } else {
      // Start calibration
      calMinRef.current = { x: Infinity, y: Infinity };
      calMaxRef.current = { x: -Infinity, y: -Infinity };
      setCalibrating(true);
    }
  };

  const handleZeroHeading = () => {
    if (rawHeadingRef.current !== null) {
      const newParams = { ...calParams, headingOffset: rawHeadingRef.current };
      setCalParams(newParams);
      localStorage.setItem('waveshare_compass_cal', JSON.stringify(newParams));
      console.log('Compass heading zeroed:', rawHeadingRef.current);
    }
  };

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
    
    const maxRadius = 30;
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
            const displayName =
              deviceName === 'esp32cam' ? 'ESP32-CAM (AI-Thinker)' :
              deviceName === 'espcam-seeed' ? 'espcam-seeed (XIAO)' :
              'Waveshare ESP32 General Driver';
            return (
              <div key={deviceName} className={`glass-panel feed-container ${deviceName === 'waveshare-esp32' ? 'waveshare-esp32-feed' : ''}`}>
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
                  ) : deviceName === 'waveshare-esp32' ? (
                    (() => {
                      const accel = cam.sensors?.accel || { x: 0, y: 0, z: 9.8 };
                      const pitchRad = Math.atan2(-accel.x, Math.sqrt(accel.y * accel.y + accel.z * accel.z));
                      const rollRad = Math.atan2(accel.y, accel.z);
                      const pitchDeg = Math.round((pitchRad * 180) / Math.PI);
                      const rollDeg = Math.round((rollRad * 180) / Math.PI);

                      // Determine current active movement direction and speed (hybrid commanded + raw IMU)
                      let arrowDirAngle = motionStats.dirAngle;
                      let arrowSpeed = motionStats.speed;
                      let isMoving = arrowSpeed > 0.05;

                      if (activeKeys.w || activeKeys.s || activeKeys.a || activeKeys.d) {
                        let dx = 0;
                        let dy = 0;
                        if (activeKeys.w) dy = 1;
                        if (activeKeys.s) dy = -1;
                        if (activeKeys.a) dx = -1;
                        if (activeKeys.d) dx = 1;
                        arrowDirAngle = Math.atan2(dy, dx) * 180 / Math.PI;
                        isMoving = true;
                        if (arrowSpeed < 0.1) arrowSpeed = 0.25;
                      } else if (Math.abs(joystickPos.x) > 2 || Math.abs(joystickPos.y) > 2) {
                        arrowDirAngle = Math.atan2(-joystickPos.y, joystickPos.x) * 180 / Math.PI;
                        isMoving = true;
                        if (arrowSpeed < 0.1) arrowSpeed = 0.25;
                      }

                      return (
                        <div className="waveshare-telemetry-container">
                          {/* Left: 3D Visualizer Viewport */}
                          <div className="tank-3d-viewport">
                            {/* Circular Compass Dial on the Border */}
                            <div className={`compass-dial-border ${calibrating ? 'calibrating' : ''}`}>
                              <span className="cardinal-label n">N</span>
                              <span className="cardinal-label e">E</span>
                              <span className="cardinal-label s">S</span>
                              <span className="cardinal-label w">W</span>
                              
                              {/* 30-degree Tickers */}
                              {[30, 60, 120, 150, 210, 240, 300, 330].map(deg => (
                                <div 
                                  key={deg} 
                                  className="compass-ticker" 
                                  style={{ transform: `rotate(${deg}deg)` }}
                                />
                              ))}

                              {/* Active Red Heading Pointer on the Border */}
                              <div 
                                className="compass-pointer-container"
                                style={{ transform: `rotate(${motionStats.compassHeading || 0}deg)` }}
                              >
                                <div className="compass-pointer-red" />
                              </div>
                            </div>

                            <div 
                              className="tank-3d-scene"
                              style={{
                                transform: `rotateX(${60 - smoothedOrientation.pitch}deg) rotateY(${smoothedOrientation.roll}deg) rotateZ(${tankYaw + smoothedOrientation.yaw}deg)`
                              }}
                            >
                              {/* Chassis */}
                              <div className="tank-chassis">
                                <div className="face front">FRONT</div>
                                <div className="face back">BACK</div>
                                <div className="face left" />
                                <div className="face right" />
                                <div className="face top" />
                                <div className="face bottom" />
                              </div>
                              {/* Track Left */}
                              <div className="tank-track left-track">
                                <div className="face front" />
                                <div className="face back" />
                                <div className="face left" />
                                <div className="face right" />
                                <div className="face top" />
                                <div className="face bottom" />
                              </div>
                              {/* Track Right */}
                              <div className="tank-track right-track">
                                <div className="face front" />
                                <div className="face back" />
                                <div className="face left" />
                                <div className="face right" />
                                <div className="face top" />
                                <div className="face bottom" />
                              </div>
                              {/* Turret */}
                              <div className="tank-turret">
                                <div className="face front" />
                                <div className="face back" />
                                <div className="face left" />
                                <div className="face right" />
                                <div className="face top" />
                                <div className="face bottom" />
                                {/* Barrel */}
                                <div className="tank-barrel" />
                              </div>

                              {/* Facing Direction Arrow (Red) */}
                              <div 
                                className="tank-facing-arrow"
                                style={{
                                  transform: `translateZ(-14px) rotateZ(0deg) scale(0.9)`
                                }}
                              />

                              {/* Glowing 3D Vector Direction Arrow */}
                              {isMoving && (
                                <div 
                                  className="tank-direction-arrow"
                                  style={{
                                    transform: `translateZ(-14px) rotateZ(${90 - arrowDirAngle}deg) scale(${Math.min(1.5, 0.6 + arrowSpeed * 2.5)})`,
                                    opacity: Math.min(1, 0.4 + arrowSpeed * 3)
                                  }}
                                />
                              )}
                            </div>
                          </div>
                          
                          {/* Right: Numerical Metrics */}
                          <div className="waveshare-telemetry">
                            <div className="telemetry-header">SYSTEM SENSORS</div>
                            <div className="telemetry-readout-grid">
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">VOLTAGE</div>
                                <div className="telemetry-value primary">{cam.sensors?.voltage !== undefined ? `${Number(cam.sensors.voltage).toFixed(2)} V` : '0.00 V'}</div>
                              </div>
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">CURRENT</div>
                                <div className="telemetry-value accent">{cam.sensors?.current !== undefined ? `${Number(cam.sensors.current).toFixed(1)} mA` : '0.0 mA'}</div>
                              </div>
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">POWER</div>
                                <div className="telemetry-value warning">{cam.sensors?.power !== undefined ? `${Number(cam.sensors.power).toFixed(1)} mW` : '0.0 mW'}</div>
                              </div>
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">CORE TEMP</div>
                                <div className="telemetry-value success">{cam.sensors?.temp !== undefined ? `${Number(cam.sensors.temp).toFixed(1)} °C` : '0.0 °C'}</div>
                              </div>
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">EST. SPEED</div>
                                <div className="telemetry-value primary">{`${motionStats.speed.toFixed(2)} m/s`}</div>
                              </div>
                              <div className="telemetry-readout-box">
                                <div className="telemetry-label">EST. DISTANCE</div>
                                <div className="telemetry-value accent">{`${motionStats.distance.toFixed(2)} m`}</div>
                              </div>
                              <div className="telemetry-readout-box" style={{ gridColumn: 'span 2' }}>
                                <div className="telemetry-label">COMPASS HEADING</div>
                                <div className="telemetry-value warning">
                                  {motionStats.compassHeading !== undefined ? (
                                    `${Math.round(motionStats.compassHeading)}° (${getCompassDirection(motionStats.compassHeading)})`
                                  ) : (
                                    'N/A'
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="telemetry-status-message" style={{ display: 'flex', justifyContent: 'space-between', padding: '0 5px' }}>
                              <span>P: {pitchDeg}° | R: {rollDeg}°</span>
                              <span>Y: {Math.round(tankYaw)}°</span>
                            </div>
                          </div>
                        </div>
                      );
                    })()
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

                {deviceName !== 'waveshare-esp32' && (
                  <div className="feed-controls">
                    <button
                      onClick={() => toggleFlash(deviceName)}
                      disabled={!cam.connected || !status.isHostSecure}
                      className={`flash-btn ${flashStates[deviceName] ? 'active' : 'inactive'}`}
                    >
                      🔦 Flash Light: {flashStates[deviceName] ? 'ON' : 'OFF'}
                    </button>
                  </div>
                )}
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
                <span className="stat-lbl">waveshare Link</span>
                <span className={`stat-val ${status.cameras?.['waveshare-esp32']?.connected ? 'success' : 'warning'}`}>
                  {status.cameras?.['waveshare-esp32']?.connected ? 'Connected' : 'Offline'}
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
              <div className="stat-box" style={{ gridColumn: 'span 2' }}>
                <span className="stat-lbl">waveshare IP</span>
                <span className="stat-val active" style={{ fontSize: '0.8rem' }}>
                  {status.cameras?.['waveshare-esp32']?.connected ? status.cameras['waveshare-esp32'].ip : 'N/A'}
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

          {/* Compass Calibration Panel */}
          <div className="panel-section" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 className="section-title">Compass & Orientation</h3>
            <div className="calibration-instructions">
              <strong>Rotating Calibration:</strong> Click Calibrate below and rotate the tank 360° horizontally on a flat surface, then click Save.
            </div>
            <div className="compass-calibration-controls">
              <button 
                className={`hud-btn ${calibrating ? 'active pulse' : ''}`}
                onClick={handleToggleCalibration}
              >
                🔄 {calibrating ? 'SAVE CALIBRATION' : 'START CALIBRATION'}
              </button>
              <button 
                className="hud-btn warning"
                onClick={handleZeroHeading}
              >
                🎯 ZERO HEADING
              </button>
            </div>
            
            <div className="calibration-stats-grid">
              <div className="cal-stat-item" style={{ gridColumn: 'span 2', borderBottom: '1px solid rgba(0, 242, 254, 0.15)', paddingBottom: '4px', marginBottom: '4px', fontWeight: 'bold' }}>
                ACTIVE CALIBRATION OFFSETS
              </div>
              <div className="cal-stat-item">
                <span>Offset X:</span>
                <span className="cal-stat-val">{calParams.offsetX.toFixed(1)}</span>
              </div>
              <div className="cal-stat-item">
                <span>Offset Y:</span>
                <span className="cal-stat-val">{calParams.offsetY.toFixed(1)}</span>
              </div>
              <div className="cal-stat-item">
                <span>Scale X:</span>
                <span className="cal-stat-val">{calParams.scaleX.toFixed(2)}</span>
              </div>
              <div className="cal-stat-item">
                <span>Scale Y:</span>
                <span className="cal-stat-val">{calParams.scaleY.toFixed(2)}</span>
              </div>
              <div className="cal-stat-item" style={{ gridColumn: 'span 2', marginTop: '4px', borderTop: '1px dashed rgba(255, 255, 255, 0.1)', paddingTop: '4px' }}>
                <span>Heading Zero Offset:</span>
                <span className="cal-stat-val">{calParams.headingOffset.toFixed(1)}°</span>
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
