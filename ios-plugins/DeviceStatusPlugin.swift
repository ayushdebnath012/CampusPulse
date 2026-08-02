import Foundation
import Capacitor
import Network
import CoreBluetooth

/// Checks Wi-Fi connectivity and Bluetooth enabled state on iOS.
@objc(DeviceStatusPlugin)
public class DeviceStatusPlugin: CAPPlugin, CAPBridgedPlugin, CBCentralManagerDelegate {
    public let identifier = "DeviceStatusPlugin"
    public let jsName = "DeviceStatus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkWifi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkBluetooth", returnType: CAPPluginReturnPromise),
    ]

    private lazy var centralManager: CBCentralManager = {
        return CBCentralManager(delegate: self, queue: nil, options: [
            CBCentralManagerOptionShowPowerAlertKey: false
        ])
    }()

    private var bluetoothCall: CAPPluginCall?

    @objc func checkWifi(_ call: CAPPluginCall) {
        let monitor = NWPathMonitor(requiredInterfaceType: .wifi)
        monitor.pathUpdateHandler = { path in
            monitor.cancel()
            call.resolve(["connected": path.status == .satisfied])
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
        // Timeout after 3 seconds in case the handler never fires.
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            monitor.cancel()
            call.resolve(["connected": false])
        }
    }

    @objc func checkBluetooth(_ call: CAPPluginCall) {
        let state = centralManager.state
        if state == .unknown {
            // CBCentralManager hasn't finished initialising yet.
            bluetoothCall = call
            return
        }
        call.resolve([
            "available": state != .unsupported,
            "enabled": state == .poweredOn,
        ])
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard let call = bluetoothCall else { return }
        bluetoothCall = nil
        call.resolve([
            "available": central.state != .unsupported,
            "enabled": central.state == .poweredOn,
        ])
    }
}
