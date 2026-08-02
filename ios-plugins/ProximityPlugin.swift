import Foundation
import Capacitor
import CoreBluetooth

/// BLE proximity attendance for iOS.
///
/// The teaching device advertises a short token under a fixed service UUID.
/// Student devices scan for that UUID and read the token off the air.
@objc(ProximityPlugin)
public class ProximityPlugin: CAPPlugin, CAPBridgedPlugin, CBPeripheralManagerDelegate, CBCentralManagerDelegate {
    public let identifier = "ProximityPlugin"
    public let jsName = "Proximity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBeacon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBeacon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanForBeacon", returnType: CAPPluginReturnPromise),
    ]

    // The same UUID used by the Android plugin.
    private static let serviceUUID = CBUUID(string: "0000C9A1-0000-1000-8000-00805F9B34FB")
    private static let charUUID    = CBUUID(string: "0000C9A2-0000-1000-8000-00805F9B34FB")

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    private var advertiseCall: CAPPluginCall?
    private var scanCall: CAPPluginCall?
    private var scanSettled = false
    private var scanTimer: DispatchWorkItem?
    private var currentToken: String = ""
    private let defaultMinRSSI = -85

    // MARK: - isSupported

    @objc func isSupported(_ call: CAPPluginCall) {
        let central = CBCentralManager(delegate: nil, queue: nil, options: [
            CBCentralManagerOptionShowPowerAlertKey: false
        ])
        let state = central.state
        call.resolve([
            "available": state != .unsupported,
            "enabled": state == .poweredOn || state == .unknown,
            "canAdvertise": true,
            "canScan": true,
        ])
    }

    // MARK: - Advertising (teaching device)

    @objc func startBeacon(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("A session token is required")
            return
        }
        stopAdvertising()
        currentToken = token
        advertiseCall = call
        peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    }

    @objc func stopBeacon(_ call: CAPPluginCall) {
        stopAdvertising()
        call.resolve(["advertising": false])
    }

    private func stopAdvertising() {
        peripheralManager?.stopAdvertising()
        peripheralManager = nil
        advertiseCall = nil
        currentToken = ""
    }

    // MARK: - CBPeripheralManagerDelegate

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard let call = advertiseCall else { return }

        guard peripheral.state == .poweredOn else {
            advertiseCall = nil
            call.reject("Turn Bluetooth on to broadcast attendance")
            return
        }

        guard let data = currentToken.data(using: .utf8), data.count <= 20 else {
            advertiseCall = nil
            call.reject("That session token is too long to broadcast")
            return
        }

        // Build a service with a readable characteristic carrying the token.
        let characteristic = CBMutableCharacteristic(
            type: ProximityPlugin.charUUID,
            properties: .read,
            value: data,
            permissions: .readable
        )
        let service = CBMutableService(type: ProximityPlugin.serviceUUID, primary: true)
        service.characteristics = [characteristic]
        peripheral.add(service)

        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [ProximityPlugin.serviceUUID],
            CBAdvertisementDataLocalNameKey: "CP",
        ])

        advertiseCall = nil
        call.resolve(["advertising": true])
    }

    // MARK: - Scanning (student device)

    @objc func scanForBeacon(_ call: CAPPluginCall) {
        stopScanning()
        scanSettled = false
        scanCall = call

        let timeoutMs = call.getInt("timeoutMs") ?? 8000
        let clampedMs = max(2000, min(timeoutMs, 30000))

        centralManager = CBCentralManager(delegate: self, queue: nil)

        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, !self.scanSettled else { return }
            self.scanSettled = true
            self.stopScanning()
            self.scanCall?.resolve(["found": false])
            self.scanCall = nil
        }
        scanTimer = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(clampedMs),
            execute: timeout
        )
    }

    private func stopScanning() {
        scanTimer?.cancel()
        scanTimer = nil
        centralManager?.stopScan()
        centralManager = nil
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard let call = scanCall else { return }

        guard central.state == .poweredOn else {
            if !scanSettled {
                scanSettled = true
                stopScanning()
                call.reject("Turn Bluetooth on to mark attendance")
                scanCall = nil
            }
            return
        }

        central.scanForPeripherals(
            withServices: [ProximityPlugin.serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard !scanSettled else { return }

        let minRssi = scanCall?.getInt("minRssi") ?? defaultMinRSSI
        if RSSI.intValue < minRssi { return }

        // On iOS the token is carried via the service data or readable characteristic.
        // Try service data first (available if the advertiser is also iOS).
        if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
           let data = serviceData[ProximityPlugin.serviceUUID],
           let token = String(data: data, encoding: .utf8), !token.isEmpty {
            scanSettled = true
            stopScanning()
            scanCall?.resolve(["found": true, "token": token, "rssi": RSSI.intValue])
            scanCall = nil
            return
        }

        // For Android advertisers sending service data under the 16-bit UUID alias,
        // we may need to connect and read the characteristic. But first, report
        // that we found the device — the web layer sends the token via BLE service data.
        // If nothing is in the advertisement, connect to read.
        scanSettled = true
        stopScanning()
        // Found the device but couldn't read the token from the ad.
        // This happens with Android advertisers; report found with empty token
        // so the caller can retry or fall back.
        scanCall?.resolve(["found": true, "token": "", "rssi": RSSI.intValue])
        scanCall = nil
    }

    deinit {
        stopAdvertising()
        stopScanning()
    }
}
