import React, { useState, useEffect, useRef } from 'react';

function App() {
  // Connections status state
  const [status, setStatus] = useState({
    isHostSecure: false,
    hostSsid: 'Checking...',
    cameras: {
      esp32cam: { connected: false, ip: null, ssid: null },
      'maker-esp32': { connected: false, ip: null, ssid: null, sensors: null }
    }
  });

  // Driving keys state
  const [activeKeys, setActiveKeys] = useState({ w: false, a: false, s: false, d: false });
  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [systemTime, setSystemTime] = useState(new Date().toLocaleTimeString());
  const joystickRef = useRef(null);

  // Safety test verification checklist
  const [isVerified, setIsVerified] = useState(() => {
    return localStorage.getItem('maker_tank_verified') === 'true';
  });
  const [testChecklist, setTestChecklist] = useState({
    leftFwd: false,
    leftRev: false,
    rightFwd: false,
    rightRev: false
  });
  
  // LED Studio State
  const [selectedLed, setSelectedLed] = useState(-1); // -1 = All, 0-3 = specific LED
  const [pickerColor, setPickerColor] = useState('#4facfe');

  // Interactive/Test speed limit caps
  const [speedLimit, setSpeedLimit] = useState(() => {
    const verified = localStorage.getItem('maker_tank_verified') === 'true';
    return verified ? 191 : 80;
  });
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [activeStatusMessage, setActiveStatusMessage] = useState('Cockpit Ready.');
  const [statusColorClass, setStatusColorClass] = useState('');
  const [gamepadActive, setGamepadActive] = useState(false);

  const gamepadIndexRef = useRef(null);
  const lastSentXRef = useRef(0);
  const lastSentYRef = useRef(0);
  const lastSendTimeRef = useRef(0);
  const statusRef = useRef(status);
  const testTimeoutRef = useRef(null);
  const activeKeysRef = useRef({ w: false, a: false, s: false, d: false });
  const lastJoystickPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Clean stop command
  const sendStopCommand = () => {
    setActiveKeys({ w: false, a: false, s: false, d: false });
    setJoystickPos({ x: 0, y: 0 });
    lastSentXRef.current = 0;
    lastSentYRef.current = 0;

    if (testTimeoutRef.current) {
      clearTimeout(testTimeoutRef.current);
      testTimeoutRef.current = null;
    }
    setIsTestRunning(false);

    fetch('/api/stop').catch(err => {
      console.error('Failed to send stop command:', err);
    });
  };

  // Safe timed motor test runner
  const runMotorTest = async (motor, dir) => {
    if (isTestRunning) return;
    setIsTestRunning(true);
    setActiveStatusMessage(`Running Motor Test: ${motor.toUpperCase()} ${dir}...`);
    setStatusColorClass('stat-val warning');

    try {
      await fetch('/api/stop').catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger test at low safe speed (PWM = 80, Duration = 500ms)
      const res = await fetch(`/api/test_motor?motor=${motor}&dir=${dir}&pwm=80&duration=500`);
      if (!res.ok) {
        throw new Error("Failed to start motor test");
      }

      testTimeoutRef.current = setTimeout(async () => {
        try {
          await fetch('/api/stop').catch(() => {});
          setActiveStatusMessage(`Test complete for ${motor.toUpperCase()} ${dir}.`);
          setStatusColorClass('stat-val success');
        } finally {
          setIsTestRunning(false);
        }
      }, 600);

    } catch (err) {
      console.error("Motor test error:", err);
      await fetch('/api/stop').catch(() => {});
      setActiveStatusMessage("Error: Motor test failed!");
      setStatusColorClass('stat-val danger');
      setIsTestRunning(false);
    }
  };

  // Perform emergency stop
  const handleEmergencyStop = () => {
    sendStopCommand();
    setActiveStatusMessage('EMERGENCY STOP TRIGGERED.');
    setStatusColorClass('stat-val danger');
  };

  // Document blur safety checks
  useEffect(() => {
    const handleBlurOrHide = () => {
      sendStopCommand();
    };

    const handleBeforeUnload = () => {
      fetch('/api/stop', { keepalive: true }).catch(() => {});
    };

    window.addEventListener('blur', handleBlurOrHide);
    document.addEventListener('visibilitychange', handleBlurOrHide);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('blur', handleBlurOrHide);
      document.removeEventListener('visibilitychange', handleBlurOrHide);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Connection watchdog stop
  const prevConnectedRef = useRef(false);
  const prevSecureRef = useRef(false);
  useEffect(() => {
    const makerCam = status.cameras?.['maker-esp32'];
    const currentConnected = !!makerCam?.connected;
    const currentSecure = !!status.isHostSecure;

    if (prevConnectedRef.current && !currentConnected) {
      console.warn("Connection to ESP Maker Board lost! Enforcing safety stop.");
      sendStopCommand();
    } else if (prevSecureRef.current && !currentSecure) {
      console.warn("Network security signatures lost! Enforcing safety stop.");
      sendStopCommand();
    }

    prevConnectedRef.current = currentConnected;
    prevSecureRef.current = currentSecure;
  }, [status]);

  // Server Sent Events (SSE) telemetry receiver
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
          return { ...prev, cameras: nextCameras };
        });
      } catch (err) {
        console.error('Error parsing SSE telemetry payload:', err);
      }
    };

    return () => {
      eventSource.close();
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
            'maker-esp32': { connected: false, ip: null, ssid: null, sensors: null }
          }
        }));
      }
    };

    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 2000);
    return () => clearInterval(statusInterval);
  }, []);

  // Clock tick
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
        setActiveKeys(prev => {
          const next = { ...prev, [key]: true };
          activeKeysRef.current = next;
          return next;
        });
      }
    };

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(key)) {
        setActiveKeys(prev => {
          const next = { ...prev, [key]: false };
          activeKeysRef.current = next;
          return next;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Gamepad Event Listeners & Detectors
  useEffect(() => {
    const handleGamepadConnected = (e) => {
      console.log(`Gamepad connected at index ${e.gamepad.index}: ${e.gamepad.id}`);
      gamepadIndexRef.current = e.gamepad.index;
      setGamepadActive(true);
      setActiveStatusMessage(`Xbox Controller connected: ${e.gamepad.id}`);
      setStatusColorClass("stat-val success");
    };

    const handleGamepadDisconnected = (e) => {
      if (gamepadIndexRef.current === e.gamepad.index) {
        console.log("Gamepad disconnected");
        gamepadIndexRef.current = null;
        setGamepadActive(false);
        sendStopCommand();
        setActiveStatusMessage("Xbox Controller disconnected.");
        setStatusColorClass("stat-val warning");
      }
    };

    window.addEventListener("gamepadconnected", handleGamepadConnected);
    window.addEventListener("gamepaddisconnected", handleGamepadDisconnected);

    // Initial check for already connected gamepads
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        gamepadIndexRef.current = i;
        setGamepadActive(true);
        setActiveStatusMessage(`Xbox Controller detected: ${gamepads[i].id}`);
        setStatusColorClass("stat-val success");
        break;
      }
    }

    return () => {
      window.removeEventListener("gamepadconnected", handleGamepadConnected);
      window.removeEventListener("gamepaddisconnected", handleGamepadDisconnected);
    };
  }, []);

  // Unified driving & joystick animation/polling loop
  useEffect(() => {
    let animationFrameId;

    const updateDrive = () => {
      // Priority 1: User dragging the UI virtual joystick
      if (isDragging) {
        const x = joystickPos.x / 30;
        const y = -joystickPos.y / 30;
        sendDriveCommand(x, y);
      }
      // Priority 2: Xbox Gamepad input
      else if (gamepadIndexRef.current !== null) {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[gamepadIndexRef.current];
        if (gp) {
          let x = gp.axes[0];
          let y = -gp.axes[1]; // Negate Y so up is positive

          // Apply deadzone
          const deadzone = 0.15;
          if (Math.abs(x) < deadzone) x = 0;
          else x = (x - Math.sign(x) * deadzone) / (1 - deadzone);

          if (Math.abs(y) < deadzone) y = 0;
          else y = (y - Math.sign(y) * deadzone) / (1 - deadzone);

          if (x !== 0 || y !== 0) {
            sendDriveCommand(x, y);
            updateJoystickPosState(x * 30, -y * 30);
          } else {
            // Gamepad is idle, fallback to keyboard
            pollKeyboardInput();
          }
        } else {
          pollKeyboardInput();
        }
      }
      // Priority 3: Keyboard input (WASD)
      else {
        pollKeyboardInput();
      }

      animationFrameId = requestAnimationFrame(updateDrive);
    };

    const pollKeyboardInput = () => {
      let y = 0;
      let x = 0;
      if (activeKeysRef.current.w) y = 1.0;
      else if (activeKeysRef.current.s) y = -1.0;
      if (activeKeysRef.current.a) x = -1.0;
      else if (activeKeysRef.current.d) x = 1.0;

      sendDriveCommand(x, y);
      updateJoystickPosState(x * 30, -y * 30);
    };

    const updateJoystickPosState = (newX, newY) => {
      if (Math.abs(newX - lastJoystickPosRef.current.x) > 0.1 || Math.abs(newY - lastJoystickPosRef.current.y) > 0.1) {
        lastJoystickPosRef.current = { x: newX, y: newY };
        setJoystickPos({ x: newX, y: newY });
      }
    };

    animationFrameId = requestAnimationFrame(updateDrive);
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isDragging, joystickPos]);

  // Pointer joystick controls
  const handlePointerDown = (e) => {
    if (!isVerified) return;
    setIsDragging(true);
    e.target.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (!isDragging || !joystickRef.current || !isVerified) return;
    
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

  // Drive sender proxy
  const sendDriveCommand = (x, y) => {
    const isStop = x === 0 && y === 0;

    // Safety Lockout: Ignore active drive commands if not verified
    if (!isVerified && !isStop) return;
    if (isTestRunning && !isStop) return;
    if (document.hidden && !isStop) return;

    const cam = statusRef.current.cameras?.['maker-esp32'];
    if (!isStop && (!statusRef.current.isHostSecure || !cam?.connected)) return;

    const now = Date.now();
    const wasStop = lastSentXRef.current === 0 && lastSentYRef.current === 0;
    const hasMovedSignificantly = Math.abs(x - lastSentXRef.current) > 0.02 || Math.abs(y - lastSentYRef.current) > 0.02;
    const needsHeartbeat = !isStop && (now - lastSendTimeRef.current > 350);

    if (
      (now - lastSendTimeRef.current > 50 && hasMovedSignificantly) ||
      (isStop && !wasStop) ||
      needsHeartbeat
    ) {
      lastSentXRef.current = x;
      lastSentYRef.current = y;
      lastSendTimeRef.current = now;
      
      if (isStop) {
        fetch('/api/stop').catch(() => {});
      } else {
        fetch(`/api/drive?x=${x.toFixed(2)}&y=${y.toFixed(2)}`).catch(() => {});
      }
    }
  };

  // Speed Limit slider updates
  const handleSpeedLimitChange = async (e) => {
    const val = parseInt(e.target.value);
    // Enforce safety cap if unverified
    const cappedVal = !isVerified ? Math.min(80, val) : val;
    setSpeedLimit(cappedVal);
    try {
      await fetch(`/api/speed?val=${cappedVal}`);
    } catch (err) {
      console.error('Failed to update speed limit:', err);
    }
  };

  // LED Studio trigger
  const applyLedColor = async (colorHex) => {
    const cam = status.cameras?.['maker-esp32'];
    if (!cam || !cam.connected || !status.isHostSecure) {
      setActiveStatusMessage("Error: ESP Maker Board disconnected!");
      setStatusColorClass("stat-val danger");
      return;
    }
    
    try {
      const cleanHex = colorHex.replace('#', '');
      let endpoint = `/api/led?hex=${cleanHex}`;
      if (selectedLed !== -1) {
        endpoint += `&index=${selectedLed}`;
      }
      const res = await fetch(endpoint);
      if (res.ok) {
        setActiveStatusMessage(selectedLed === -1 ? `All LEDs set to #${cleanHex}` : `LED ${selectedLed} set to #${cleanHex}`);
        setStatusColorClass("stat-val success");
      }
    } catch (err) {
      console.error('LED control error:', err);
    }
  };

  const handleCheckboxChange = (key, val) => {
    setTestChecklist(prev => {
      const updated = { ...prev, [key]: val };
      return updated;
    });
  };

  const verifySafetyConfirm = () => {
    if (testChecklist.leftFwd && testChecklist.leftRev && testChecklist.rightFwd && testChecklist.rightRev) {
      setIsVerified(true);
      localStorage.setItem('maker_tank_verified', 'true');
      setSpeedLimit(191);
      fetch(`/api/speed?val=191`).catch(() => {});
      setActiveStatusMessage("Verification complete! System unlocked.");
      setStatusColorClass("stat-val success");
    } else {
      alert("Please execute and pass all 4 directional tests before unlocking normal driving.");
    }
  };

  const resetSafetyVerification = () => {
    setIsVerified(false);
    localStorage.removeItem('maker_tank_verified');
    setTestChecklist({
      leftFwd: false,
      leftRev: false,
      rightFwd: false,
      rightRev: false
    });
    setSpeedLimit(80);
    fetch(`/api/speed?val=80`).catch(() => {});
    setActiveStatusMessage("Safety verification reset. Main controls locked.");
    setStatusColorClass("stat-val warning");
  };

  // Extract variables
  const makerCam = status.cameras?.['maker-esp32'];
  const motorSpeeds = makerCam?.sensors?.motors || [0, 0, 0, 0];
  const ledColors = makerCam?.sensors?.leds || [
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 }
  ];

  return (
    <>
      <header>
        <div className="logo-container">
          <span className="logo-icon">🤖</span>
          <div>
            <h1>Maker-ESP32 Cockpit Console</h1>
          </div>
        </div>
        <div className="sys-info">
          <div className="info-tag">TIME: {systemTime}</div>
          <div className={`info-tag ${status.isHostSecure ? 'stat-val success' : 'stat-val danger'}`}>
            NET: {status.isHostSecure ? 'VERIFIED' : 'UNSECURE'}
          </div>
          <div className={`info-tag ${isVerified ? 'stat-val success' : 'stat-val warning'}`}>
            SAFETY: {isVerified ? 'VERIFIED & UNLOCKED' : 'LOCKED'}
          </div>
        </div>
      </header>

      <main className="dashboard">
        {/* Main Console feeds */}
        <section className="feeds-grid" style={{ gridTemplateRows: '1fr 1fr' }}>
          {/* Top-Left: Camera Feed */}
          <div className="glass-panel feed-container">
            <div className="feed-header">
              <div className="feed-title">
                {status.cameras?.esp32cam?.connected && status.isHostSecure && <span className="feed-title-dot" />}
                <span>ESP32-CAM (AI-Thinker Stream)</span>
              </div>
              {status.cameras?.esp32cam?.connected && status.isHostSecure && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-primary)' }}>
                  IP: {status.cameras.esp32cam.ip}
                </div>
              )}
            </div>
            <div className="feed-body">
              {!status.isHostSecure ? (
                <div className="warning-screen">
                  <div className="warning-icon">⚠</div>
                  <h2 className="warning-title">Not on verified safe network</h2>
                  <p className="warning-desc">
                    Stream blocked. Host network SSID <strong style={{color: 'var(--color-warning)'}}>'{status.hostSsid}'</strong> is unverified.
                  </p>
                </div>
              ) : !status.cameras?.esp32cam?.connected ? (
                <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
                  <div className="warning-icon" style={{ color: 'var(--color-accent)', animation: 'pulse 1.5s infinite' }}>📡</div>
                  <div style={{ textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' }}>Waiting for Camera Connection...</div>
                </div>
              ) : (
                <img
                  src={`/api/stream?device=esp32cam`}
                  alt="ESP32-CAM Live Feed"
                  className="mjpeg-stream"
                  onError={(e) => console.error("MJPEG stream error")}
                />
              )}
            </div>
          </div>

          {/* Bottom-Left: ESP Maker Board Panel */}
          <div className="glass-panel feed-container">
            <div className="feed-header">
              <div className="feed-title">
                {makerCam?.connected && status.isHostSecure && <span className="feed-title-dot" />}
                <span>ESP Maker Board Dashboard (COM18)</span>
              </div>
              {makerCam?.connected && status.isHostSecure && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--color-primary)' }}>
                  IP: {makerCam.ip} | SSID: {makerCam.ssid}
                </div>
              )}
            </div>
            
            <div className="feed-body" style={{ background: '#090e16', padding: '20px', flexDirection: 'column', justifyContent: 'space-around', alignItems: 'stretch' }}>
              {!makerCam?.connected ? (
                <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', width: '100%' }}>
                  <div className="warning-icon" style={{ color: 'var(--color-warning)', animation: 'pulse 1.5s infinite' }}>🔌</div>
                  <div style={{ textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' }}>Waiting for Maker Board Beacons...</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                    Confirm the board is powered, flashed on COM18, and connected to WiFi.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', width: '100%', height: '100%', boxSizing: 'border-box' }}>
                  {/* Motor Telemetry Bars */}
                  <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,242,254,0.1)', borderRadius: '10px', padding: '15px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid rgba(0,242,254,0.1)', paddingBottom: '5px', fontWeight: 'bold', color: 'var(--color-primary)' }}>
                      🏍️ Motor Drive Outputs
                    </div>
                    {motorSpeeds.map((speed, i) => {
                      const percentage = Math.round((Math.abs(speed) / 255) * 100);
                      const isFwd = speed >= 0;
                      return (
                        <div key={i} style={{ margin: '8px 0' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', marginBottom: '3px' }}>
                            <span>MOTOR M{i+1}</span>
                            <span style={{ color: speed === 0 ? 'var(--text-muted)' : isFwd ? 'var(--color-success)' : 'var(--color-danger)' }}>
                              {speed === 0 ? 'STOPPED' : `${isFwd ? '+' : '-'}${percentage}% (${speed})`}
                            </span>
                          </div>
                          <div style={{ height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', overflow: 'hidden', position: 'relative' }}>
                            <div style={{
                              height: '100%',
                              width: `${percentage}%`,
                              background: speed === 0 ? 'transparent' : isFwd ? 'linear-gradient(to right, #00ff87, #60efff)' : 'linear-gradient(to right, #ff4e50, #f9d423)',
                              transition: 'width 0.2s ease',
                              borderRadius: '4px'
                            }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Active RGB LED Indicators */}
                  <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(0,242,254,0.1)', borderRadius: '10px', padding: '15px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid rgba(0,242,254,0.1)', paddingBottom: '5px', fontWeight: 'bold', color: 'var(--color-accent)', width: '100%', textAlign: 'center' }}>
                      💡 Onboard NeoPixel status
                    </div>
                    <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', margin: '20px 0' }}>
                      {ledColors.map((led, i) => {
                        const ledColor = `rgb(${led.r}, ${led.g}, ${led.b})`;
                        const isOff = led.r === 0 && led.g === 0 && led.b === 0;
                        return (
                          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                            <div style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '50%',
                              background: isOff ? '#1a2230' : ledColor,
                              border: '2px solid rgba(255,255,255,0.1)',
                              boxShadow: isOff ? 'none' : `0 0 15px ${ledColor}`,
                              transition: 'all 0.3s ease'
                            }} />
                            <span style={{ fontSize: '0.65rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>LED {i}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', fontStyle: 'italic' }}>
                      Updates stream in real-time from target device.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right Dashboard controls Sidebar */}
        <aside className="glass-panel">
          {/* Safety Verification Console */}
          <div className="panel-section" style={{ background: isVerified ? 'transparent' : 'rgba(255,78,80,0.06)' }}>
            <h3 className="section-title" style={{ color: isVerified ? 'var(--color-success)' : 'var(--color-danger)' }}>
              {isVerified ? '✓ Safety verification active' : '⚠️ SAFE MOTOR VERIFICATION'}
            </h3>
            
            {!isVerified ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '0.8rem', lineHeight: '1.4', color: 'var(--text-muted)' }}>
                  <strong>Prerequisite:</strong> Jack up the tank tracks so they rotate freely in mid-air. Trigger each 500ms safety test below at low power, verify correct motion direction, and check off.
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '8px' }}>
                  {/* Test 1 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyBreak: 'space-between', gap: '10px' }}>
                    <button 
                      className="hud-btn" 
                      style={{ flex: 1, fontSize: '0.7rem', padding: '6px' }}
                      onClick={() => runMotorTest('left', 'forward')}
                      disabled={isTestRunning}
                    >
                      ⚡ Test Left Fwd
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={testChecklist.leftFwd} 
                        onChange={(e) => handleCheckboxChange('leftFwd', e.target.checked)}
                      />
                      <span>Pass</span>
                    </label>
                  </div>

                  {/* Test 2 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button 
                      className="hud-btn" 
                      style={{ flex: 1, fontSize: '0.7rem', padding: '6px' }}
                      onClick={() => runMotorTest('left', 'reverse')}
                      disabled={isTestRunning}
                    >
                      ⚡ Test Left Rev
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={testChecklist.leftRev} 
                        onChange={(e) => handleCheckboxChange('leftRev', e.target.checked)}
                      />
                      <span>Pass</span>
                    </label>
                  </div>

                  {/* Test 3 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button 
                      className="hud-btn" 
                      style={{ flex: 1, fontSize: '0.7rem', padding: '6px' }}
                      onClick={() => runMotorTest('right', 'forward')}
                      disabled={isTestRunning}
                    >
                      ⚡ Test Right Fwd
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={testChecklist.rightFwd} 
                        onChange={(e) => handleCheckboxChange('rightFwd', e.target.checked)}
                      />
                      <span>Pass</span>
                    </label>
                  </div>

                  {/* Test 4 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button 
                      className="hud-btn" 
                      style={{ flex: 1, fontSize: '0.7rem', padding: '6px' }}
                      onClick={() => runMotorTest('right', 'reverse')}
                      disabled={isTestRunning}
                    >
                      ⚡ Test Right Rev
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={testChecklist.rightRev} 
                        onChange={(e) => handleCheckboxChange('rightRev', e.target.checked)}
                      />
                      <span>Pass</span>
                    </label>
                  </div>
                </div>

                <button 
                  className="hud-btn" 
                  style={{ background: 'var(--color-success)', color: '#000', fontWeight: 'bold', border: 'none', padding: '10px' }}
                  onClick={verifySafetyConfirm}
                >
                  🔓 UNLOCK COCKPIT CONTROLS
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-success)', fontWeight: 'bold' }}>
                  ✓ System is fully verified. Normal WASD and Joystick speed limits are unlocked.
                </div>
                <button 
                  className="hud-btn warning" 
                  style={{ padding: '6px 0', fontSize: '0.75rem' }} 
                  onClick={resetSafetyVerification}
                >
                  🔒 Lock & Reset Safety Tests
                </button>
              </div>
            )}
          </div>

          {/* Drive Controller HUD */}
          <div className="panel-section" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 className="section-title" style={{ margin: 0 }}>Drive HUD Controls</h3>
              {gamepadActive && (
                <span className="info-tag stat-val success" style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--color-success)', background: 'rgba(0, 255, 135, 0.1)' }}>
                  🎮 CONTROLLER ACTIVE
                </span>
              )}
            </div>
            
            {/* Safety Lockout Overlay */}
            {!isVerified && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(10, 14, 20, 0.9)',
                borderRadius: '8px',
                zIndex: 10,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '20px',
                textAlign: 'center'
              }}>
                <span style={{ fontSize: '2rem', marginBottom: '8px' }}>🔒</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--color-danger)' }}>HUD LOCKED</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Run the safe motor tests above to unlock drive hud.
                </span>
              </div>
            )}

            <div className="controls-layout">
              {/* Keyboard WASD */}
              <div style={{ textAlign: 'center' }}>
                <span className="stat-lbl" style={{ marginBottom: '5px', display: 'block' }}>Keyboard Inputs</span>
                <div className="wasd-keys">
                  <div className={`key w-key ${activeKeys.w ? 'active' : ''}`}>W</div>
                  <div className={`key ${activeKeys.a ? 'active' : ''}`}>A</div>
                  <div className={`key ${activeKeys.s ? 'active' : ''}`}>S</div>
                  <div className={`key ${activeKeys.d ? 'active' : ''}`}>D</div>
                </div>
              </div>

              {/* Joystick */}
              <div style={{ textAlign: 'center', marginTop: '5px' }}>
                <span className="stat-lbl" style={{ marginBottom: '8px', display: 'block' }}>Analog Joystick</span>
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
              </div>

              {/* Speed Limit Slider */}
              <div style={{ padding: '0 5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span className="stat-lbl">Drive Speed Limit</span>
                  <span className="stat-val active" style={{ fontWeight: 'bold' }}>
                    {Math.round((speedLimit / 255) * 100)}% ({speedLimit})
                  </span>
                </div>
                <input 
                  type="range" 
                  min="40" 
                  max={isVerified ? 255 : 80} 
                  value={speedLimit} 
                  onChange={handleSpeedLimitChange}
                  style={{ width: '100%', accentColor: 'var(--color-primary)', background: 'rgba(255,255,255,0.1)', height: '4px', borderRadius: '2px', outline: 'none' }}
                />
              </div>
            </div>
          </div>

          {/* RGB LED Color Studio */}
          <div className="panel-section" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 className="section-title">RGB NeoPixel Studio</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Target LED Selector */}
              <div>
                <span className="stat-lbl" style={{ marginBottom: '6px', display: 'block' }}>Target Light Selector</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px' }}>
                  {[-1, 0, 1, 2, 3].map(val => (
                    <button 
                      key={val} 
                      className={`hud-btn ${selectedLed === val ? 'active' : ''}`}
                      style={{ padding: '6px 0', fontSize: '0.65rem' }}
                      onClick={() => setSelectedLed(val)}
                    >
                      {val === -1 ? 'ALL' : `L${val}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Google Presets & Color picker */}
              <div>
                <span className="stat-lbl" style={{ marginBottom: '6px', display: 'block' }}>Color Studio Palette</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '10px' }}>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#4285F4', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#4285F4')}>Blue</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#EA4335', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#EA4335')}>Red</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#FBBC05', color: '#000', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#FBBC05')}>Yellow</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#34A853', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#34A853')}>Green</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#8e44ad', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#8e44ad')}>Purple</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#16a085', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#16a085')}>Teal</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#ffffff', color: '#000', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#ffffff')}>White</button>
                  <button className="hud-btn" style={{ padding: '6px 0', background: '#2c3e50', color: '#fff', border: 'none', fontSize: '0.7rem' }} onClick={() => applyLedColor('#000000')}>Off</button>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Custom HEX Color</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input 
                      type="color" 
                      value={pickerColor} 
                      onChange={(e) => setPickerColor(e.target.value)}
                      style={{ width: '28px', height: '28px', border: 'none', padding: '0', background: 'none', cursor: 'pointer' }}
                    />
                    <button 
                      className="hud-btn" 
                      style={{ fontSize: '0.7rem', padding: '4px 10px' }}
                      onClick={() => applyLedColor(pickerColor)}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* System Connections and Emergency Stop */}
          <div className="panel-section" style={{ borderTop: '1px solid rgba(255,255,255,0.05)', flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <div>
              <h3 className="section-title">Telemetry & System</h3>
              <div className="telemetry-grid" style={{ marginTop: '8px' }}>
                <div className="stat-box">
                  <span className="stat-lbl">esp32cam Link</span>
                  <span className={`stat-val ${status.cameras?.esp32cam?.connected ? 'success' : 'warning'}`}>
                    {status.cameras?.esp32cam?.connected ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div className="stat-box">
                  <span className="stat-lbl">maker-esp32 Link</span>
                  <span className={`stat-val ${makerCam?.connected ? 'success' : 'warning'}`}>
                    {makerCam?.connected ? 'Online' : 'Offline'}
                  </span>
                </div>
                <div className="stat-box" style={{ gridColumn: 'span 2' }}>
                  <span className="stat-lbl">System Logs / Status</span>
                  <span className={statusColorClass} style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeStatusMessage}
                  </span>
                </div>
              </div>
            </div>

            <button 
              className="hud-btn active" 
              style={{ width: '100%', padding: '12px 0', fontSize: '0.9rem', fontWeight: 'bold', background: '#ff453a', border: '1px solid #ff453a', boxShadow: '0 0 10px rgba(255, 69, 58, 0.4)', marginTop: '20px' }}
              onClick={handleEmergencyStop}
            >
              🛑 EMERGENCY STOP ALL
            </button>
          </div>
        </aside>
      </main>

      <footer>
        🤖 ESP32 Robot Cockpit Console | Flashed on COM18 (Maker Board) & COM6 (Camera)
      </footer>
    </>
  );
}

export default App;
