# iOS Setup Guide — CampusPulse

## Prerequisites
- A Mac with **Xcode 15+** installed
- An Apple Developer account (free for simulator, $99/yr for device/TestFlight)
- Node.js and npm installed on the Mac

## Step 1: Install dependencies
```bash
cd CampusPulse
npm install
```

## Step 2: Add the iOS platform
```bash
npx cap add ios
```
This creates the `ios/` directory with an Xcode project.

## Step 3: Copy the native plugins
```bash
cp ios-plugins/DeviceStatusPlugin.swift ios/App/App/
cp ios-plugins/ProximityPlugin.swift ios/App/App/
```

## Step 4: Register the plugins
Open `ios/App/App/AppDelegate.swift` and add:
```swift
import Capacitor

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    // ... existing code ...

    override func application(_ application: UIApplication, pluginRegistration registry: Capacitor.PluginRegistry) {
        registry.register(DeviceStatusPlugin.self)
        registry.register(ProximityPlugin.self)
    }
}
```

## Step 5: Add Info.plist permissions
Open `ios/App/App/Info.plist` and add these keys:
```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>CampusPulse uses Bluetooth to verify you are in the classroom for attendance.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>CampusPulse uses Bluetooth to broadcast attendance to students in the room.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>CampusPulse checks your Wi-Fi connection for attendance verification.</string>
```

## Step 6: Sync and open in Xcode
```bash
npx cap sync ios
npx cap open ios
```

## Step 7: Build and run
- In Xcode, select your target device or simulator
- Press **Cmd+R** to build and run
- For TestFlight: Product → Archive → Distribute App

## Notes
- The BLE plugins use the same service UUID (`0000C9A1-...`) as Android, so cross-platform proximity works
- iOS may limit BLE advertising in the background; keep the app in the foreground during attendance
- On simulator, Bluetooth features won't work — use a real device for testing
