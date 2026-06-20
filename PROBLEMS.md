# Hardware Failure & Motor Safety Documentation (PROBLEMS.md)

## Summary of the Failure
During testing, the Waveshare General Driver Board motor-driver chip overheated and blackened. The failure occurred under the following conditions:
* **Physical Setup**: The tank chassis was lifted (tracks off the ground, motors not under ground load).
* **Checks**: Wiring and motor short checks did not indicate any direct electrical short.
* **Motor Resistances**: Left and right motors measured approximately **8.5Ω** and **9.8Ω** respectively.
* **Symptom 1**: Motors sometimes kept running indefinitely after a forward command.
* **Symptom 2**: Motors acted erratically (unpredictable jumps/stalls) immediately after starting up.

---

## Likely Causes of the Failure

1. **Driver Overcurrent or Thermal Failure**
   * The measured motor resistances (8.5Ω and 9.8Ω) draw high transient currents. At a nominal 12V battery supply, stall/startup current can reach $I = \frac{V}{R} \approx 1.2\text{A}$ to $1.4\text{A}$ per motor.
   * If the driver chip on the Waveshare General Driver Board is undersized (or lacks adequate thermal dissipation/heatsinking), continuous or fast-switching drive commands can easily lead to thermal runaway.

2. **Brownout and Electrical Noise**
   * Motor startup creates massive voltage dips (current spikes).
   * Disabling the brownout detector software-side (`WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);`) allowed the ESP32 to continue running during these power fluctuations. Consequently, the MCU or the driver gates could enter undefined logic states, driving both high/low bridge pins simultaneously (shoot-through) or latching the outputs on, leading to immediate thermal failure.

3. **Unsafe Software Defaults**
   * The default PWM speed limit was set to maximum (255) in both firmware and frontend, resulting in maximum initial load.

4. **Incomplete State Clearing on Stop**
   * Stop commands did not fully clear the target or actual motor driving states, which allowed delayed commands or residual inputs to re-trigger the motors.

5. **Sudden Direction Changes**
   * Going directly from forward to reverse (or vice-versa) creates massive back-EMF and currents that double the voltage/current stress on the driver transistors.

6. **Undersized Motor Driver**
   * The motor driver chip might be undersized for track-based driving, which demands significantly more torque and current than standard wheeled chassis.

---

## Safety Checklist: Before Next Power-Up

Perform the following steps before powering the replacement driver board:

- [ ] **Verify Brownout Detector is Enabled**: Ensure that code disabling the brownout detector is removed.
- [ ] **Verify Safe Startup State**: Confirm that firmware forces motor control GPIOs to a safe low/off state immediately on boot.
- [ ] **Verify Stop Command Integrity**: Confirm that `/api/stop` immediately clears all driver states and forces pins low.
- [ ] **Verify Command Watchdog (Deadman Switch)**: Verify that the timeout stops motors within 750 ms if connection or control inputs glitch.
- [ ] **Verify Low Default PWM**: Confirm that `DEFAULT_MAX_PWM` is set to 80 (or 100) instead of 255.
- [ ] **Verify Direction Transition Delay**: Confirm that direct forward-to-reverse changes are delayed by at least 250 ms with coasting in between.
- [ ] **Test with Disconnected Motors First**: Power the board without motors attached and verify outputs using a multimeter or oscilloscope.
- [ ] **Test with Tank Lifted**: Ensure the tank is physically elevated with tracks off the ground during first tests.
- [ ] **Use a Current-Limited Power Supply**: If available, use a current-limited bench power supply or insert an in-line fuse (e.g., 2A fast-blow) to protect the new board.
- [ ] **Start at Low PWM Only**: Do not increase the speed slider limit until all safety mechanisms are manually verified.

---

## Hardware Limitations Note
> [!IMPORTANT]
> Software controls and safety algorithms cannot fully protect an undersized or poorly cooled motor-driver chip. Installing an inline fuse (2A fast-blow) on the motor VCC line, adding heatsinks, and utilizing current-limiting supplies are highly recommended hardware precautions.

## Safe Motor Test UI

A Safe Motor Test UI has been introduced in the control dashboard.
* **Why it was added**: Standard joystick/keyboard controls can be unpredictable or too continuous during the initial power-up verification phase. If a motor acts erratically, manual stop reaction times might be too slow to prevent chip overheating.
* **Functionality**:
  * The motor test mode executes short, automatically timed pulses (e.g. 500 ms) and immediately powers off.
  * Default test PWM is constrained to a safe, low level (60-80), and cannot exceed 100.
  * The timed pulse logic is enforced on the ESP32 hardware side. If the browser tab crashes or disconnects during a test pulse, the ESP32 will still safely cut power when the duration expires.
  * The panel provides a dedicated, persistent **EMERGENCY STOP** button that always overrides active tests and forces the motor outputs off.
* **Testing Guidelines**:
  1. Test the **EMERGENCY STOP** functionality *before* connecting the motors to verify that the relay/driver control outputs immediately drop to 0V.
  2. Always lift the tank chassis (elevate tracks off the ground) during the initial testing phase.
  3. Ensure that the test durations are kept short (maximum 1000-1500 ms) and the test PWM remains low.

## Ignored Secrets / Configs Flag
* **Wi-Fi Credentials**: Wi-Fi credentials (`Pumpkinpie` and `Dobby`) are currently hardcoded in `src/main.cpp` for convenience. Keep these secure and do not commit changes to public repositories.
