import Foundation
import Capacitor
import Network
import CoreBluetooth

/// Checks Wi-Fi connectivity and Bluetooth enabled state on iOS.
///
/// Mirrors the Android plugin of the same name so the web layer can ask the
/// same two questions on either platform.
@objc(DeviceStatusPlugin)
public class DeviceStatusPlugin: CAPPlugin, CAPBridgedPlugin, CBCentralManagerDelegate {
    public let identifier = "DeviceStatusPlugin"
    public let jsName = "DeviceStatus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkWifi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkBluetooth", returnType: CAPPluginReturnPromise),
    ]

    private lazy var centralManager: CBCentralManager = {
        // No power alert: this is a status check, not a request to act.
        CBCentralManager(delegate: self, queue: nil, options: [
            CBCentralManagerOptionShowPowerAlertKey: false
        ])
    }()

    private var bluetoothCall: CAPPluginCall?
    private var bluetoothTimeout: DispatchWorkItem?

    @objc func checkWifi(_ call: CAPPluginCall) {
        let monitor = NWPathMonitor(requiredInterfaceType: .wifi)
        // The monitor's first update and the backstop timer race each other, and
        // resolving a Capacitor call twice is an error, so only the first wins.
        let lock = NSLock()
        var finished = false
        func finish(_ connected: Bool) {
            lock.lock()
            if finished {
                lock.unlock()
                return
            }
            finished = true
            lock.unlock()
            monitor.cancel()
            call.resolve(["connected": connected])
        }

        monitor.pathUpdateHandler = { path in
            finish(path.status == .satisfied)
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
        // A backstop in case the handler never fires at all.
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            finish(false)
        }
    }

    @objc func checkBluetooth(_ call: CAPPluginCall) {
        // Touching the lazy manager is what starts it; until its delegate fires
        // the state is `.unknown` and answering would be a guess.
        let state = centralManager.state
        if state == .unknown {
            bluetoothCall = call
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, let pending = self.bluetoothCall else { return }
                self.bluetoothCall = nil
                pending.resolve(["available": true, "enabled": false])
            }
            bluetoothTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: timeout)
            return
        }
        call.resolve(resultFor(state))
    }

    private func resultFor(_ state: CBManagerState) -> [String: Any] {
        [
            "available": state != .unsupported,
            "enabled": state == .poweredOn,
        ]
    }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        // Still not an answer; a later callback carries the real state.
        if central.state == .unknown { return }
        guard let call = bluetoothCall else { return }
        bluetoothCall = nil
        bluetoothTimeout?.cancel()
        bluetoothTimeout = nil
        call.resolve(resultFor(central.state))
    }
}
