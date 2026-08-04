package in.campuspulse.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Proximity attendance over Bluetooth LE.
 *
 * The teaching device advertises a short session token under a fixed service
 * UUID. Student devices scan for that UUID and read the token straight off the
 * air, so nothing is typed and only a phone inside the hall can hear it.
 *
 * Range is judged by estimated distance rather than a raw signal reading. A
 * single packet's RSSI swings by 10 dB or more as someone shifts in a seat, so
 * a scan gathers samples for a short dwell and judges the strongest few.
 *
 * The default reach covers a full lecture theatre rather than a ten-metre
 * bubble: a student in the back row is in the class and must be able to mark
 * themselves present. Walls do the work of excluding the corridor, since
 * concrete costs a further 10-20 dB and reads as far outside the limit.
 *
 * iOS cannot put service data in an advertisement, so an iPhone acting as the
 * beacon carries the token in its local name instead. Both channels are read
 * here, which is what lets an iPhone teach a hall of Android phones.
 */
@CapacitorPlugin(
    name = "Proximity",
    permissions = {
        @Permission(
            alias = "advertise",
            strings = {
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        @Permission(
            alias = "scan",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        ),
        // Before Android 12 a BLE scan was treated as a way of inferring
        // location, and without this it returns no results at all rather than
        // reporting an error.
        @Permission(
            alias = "scanLegacy",
            strings = { Manifest.permission.ACCESS_FINE_LOCATION }
        )
    }
)
public class ProximityPlugin extends Plugin {
    private static final ParcelUuid SERVICE_UUID =
        ParcelUuid.fromString("0000c9a1-0000-1000-8000-00805f9b34fb");
    /** Marks a local name as ours, for beacons that cannot send service data. */
    private static final String NAME_PREFIX = "CP";

    /** Typical RSSI one metre from a phone advertising at high power. */
    private static final double DEFAULT_TX_POWER_AT_1M = -59.0;
    /**
     * Log-distance path loss exponent. Free space is 2.0; a hall full of people
     * and furniture absorbs more, and 2.2 matches a lecture theatre closely.
     */
    private static final double DEFAULT_PATH_LOSS_EXPONENT = 2.2;
    /**
     * Reaches the back of a large lecture theatre. Excluding a student who is
     * genuinely in the room is a worse failure than including someone in the
     * corridor, and the corridor is mostly excluded by the walls anyway.
     */
    private static final double DEFAULT_MAX_DISTANCE_M = 30.0;
    /** Below this many packets a reading is too noisy to act on. */
    private static final int DEFAULT_MIN_SAMPLES = 3;
    /** Keep listening at least this long so samples can accumulate. */
    private static final int DEFAULT_DWELL_MS = 2500;

    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** What to resume once the user answers the "turn Bluetooth on" prompt. */
    private Runnable pendingBluetoothAction;

    private BluetoothAdapter adapter() {
        BluetoothManager manager =
            (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    /**
     * Whether the radio is on.
     *
     * From Android 12 this reading needs BLUETOOTH_CONNECT. Without it the
     * platform reports the radio as off even when it is plainly on, which is
     * how "turn Bluetooth on" ends up in front of someone whose Bluetooth is
     * already on. Callers must check {@link #missingConnectPermission()} first
     * so they can say what is actually wrong.
     */
    private boolean bluetoothOn() {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) return false;
        try {
            return adapter.isEnabled();
        } catch (SecurityException error) {
            return false;
        }
    }

    private boolean missingConnectPermission() {
        return isAndroid12OrLater()
            && getPermissionState("advertise") != PermissionState.GRANTED
            && getPermissionState("scan") != PermissionState.GRANTED;
    }

    // Apps cannot silently flip the radio, but we can trigger the system's own
    // enable dialog so the professor/student only has to tap "Allow" once.
    private void ensureBluetoothOn(PluginCall call, Runnable action) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This device does not support Bluetooth");
            return;
        }
        if (bluetoothOn()) {
            action.run();
            return;
        }
        if (missingConnectPermission()) {
            // The radio may well be on; we simply are not allowed to look.
            call.reject(
                "Allow CampusPulse the Nearby devices permission, then try again"
            );
            return;
        }
        pendingBluetoothAction = action;
        startActivityForResult(
            call,
            new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),
            "handleBluetoothEnableResult"
        );
    }

    @ActivityCallback
    private void handleBluetoothEnableResult(PluginCall call, ActivityResult result) {
        Runnable action = pendingBluetoothAction;
        pendingBluetoothAction = null;
        if (call == null) return;
        if (action == null) {
            call.reject("Turn Bluetooth on to continue");
            return;
        }
        // Enabling is asynchronous: the dialog returns as soon as it is tapped,
        // while the adapter is still in STATE_TURNING_ON. Checking immediately
        // reports Bluetooth as off even though the user just switched it on, so
        // give it a moment to settle before deciding.
        awaitBluetoothOn(call, action, 10);
    }

    private void awaitBluetoothOn(PluginCall call, Runnable action, int attemptsLeft) {
        if (bluetoothOn()) {
            action.run();
            return;
        }
        if (attemptsLeft <= 0) {
            call.reject("Turn Bluetooth on to continue");
            return;
        }
        handler.postDelayed(() -> awaitBluetoothOn(call, action, attemptsLeft - 1), 250);
    }

    private boolean isAndroid12OrLater() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    /** The permission a scan needs, which changed sides at Android 12. */
    private String scanAlias() {
        return isAndroid12OrLater() ? "scan" : "scanLegacy";
    }

    private boolean missingScanPermission() {
        return getPermissionState(scanAlias()) != PermissionState.GRANTED;
    }

    /**
     * Before Android 12 the location *service* also has to be switched on, or a
     * scan quietly reports nothing. Saying so beats a mysterious timeout.
     */
    private boolean locationServicesRequiredButOff() {
        if (isAndroid12OrLater()) return false;
        LocationManager manager =
            (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        return !manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
            && !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        JSObject result = new JSObject();
        boolean enabled = bluetoothOn();
        result.put("available", adapter != null);
        result.put("enabled", enabled);
        result.put(
            "canAdvertise",
            enabled && adapter.getBluetoothLeAdvertiser() != null
        );
        result.put("canScan", enabled && adapter.getBluetoothLeScanner() != null);
        result.put("locationServicesRequired", !isAndroid12OrLater());
        result.put("locationServicesOff", locationServicesRequiredButOff());
        result.put("defaultMaxDistanceMeters", DEFAULT_MAX_DISTANCE_M);
        result.put("platform", "android");
        call.resolve(result);
    }

    // MARK: - Advertising (teaching device)

    @PluginMethod
    public void startBeacon(PluginCall call) {
        if (isAndroid12OrLater() && getPermissionState("advertise") != PermissionState.GRANTED) {
            requestPermissionForAlias("advertise", call, "advertisePermissionCallback");
            return;
        }
        beginAdvertising(call);
    }

    @PermissionCallback
    private void advertisePermissionCallback(PluginCall call) {
        if (isAndroid12OrLater() && getPermissionState("advertise") != PermissionState.GRANTED) {
            call.reject("Nearby devices permission is required to broadcast attendance");
            return;
        }
        beginAdvertising(call);
    }

    private void beginAdvertising(PluginCall call) {
        String token = call.getString("token", "");
        if (token == null || token.isEmpty()) {
            call.reject("A session token is required");
            return;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This device cannot broadcast over Bluetooth LE");
            return;
        }
        if (!bluetoothOn()) {
            ensureBluetoothOn(call, () -> continueAdvertising(call, token));
            return;
        }
        continueAdvertising(call, token);
    }

    private void continueAdvertising(PluginCall call, String token) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !bluetoothOn()) {
            call.reject("Turn Bluetooth on to broadcast attendance");
            return;
        }
        BluetoothLeAdvertiser next = adapter.getBluetoothLeAdvertiser();
        if (next == null) {
            call.reject("This device cannot broadcast over Bluetooth LE");
            return;
        }

        stopAdvertising();
        advertiser = next;

        byte[] payload = token.getBytes(StandardCharsets.UTF_8);
        if (payload.length > 20) {
            call.reject("That session token is too long to broadcast");
            return;
        }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            // Lets a scanner calibrate against this radio instead of assuming a
            // typical one, which tightens the distance estimate.
            .setIncludeTxPowerLevel(true)
            .addServiceUuid(SERVICE_UUID)
            .addServiceData(SERVICE_UUID, payload)
            .build();

        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                JSObject result = new JSObject();
                result.put("advertising", true);
                result.put("txPower", settingsInEffect.getTxPowerLevel());
                call.resolve(result);
            }

            @Override
            public void onStartFailure(int errorCode) {
                advertiseCallback = null;
                call.reject(advertiseFailureMessage(errorCode));
            }
        };

        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (SecurityException error) {
            advertiseCallback = null;
            call.reject("Nearby devices permission is required to broadcast attendance");
        }
    }

    private String advertiseFailureMessage(int errorCode) {
        switch (errorCode) {
            case AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE:
                return "The attendance broadcast did not fit in a Bluetooth advertisement";
            case AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS:
                return "Bluetooth is busy broadcasting for other apps. Close one and try again";
            case AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED:
                return "Attendance is already being broadcast";
            case AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED:
                return "This phone cannot broadcast over Bluetooth LE. Read the code out instead";
            default:
                return "Could not start the Bluetooth beacon (" + errorCode + ")";
        }
    }

    @PluginMethod
    public void stopBeacon(PluginCall call) {
        stopAdvertising();
        JSObject result = new JSObject();
        result.put("advertising", false);
        call.resolve(result);
    }

    private void stopAdvertising() {
        if (advertiser != null && advertiseCallback != null) {
            try {
                advertiser.stopAdvertising(advertiseCallback);
            } catch (SecurityException ignored) {
                // Losing the permission mid-session is not worth crashing over.
            }
        }
        advertiseCallback = null;
    }

    // MARK: - Scanning (student device)

    @PluginMethod
    public void scanForBeacon(PluginCall call) {
        if (missingScanPermission()) {
            requestPermissionForAlias(scanAlias(), call, "scanPermissionCallback");
            return;
        }
        beginScan(call);
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        if (missingScanPermission()) {
            call.reject(
                isAndroid12OrLater()
                    ? "Nearby devices permission is required to find the class"
                    : "Location permission is required to find the class over Bluetooth"
            );
            return;
        }
        beginScan(call);
    }

    private void beginScan(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This device cannot scan over Bluetooth LE");
            return;
        }
        if (locationServicesRequiredButOff()) {
            call.reject(
                "Turn Location on. Android needs it switched on to find the class over Bluetooth"
            );
            return;
        }
        if (!bluetoothOn()) {
            ensureBluetoothOn(call, () -> continueScanning(call));
            return;
        }
        continueScanning(call);
    }

    /** RSSI samples gathered from one advertising device during a scan. */
    private static final class Beacon {
        final String token;
        final List<Integer> samples = new ArrayList<>();
        Integer advertisedTxPower;

        Beacon(String token) {
            this.token = token;
        }
    }

    private void continueScanning(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !bluetoothOn()) {
            call.reject("Turn Bluetooth on to mark attendance");
            return;
        }
        BluetoothLeScanner next = adapter.getBluetoothLeScanner();
        if (next == null) {
            call.reject("This device cannot scan over Bluetooth LE");
            return;
        }

        stopScanning();
        scanner = next;

        final int timeoutMs = clamp(call.getInt("timeoutMs", 12000), 3000, 30000);
        final double maxDistance = positive(
            call.getDouble("maxDistanceMeters", DEFAULT_MAX_DISTANCE_M),
            DEFAULT_MAX_DISTANCE_M
        );
        final double pathLoss = positive(
            call.getDouble("pathLossExponent", DEFAULT_PATH_LOSS_EXPONENT),
            DEFAULT_PATH_LOSS_EXPONENT
        );
        final double txPowerAt1m = call.getDouble("txPowerAt1m", DEFAULT_TX_POWER_AT_1M);
        final int minSamples = clamp(call.getInt("minSamples", DEFAULT_MIN_SAMPLES), 1, 20);
        final int dwellMs = clamp(call.getInt("dwellMs", DEFAULT_DWELL_MS), 0, timeoutMs);
        // A caller can still impose a plain signal cutoff; otherwise the limit
        // follows from the distance it asked for.
        final Integer explicitMinRssi = call.getInt("minRssi");

        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(SERVICE_UUID).build());
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            // Every packet, not just the first sighting: repeated readings are
            // what make the distance estimate trustworthy.
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setReportDelay(0)
            // Report a weak advertiser rather than waiting for a strong one,
            // which is how the back of the hall gets heard at all.
            .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
            .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
            .build();

        final boolean[] settled = { false };
        final Map<String, Beacon> beacons = new HashMap<>();
        final long startedAt = System.currentTimeMillis();

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (settled[0]) return;
                ScanRecord record = result.getScanRecord();
                if (record == null) return;
                String token = tokenFrom(record);
                if (token == null || token.isEmpty()) return;

                Beacon beacon = beacons.get(token);
                if (beacon == null) {
                    beacon = new Beacon(token);
                    beacons.put(token, beacon);
                }
                beacon.samples.add(result.getRssi());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && result.getTxPower() != ScanResult.TX_POWER_NOT_PRESENT) {
                    beacon.advertisedTxPower = result.getTxPower();
                }

                // Settle early once the reading is both in range and well
                // sampled, so a student at the front is not kept waiting.
                if (System.currentTimeMillis() - startedAt < dwellMs) return;
                if (beacon.samples.size() < minSamples) return;
                if (!inRange(beacon, explicitMinRssi, txPowerAt1m, pathLoss, maxDistance)) return;

                settled[0] = true;
                stopScanning();
                handler.removeCallbacksAndMessages(null);
                resolveFound(
                    call,
                    beacon,
                    estimateDistance(beacon, txPowerAt1m, pathLoss),
                    minSamples
                );
            }

            @Override
            public void onScanFailed(int errorCode) {
                if (settled[0]) return;
                settled[0] = true;
                stopScanning();
                handler.removeCallbacksAndMessages(null);
                call.reject(scanFailureMessage(errorCode));
            }
        };

        try {
            scanner.startScan(filters, settings, scanCallback);
        } catch (SecurityException error) {
            scanCallback = null;
            call.reject("Nearby devices permission is required to find the class");
            return;
        }

        handler.postDelayed(() -> {
            if (settled[0]) return;
            settled[0] = true;
            stopScanning();

            // Nothing settled early, so take the closest beacon heard overall.
            Beacon best = null;
            double bestDistance = Double.MAX_VALUE;
            for (Beacon beacon : beacons.values()) {
                double distance = estimateDistance(beacon, txPowerAt1m, pathLoss);
                if (distance < bestDistance) {
                    best = beacon;
                    bestDistance = distance;
                }
            }

            if (best != null
                && inRange(best, explicitMinRssi, txPowerAt1m, pathLoss, maxDistance)) {
                resolveFound(call, best, bestDistance, minSamples);
                return;
            }

            JSObject missed = new JSObject();
            missed.put("found", false);
            if (best != null) {
                // Heard, but too far: the difference matters to a student
                // deciding whether to move closer or report a problem.
                missed.put("outOfRange", true);
                missed.put("distanceMeters", round1(bestDistance));
                missed.put("rssi", strongest(best.samples));
                missed.put("maxDistanceMeters", maxDistance);
            }
            call.resolve(missed);
        }, timeoutMs);
    }

    private static boolean inRange(
        Beacon beacon,
        Integer explicitMinRssi,
        double txPowerAt1m,
        double pathLoss,
        double maxDistance
    ) {
        if (explicitMinRssi != null) return strongest(beacon.samples) >= explicitMinRssi;
        return estimateDistance(beacon, txPowerAt1m, pathLoss) <= maxDistance;
    }

    private void resolveFound(PluginCall call, Beacon beacon, double distance, int minSamples) {
        JSObject found = new JSObject();
        found.put("found", true);
        found.put("token", beacon.token);
        found.put("rssi", strongest(beacon.samples));
        found.put("distanceMeters", round1(distance));
        found.put("samples", beacon.samples.size());
        found.put("confident", beacon.samples.size() >= minSamples);
        call.resolve(found);
    }

    private String scanFailureMessage(int errorCode) {
        switch (errorCode) {
            case ScanCallback.SCAN_FAILED_ALREADY_STARTED:
                return "A Bluetooth scan is already running";
            case ScanCallback.SCAN_FAILED_APPLICATION_REGISTRATION_FAILED:
                return "Bluetooth could not start a scan. Turn Bluetooth off and on again";
            case ScanCallback.SCAN_FAILED_FEATURE_UNSUPPORTED:
                return "This phone cannot scan for Bluetooth LE devices";
            default:
                return "Bluetooth scan failed (" + errorCode + ")";
        }
    }

    /**
     * Reads the session token from an advertisement.
     *
     * Service data is the Android-to-anything channel. The local name is the
     * fallback for an iPhone beacon, because iOS refuses to put service data in
     * an advertisement at all.
     */
    private String tokenFrom(ScanRecord record) {
        byte[] payload = record.getServiceData(SERVICE_UUID);
        if (payload != null && payload.length > 0) {
            return new String(payload, StandardCharsets.UTF_8).trim();
        }
        String name = record.getDeviceName();
        if (name != null && name.startsWith(NAME_PREFIX) && name.length() > NAME_PREFIX.length()) {
            return name.substring(NAME_PREFIX.length()).trim();
        }
        return null;
    }

    /**
     * Estimates how far away a beacon is, using the log-distance path loss
     * model: distance = 10 ^ ((power at one metre - observed) / (10 * n)).
     *
     * The strongest readings are the honest ones: a phone in a pocket or behind
     * a body only ever loses signal, never gains it. Taking the median of the
     * best few rejects both that attenuation and the occasional spike.
     */
    private static double estimateDistance(
        Beacon beacon,
        double defaultTxPowerAt1m,
        double pathLoss
    ) {
        if (beacon.samples.isEmpty()) return Double.MAX_VALUE;

        List<Integer> sorted = new ArrayList<>(beacon.samples);
        Collections.sort(sorted, Collections.reverseOrder());
        int considered = Math.min(3, sorted.size());
        double representative = sorted.get(considered / 2);

        double txPowerAt1m = defaultTxPowerAt1m;
        if (beacon.advertisedTxPower != null) {
            // Free-space loss over the first metre at 2.4 GHz is about 41 dB,
            // which converts a radio's declared output into what a scanner
            // should see one metre away.
            txPowerAt1m = beacon.advertisedTxPower - 41.0;
        }
        return Math.pow(10.0, (txPowerAt1m - representative) / (10.0 * pathLoss));
    }

    private static int strongest(List<Integer> samples) {
        int best = Integer.MIN_VALUE;
        for (int sample : samples) best = Math.max(best, sample);
        return best;
    }

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    private static double positive(Double value, double fallback) {
        return value == null || value <= 0 ? fallback : value;
    }

    private static int clamp(Integer value, int low, int high) {
        if (value == null) return low;
        return Math.max(low, Math.min(value, high));
    }

    private void stopScanning() {
        if (scanner != null && scanCallback != null) {
            try {
                scanner.stopScan(scanCallback);
            } catch (SecurityException ignored) {
                // As above: nothing useful to do if the permission vanished.
            }
        }
        scanCallback = null;
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopAdvertising();
        stopScanning();
    }
}
