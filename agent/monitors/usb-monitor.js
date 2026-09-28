const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

class UsbMonitor {
  constructor(agent) {
    this.agent = agent;
    this.knownDevices = new Set();
    this.checkInterval = null;
  }

  async start() {
    console.log('[UsbMonitor] Starting...');
    
    // Get initial list of connected USB devices
    await this.updateKnownDevices();
    
    // Check for new devices periodically
    this.checkInterval = setInterval(() => this.checkForNewDevices(), 10000);
  }

  async stop() {
    if (this.checkInterval) clearInterval(this.checkInterval);
    console.log('[UsbMonitor] Stopped');
  }

  async updateKnownDevices() {
    try {
      const devices = await this.getUsbStorageDevices();
      for (const device of devices) {
        this.knownDevices.add(device.deviceId);
      }
    } catch (e) {}
  }

  async getUsbStorageDevices() {
    try {
      const { stdout } = await execAsync(
        'powershell -Command "Get-WmiObject Win32_USBControllerDevice | ForEach-Object { [wmi]($_.Dependent) } | Where-Object { $_.PNPClass -eq \'DiskDrive\' } | Select-Object Name, DeviceID, PNPDeviceID | ConvertTo-Json"'
      );
      
      const devices = JSON.parse(stdout);
      return Array.isArray(devices) ? devices : [devices];
    } catch (e) {
      return [];
    }
  }

  async checkForNewDevices() {
    try {
      const currentDevices = await this.getUsbStorageDevices();
      
      for (const device of currentDevices) {
        if (!this.knownDevices.has(device.DeviceID)) {
          // New device connected
          this.knownDevices.add(device.DeviceID);
          
          this.agent.logEvent('usb_devices', {
            device_name: device.Name,
            device_id: device.DeviceID,
            event_type: 'connect',
            timestamp: new Date().toISOString()
          });
          
          console.log(`[UsbMonitor] USB device connected: ${device.Name}`);
        }
      }
      
      // Check for disconnected devices
      for (const deviceId of this.knownDevices) {
        const stillConnected = currentDevices.some(d => d.DeviceID === deviceId);
        if (!stillConnected) {
          this.knownDevices.delete(deviceId);
          
          this.agent.logEvent('usb_devices', {
            device_name: 'Unknown',
            device_id: deviceId,
            event_type: 'disconnect',
            timestamp: new Date().toISOString()
          });
          
          console.log(`[UsbMonitor] USB device disconnected: ${deviceId}`);
        }
      }
    } catch (e) {}
  }
}

module.exports = { UsbMonitor };
