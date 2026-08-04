import Foundation
import Capacitor
import CoreBluetooth

/// BLE proximity attendance for iOS.
///
/// The teaching device advertises a short session token under a fixed service
/// UUID; student devices read it straight off the air, so nothing is typed and
/// only a phone inside the hall can hear it.
///
/// Two details drive the shape of this file:
///
/// 1. iOS will not put service data in an advertisement — `startAdvertising`
///    honours only the local name and the service UUID list. An iPhone acting
///    as the beacon therefore carries the token in its local name, and the
///    Android plugin reads that name as a fallback. Android beacons still use
///    service data, which iOS can read, so both directions work.
/// 2. CoreBluetooth reports the 128-bit UUID Android advertises in its short
///    16-bit form, and `CBUUID` does not treat the two as equal. Both forms are
///    checked when looking for service data.
///
/// Range is judged by estimated distance rather than a raw signal reading. A
/// single packet's RSSI swings by 10 dB or more as someone shifts in a seat, so
/// a scan gathers samples for a short dwell and judges the strongest few.
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

    /// The same UUID the Android plugin uses, in both the form CoreBluetooth
    /// hands back for a 16-bit advertisement and the full 128-bit form.
    private static let serviceUUID = CBUUID(string: "0000C9A1-0000-1000-8000-00805F9B34FB")
    private static let shortServiceUUID = CBUUID(string: "C9A1")
    /// Marks a local name as ours, for beacons that cannot send service data.
    private static let namePrefix = "CP"

    /// Typical RSSI one metre from a phone advertising at full power.
    private static let defaultTxPowerAt1m = -59.0
    /// Free space is 2.0; a hall full of people and furniture absorbs more.
    private static let defaultPathLossExponent = 2.2
    /// Reaches the back of a large lecture theatre. Excluding a student who is
    /// genuinely in the room is a worse failure than including someone in the
    /// corridor, and the walls mostly exclude the corridor anyway.
    private static let defaultMaxDistanceMeters = 30.0
    private static let defaultMinSamples = 3
    private static let defaultDwellMs = 2500

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?
    private var probeManager: CBCentralManager?

    private var advertiseCall: CAPPluginCall?
    private var advertisedToken = ""

    private var scanCall: CAPPluginCall?
    private var scanSettled = false
    private var scanTimer: DispatchWorkItem?
    private var scanStartedAt = Date()
    private var beacons: [String: Beacon] = [:]
    private var scanLimits = ScanLimits()

    /// RSSI samples gathered from one advertising device during a scan.
    private final class Beacon {
        let token: String
        var samples: [Int] = []

        init(token: String) {
            self.token = token
        }
    }

    private struct ScanLimits {
        var maxDistanceMeters = ProximityPlugin.defaultMaxDistanceMeters
        var pathLossExponent = ProximityPlugin.defaultPathLossExponent
        var txPowerAt1m = ProximityPlugin.defaultTxPowerAt1m
        var minSamples = ProximityPlugin.defaultMinSamples
        var dwellMs = ProximityPlugin.defaultDwellMs
        var explicitMinRssi: Int?
    }

    // MARK: - isSupported

    @objc func isSupported(_ call: CAPPluginCall) {
        // A freshly built manager always reports `.unknown` until its delegate
        // fires, so the answer has to wait for that rather than guess.
        let manager = probeManager ?? CBCentralManager(
            delegate: nil,
            queue: nil,
            options: [CBCentralManagerOptionShowPowerAlertKey: false]
        )
        probeManager = manager

        func reply() {
            let state = manager.state
            call.resolve([
                "available": state != .unsupported,
                "enabled": state == .poweredOn,
                "canAdvertise": state == .poweredOn,
                "canScan": state == .poweredOn,
                "locationServicesRequired": false,
                "locationServicesOff": false,
                "defaultMaxDistanceMeters": ProximityPlugin.defaultMaxDistanceMeters,
                "platform": "ios",
            ])
        }

        if manager.state == .unknown {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(400)) { reply() }
        } else {
            reply()
        }
    }

    // MARK: - Advertising (teaching device)

    @objc func startBeacon(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("A session token is required")
            return
        }
        // The local name is the only field iOS lets an app fill, and the whole
        // advertisement is 31 bytes.
        guard (ProximityPlugin.namePrefix + token).utf8.count <= 26 else {
            call.reject("That session token is too long to broadcast")
            return
        }

        stopAdvertising()
        advertisedToken = token
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
        advertisedToken = ""
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard let call = advertiseCall else { return }

        switch peripheral.state {
        case .poweredOn:
            break
        case .unauthorized:
            advertiseCall = nil
            call.reject("Allow CampusPulse to use Bluetooth to broadcast attendance")
            return
        case .unsupported:
            advertiseCall = nil
            call.reject("This device cannot broadcast over Bluetooth LE")
            return
        case .unknown, .resetting:
            // Not an answer yet; a later callback carries the real state.
            return
        default:
            advertiseCall = nil
            call.reject("Turn Bluetooth on to broadcast attendance")
            return
        }

        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [ProximityPlugin.serviceUUID],
            // iOS cannot advertise service data, so the token rides here.
            CBAdvertisementDataLocalNameKey: ProximityPlugin.namePrefix + advertisedToken,
        ])
    }

    public func peripheralManagerDidStartAdvertising(
        _ peripheral: CBPeripheralManager,
        error: Error?
    ) {
        guard let call = advertiseCall else { return }
        advertiseCall = nil
        if let error {
            call.reject("Could not start the Bluetooth beacon: \(error.localizedDescription)")
        } else {
            call.resolve(["advertising": true])
        }
    }

    // MARK: - Scanning (student device)

    @objc func scanForBeacon(_ call: CAPPluginCall) {
        stopScanning()
        scanSettled = false
        scanCall = call
        beacons = [:]
        scanStartedAt = Date()

        var limits = ScanLimits()
        if let value = call.getDouble("maxDistanceMeters"), value > 0 {
            limits.maxDistanceMeters = value
        }
        if let value = call.getDouble("pathLossExponent"), value > 0 {
            limits.pathLossExponent = value
        }
        if let value = call.getDouble("txPowerAt1m") {
            limits.txPowerAt1m = value
        }
        if let value = call.getInt("minSamples") {
            limits.minSamples = min(max(value, 1), 20)
        }
        limits.explicitMinRssi = call.getInt("minRssi")

        let timeoutMs = min(max(call.getInt("timeoutMs") ?? 12000, 3000), 30000)
        limits.dwellMs = min(max(call.getInt("dwellMs") ?? ProximityPlugin.defaultDwellMs, 0), timeoutMs)
        scanLimits = limits

        centralManager = CBCentralManager(delegate: self, queue: nil)

        let timeout = DispatchWorkItem { [weak self] in
            self?.finishScan()
        }
        scanTimer = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(timeoutMs),
            execute: timeout
        )
    }

    private func stopScanning() {
        scanTimer?.cancel()
        scanTimer = nil
        centralManager?.stopScan()
        centralManager = nil
    }

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard let call = scanCall, !scanSettled else { return }

        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(
                withServices: [ProximityPlugin.serviceUUID],
                // Repeated readings are what make the distance estimate
                // trustworthy; without this iOS reports each device once.
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
        case .unknown, .resetting:
            return
        case .unauthorized:
            settle { call.reject("Allow CampusPulse to use Bluetooth to mark attendance") }
        case .unsupported:
            settle { call.reject("This device cannot scan over Bluetooth LE") }
        default:
            settle { call.reject("Turn Bluetooth on to mark attendance") }
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard !scanSettled, scanCall != nil else { return }
        guard let token = token(from: advertisementData), !token.isEmpty else { return }
        // iOS reports 127 when it has no valid reading for a device.
        let rssi = RSSI.intValue
        guard rssi < 0 else { return }

        let beacon = beacons[token] ?? Beacon(token: token)
        beacon.samples.append(rssi)
        beacons[token] = beacon

        // Settle early once the reading is both in range and well sampled, so a
        // student at the front is not kept waiting.
        guard Date().timeIntervalSince(scanStartedAt) * 1000 >= Double(scanLimits.dwellMs) else {
            return
        }
        guard beacon.samples.count >= scanLimits.minSamples else { return }
        guard inRange(beacon) else { return }

        let distance = estimateDistance(beacon)
        settle { [weak self] in
            guard let self, let call = self.scanCall else { return }
            call.resolve(self.foundPayload(beacon, distance: distance))
        }
    }

    private func finishScan() {
        guard !scanSettled, let call = scanCall else { return }

        // Nothing settled early, so take the closest beacon heard overall.
        let closest = beacons.values.min { estimateDistance($0) < estimateDistance($1) }

        settle {
            guard let closest else {
                call.resolve(["found": false])
                return
            }
            let distance = self.estimateDistance(closest)
            if self.inRange(closest) {
                call.resolve(self.foundPayload(closest, distance: distance))
                return
            }
            // Heard, but too far: the difference matters to a student deciding
            // whether to move closer or report a problem.
            call.resolve([
                "found": false,
                "outOfRange": true,
                "distanceMeters": (distance * 10).rounded() / 10,
                "rssi": closest.samples.max() ?? 0,
                "maxDistanceMeters": self.scanLimits.maxDistanceMeters,
            ])
        }
    }

    private func foundPayload(_ beacon: Beacon, distance: Double) -> [String: Any] {
        [
            "found": true,
            "token": beacon.token,
            "rssi": beacon.samples.max() ?? 0,
            "distanceMeters": (distance * 10).rounded() / 10,
            "samples": beacon.samples.count,
            "confident": beacon.samples.count >= scanLimits.minSamples,
        ]
    }

    /// Settles the scan exactly once, tearing the radio down before replying.
    private func settle(_ finish: () -> Void) {
        scanSettled = true
        stopScanning()
        finish()
        scanCall = nil
    }

    /// Reads the session token from an advertisement.
    ///
    /// Service data is what an Android beacon sends; the local name is what an
    /// iPhone beacon sends, because iOS will not advertise service data.
    private func token(from advertisementData: [String: Any]) -> String? {
        if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey]
            as? [CBUUID: Data] {
            let payload = serviceData[ProximityPlugin.serviceUUID]
                ?? serviceData[ProximityPlugin.shortServiceUUID]
            if let payload, let token = String(data: payload, encoding: .utf8) {
                let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        if let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String,
           name.hasPrefix(ProximityPlugin.namePrefix) {
            let token = String(name.dropFirst(ProximityPlugin.namePrefix.count))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty { return token }
        }
        return nil
    }

    private func inRange(_ beacon: Beacon) -> Bool {
        if let floor = scanLimits.explicitMinRssi {
            return (beacon.samples.max() ?? Int.min) >= floor
        }
        return estimateDistance(beacon) <= scanLimits.maxDistanceMeters
    }

    /// Estimates how far away a beacon is, using the log-distance path loss
    /// model: distance = 10 ^ ((power at one metre - observed) / (10 * n)).
    ///
    /// The strongest readings are the honest ones: a phone in a pocket or
    /// behind a body only ever loses signal, never gains it. Taking the median
    /// of the best few rejects both that attenuation and the occasional spike.
    private func estimateDistance(_ beacon: Beacon) -> Double {
        guard !beacon.samples.isEmpty else { return .greatestFiniteMagnitude }
        let sorted = beacon.samples.sorted(by: >)
        let considered = min(3, sorted.count)
        let representative = Double(sorted[considered / 2])
        return pow(
            10.0,
            (scanLimits.txPowerAt1m - representative) / (10.0 * scanLimits.pathLossExponent)
        )
    }

    deinit {
        stopAdvertising()
        stopScanning()
    }
}
