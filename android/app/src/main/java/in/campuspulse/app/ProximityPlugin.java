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
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
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
import java.util.List;
import java.util.UUID;

/**
 * Proximity attendance over Bluetooth LE.
 *
 * The teaching device advertises a short session token under a fixed service
 * UUID. Student devices scan for that UUID and read the token straight off the
 * air, so nothing is typed and only a phone within Bluetooth range can hear it.
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
        )
    }
)
public class ProximityPlugin extends Plugin {
    private static final ParcelUuid SERVICE_UUID =
        ParcelUuid.fromString("0000c9a1-0000-1000-8000-00805f9b34fb");
    /** Anything weaker than this is treated as out of the room. */
    private static final int DEFAULT_MIN_RSSI = -85;

    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** What to resume once the user answers the "turn Bluetooth on" system prompt. */
    private Runnable pendingBluetoothAction;

    private BluetoothAdapter adapter() {
        BluetoothManager manager =
            (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    // Apps cannot silently flip the radio, but we can trigger the system's own
    // enable dialog so the professor/student only has to tap "Allow" once.
    private void ensureBluetoothOn(PluginCall call, Runnable action) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This device does not support Bluetooth");
            return;
        }
        if (adapter.isEnabled()) {
            action.run();
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
        BluetoothAdapter adapter = adapter();
        if (adapter != null && adapter.isEnabled() && action != null) {
            action.run();
        } else {
            call.reject("Turn Bluetooth on to continue");
        }
    }

    private boolean needsRuntimePermission(String alias) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState(alias) != PermissionState.GRANTED;
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        JSObject result = new JSObject();
        boolean enabled = adapter != null && adapter.isEnabled();
        result.put("available", adapter != null);
        result.put("enabled", enabled);
        result.put(
            "canAdvertise",
            enabled && adapter.getBluetoothLeAdvertiser() != null
        );
        result.put("canScan", enabled && adapter.getBluetoothLeScanner() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void startBeacon(PluginCall call) {
        if (needsRuntimePermission("advertise")) {
            requestPermissionForAlias("advertise", call, "advertisePermissionCallback");
            return;
        }
        beginAdvertising(call);
    }

    @PermissionCallback
    private void advertisePermissionCallback(PluginCall call) {
        if (needsRuntimePermission("advertise")) {
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
        if (!adapter.isEnabled()) {
            ensureBluetoothOn(call, () -> continueAdvertising(call, token));
            return;
        }
        continueAdvertising(call, token);
    }

    private void continueAdvertising(PluginCall call, String token) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
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
            .addServiceUuid(SERVICE_UUID)
            .addServiceData(SERVICE_UUID, payload)
            .build();

        advertiseCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                JSObject result = new JSObject();
                result.put("advertising", true);
                call.resolve(result);
            }

            @Override
            public void onStartFailure(int errorCode) {
                advertiseCallback = null;
                call.reject("Could not start the Bluetooth beacon (" + errorCode + ")");
            }
        };

        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
        } catch (SecurityException error) {
            advertiseCallback = null;
            call.reject("Nearby devices permission is required to broadcast attendance");
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

    @PluginMethod
    public void scanForBeacon(PluginCall call) {
        if (needsRuntimePermission("scan")) {
            requestPermissionForAlias("scan", call, "scanPermissionCallback");
            return;
        }
        beginScan(call);
    }

    @PermissionCallback
    private void scanPermissionCallback(PluginCall call) {
        if (needsRuntimePermission("scan")) {
            call.reject("Nearby devices permission is required to find the class");
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
        if (!adapter.isEnabled()) {
            ensureBluetoothOn(call, () -> continueScanning(call));
            return;
        }
        continueScanning(call);
    }

    private void continueScanning(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
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

        int timeoutMs = call.getInt("timeoutMs", 8000);
        int minRssi = call.getInt("minRssi", DEFAULT_MIN_RSSI);

        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(SERVICE_UUID).build());
        ScanSettings settings = new ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build();

        final boolean[] settled = { false };

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (settled[0] || result.getScanRecord() == null) return;
                byte[] payload = result.getScanRecord().getServiceData(SERVICE_UUID);
                if (payload == null || payload.length == 0) return;
                // A weak signal means another room, so it does not count.
                if (result.getRssi() < minRssi) return;

                settled[0] = true;
                stopScanning();
                JSObject found = new JSObject();
                found.put("token", new String(payload, StandardCharsets.UTF_8));
                found.put("rssi", result.getRssi());
                found.put("found", true);
                call.resolve(found);
            }

            @Override
            public void onScanFailed(int errorCode) {
                if (settled[0]) return;
                settled[0] = true;
                stopScanning();
                call.reject("Bluetooth scan failed (" + errorCode + ")");
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
            JSObject missed = new JSObject();
            missed.put("found", false);
            call.resolve(missed);
        }, Math.max(2000, Math.min(timeoutMs, 30000)));
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
        stopAdvertising();
        stopScanning();
    }
}
