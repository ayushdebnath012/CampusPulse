package in.campuspulse.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "DeviceStatus",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        )
    }
)
public class DeviceStatusPlugin extends Plugin {
    @PluginMethod
    public void checkWifi(PluginCall call) {
        ConnectivityManager manager =
            (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        Network activeNetwork = manager.getActiveNetwork();
        NetworkCapabilities capabilities =
            activeNetwork == null ? null : manager.getNetworkCapabilities(activeNetwork);
        boolean connected =
            capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        JSObject result = new JSObject();
        result.put("connected", connected);
        call.resolve(result);
    }

    @PluginMethod
    public void checkBluetooth(PluginCall call) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            getPermissionState("bluetooth") != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                "bluetooth",
                call,
                "bluetoothPermissionCallback"
            );
            return;
        }
        resolveBluetooth(call);
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Nearby devices permission is required to verify Bluetooth");
            return;
        }
        resolveBluetooth(call);
    }

    private void resolveBluetooth(PluginCall call) {
        BluetoothManager manager =
            (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        JSObject result = new JSObject();
        result.put("available", adapter != null);
        result.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(result);
    }
}
