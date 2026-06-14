import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const VERIFIED_SSIDS = ['Pumpkinpie', 'Dobby'];
let currentSSID = 'Unknown';
let isHostSecure = false;

async function checkWifiSSID() {
  try {
    console.log("Running netsh...");
    const { stdout } = await execAsync('netsh wlan show interfaces');
    console.log("netsh stdout:\n", stdout);
    const lines = stdout.split('\n');
    let ssidFound = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SSID') && trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length > 1) {
          currentSSID = parts[1].trim();
          isHostSecure = VERIFIED_SSIDS.includes(currentSSID);
          console.log(`netsh found SSID: "${currentSSID}", isSecure: ${isHostSecure}`);
          ssidFound = true;
          break;
        }
      }
    }

    if (!ssidFound) {
      currentSSID = 'Disconnected/Ethernet/Other';
      isHostSecure = false;
      console.log("netsh did not find SSID.");
    }
  } catch (err) {
    console.error("netsh error:", err.message);
    currentSSID = 'Ethernet/Non-WiFi';
    isHostSecure = false;
  }

  if (!isHostSecure) {
    try {
      console.log("Running powershell fallback...");
      const { stdout: psOut } = await execAsync('powershell -Command "Get-NetConnectionProfile | Select-Object -ExpandProperty Name"');
      console.log("powershell stdout:", JSON.stringify(psOut));
      const names = psOut.split('\n').map(n => n.trim()).filter(Boolean);
      console.log("powershell connection profiles:", names);
      for (const name of names) {
        if (VERIFIED_SSIDS.includes(name)) {
          currentSSID = name;
          isHostSecure = true;
          console.log(`powershell found verified profile: "${currentSSID}"`);
          break;
        }
      }
    } catch (psErr) {
      console.error("powershell error:", psErr.message);
    }
  }
}

checkWifiSSID().then(() => {
  console.log("Final state:", { currentSSID, isHostSecure });
});
