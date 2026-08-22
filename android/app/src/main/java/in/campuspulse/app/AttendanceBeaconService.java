package in.campuspulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Keeps the attendance beacon on the air while the app is not.
 *
 * The token students scan for is derived from a per-session secret and the
 * wall clock, and it changes every thirty seconds; the server accepts only the
 * current window and the one before it. That was fine while the register was on
 * screen, because the web layer refreshed the token on a timer — but Android
 * suspends a WebView's timers the moment the activity goes away, so a professor
 * who locked their phone, or simply opened another app, went on advertising a
 * token that expired within the minute. Every student who tapped "Mark me
 * present" after that was told their code was wrong.
 *
 * Rotating the token here fixes that at the root. The service holds the secret
 * and derives each window's token exactly as the server does, so a locked phone
 * in a pocket keeps a valid beacon in the air with no network of its own. A
 * foreground service is what buys the process the right to keep running and to
 * keep advertising; the notification it is obliged to post is useful in its own
 * right, since it is the one place a register left open all afternoon is
 * visible, and it carries the control to stop it.
 */
public class AttendanceBeaconService extends Service {

    public interface Listener {
        /** The radio is up, with the transmit power actually in effect. */
        void onAdvertising(int txPower, String token);

        /** Advertising could not start, or stopped being possible. */
        void onFailure(String message);
    }

    static final String ACTION_START = "in.campuspulse.app.BEACON_START";
    static final String ACTION_STOP = "in.campuspulse.app.BEACON_STOP";

    static final String EXTRA_SECRET = "secret";
    static final String EXTRA_TOKEN = "token";
    static final String EXTRA_WINDOW_MS = "windowMs";
    static final String EXTRA_DIGITS = "digits";
    static final String EXTRA_SKEW_MS = "clockSkewMs";
    static final String EXTRA_LABEL = "label";
    static final String EXTRA_MAX_MS = "maxDurationMs";

    private static final ParcelUuid SERVICE_UUID =
        ParcelUuid.fromString("0000c9a1-0000-1000-8000-00805f9b34fb");

    private static final String CHANNEL_ID = "attendance_beacon";
    private static final int NOTIFICATION_ID = 4711;

    /**
     * A register nobody closes would otherwise advertise until the phone is
     * rebooted. Four hours covers any single teaching session with room to
     * spare, and the web app stops the service the moment attendance closes.
     */
    private static final long DEFAULT_MAX_DURATION_MS = 4L * 60 * 60 * 1000;

    /**
     * Land just inside the new window rather than on its edge. Arriving early
     * would advertise a token the server has not started accepting yet, while
     * arriving a fraction late is free: the previous window stays valid.
     */
    private static final long ROTATION_GUARD_MS = 200;

    private static volatile Listener listener;
    private static volatile boolean running;
    private static volatile String currentToken = "";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private BluetoothLeAdvertiser advertiser;
    private AdvertiseCallback advertiseCallback;

    private String secret = "";
    private String fixedToken = "";
    private String label = "";
    private long windowMs = 30000;
    private int digits = 6;
    private long skewMs = 0;
    private long endsAt = 0;

    // MARK: - What the plugin can see from outside

    static void setListener(Listener next) {
        listener = next;
    }

    static boolean isRunning() {
        return running;
    }

    static String currentToken() {
        return currentToken;
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, AttendanceBeaconService.class);
        intent.setAction(ACTION_STOP);
        try {
            context.startService(intent);
        } catch (IllegalStateException | SecurityException ignored) {
            // Nothing was running, or we may no longer start it. Either way
            // there is nothing left to stop.
        }
    }

    // MARK: - Service lifecycle

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        secret = valueOrEmpty(intent.getStringExtra(EXTRA_SECRET));
        fixedToken = valueOrEmpty(intent.getStringExtra(EXTRA_TOKEN));
        label = valueOrEmpty(intent.getStringExtra(EXTRA_LABEL));
        windowMs = Math.max(1000, intent.getLongExtra(EXTRA_WINDOW_MS, 30000));
        digits = Math.max(4, Math.min(20, intent.getIntExtra(EXTRA_DIGITS, 6)));
        skewMs = intent.getLongExtra(EXTRA_SKEW_MS, 0);
        long maxMs = intent.getLongExtra(EXTRA_MAX_MS, DEFAULT_MAX_DURATION_MS);
        endsAt = System.currentTimeMillis() + Math.max(60000, maxMs);

        // The five-second deadline for this starts the moment the service does,
        // so the notification goes up before anything that can fail is tried.
        startInForeground();

        if (secret.isEmpty() && fixedToken.isEmpty()) {
            report("No attendance token to broadcast");
            stopSelf();
            return START_NOT_STICKY;
        }

        running = true;
        handler.removeCallbacksAndMessages(null);
        rotate();
        // The secret rides in the intent, so a process the system rebuilds gets
        // its class back rather than a beacon with nothing to broadcast.
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        running = false;
        currentToken = "";
        handler.removeCallbacksAndMessages(null);
        stopAdvertising();
        super.onDestroy();
    }

    // MARK: - Token rotation

    private void rotate() {
        if (System.currentTimeMillis() > endsAt) {
            // A session this long was left open by accident. Stop rather than
            // let a stale register keep taking marks.
            report("Attendance broadcasting stopped after four hours");
            stopSelf();
            return;
        }

        String token = secret.isEmpty() ? fixedToken : tokenForNow();
        if (!token.equals(currentToken) || advertiseCallback == null) {
            currentToken = token;
            advertise(token);
        }

        // A fixed token has nothing to rotate to, but the clock still has to be
        // watched so the session can time out.
        long delay = secret.isEmpty() ? windowMs : millisUntilNextWindow();
        handler.postDelayed(this::rotate, delay);
    }

    private long millisUntilNextWindow() {
        long now = System.currentTimeMillis() + skewMs;
        long next = ((now / windowMs) + 1) * windowMs;
        return Math.max(250, next - now + ROTATION_GUARD_MS);
    }

    /**
     * The same derivation the server uses: SHA-256 over "secret:window", hex,
     * first few characters, upper case. Both sides key off the wall clock, so
     * neither has to tell the other anything once the secret is handed over.
     */
    private String tokenForNow() {
        long window = (System.currentTimeMillis() + skewMs) / windowMs;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(
                (secret + ":" + window).getBytes(StandardCharsets.UTF_8)
            );
            StringBuilder hex = new StringBuilder(digits);
            for (int i = 0; i < hash.length && hex.length() < digits; i += 1) {
                hex.append(Character.forDigit((hash[i] >> 4) & 0xf, 16));
                if (hex.length() < digits) {
                    hex.append(Character.forDigit(hash[i] & 0xf, 16));
                }
            }
            return hex.toString().toUpperCase(java.util.Locale.US);
        } catch (Exception error) {
            // SHA-256 is required of every Android platform; there is no
            // sensible recovery if it is genuinely missing.
            return "";
        }
    }

    // MARK: - Advertising

    private BluetoothAdapter adapter() {
        BluetoothManager manager =
            (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private void advertise(String token) {
        stopAdvertising();

        BluetoothAdapter adapter = adapter();
        boolean enabled;
        try {
            enabled = adapter != null && adapter.isEnabled();
        } catch (SecurityException error) {
            enabled = false;
        }
        if (!enabled) {
            // Bluetooth went off mid-class. Say so, but keep the rotation
            // running: switching it back on then resumes without a restart.
            report("Turn Bluetooth on to keep broadcasting attendance");
            return;
        }

        BluetoothLeAdvertiser next = adapter.getBluetoothLeAdvertiser();
        if (next == null) {
            report("This device cannot broadcast over Bluetooth LE");
            return;
        }
        advertiser = next;

        byte[] payload = token.getBytes(StandardCharsets.UTF_8);
        if (payload.length == 0 || payload.length > 20) {
            report("That session token is too long to broadcast");
            return;
        }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(false)
            .build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(true)
            .addServiceUuid(SERVICE_UUID)
            .addServiceData(SERVICE_UUID, payload)
            .build();

        AdvertiseCallback callback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                Listener target = listener;
                if (target != null) {
                    target.onAdvertising(settingsInEffect.getTxPowerLevel(), token);
                }
            }

            @Override
            public void onStartFailure(int errorCode) {
                advertiseCallback = null;
                report(advertiseFailureMessage(errorCode));
            }
        };

        try {
            advertiser.startAdvertising(settings, data, callback);
            advertiseCallback = callback;
        } catch (SecurityException error) {
            advertiseCallback = null;
            report("Nearby devices permission is required to broadcast attendance");
        }
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

    private String advertiseFailureMessage(int errorCode) {
        switch (errorCode) {
            case AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE:
                return "The attendance broadcast did not fit in a Bluetooth advertisement";
            case AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS:
                return "Bluetooth is busy broadcasting for other apps. Close one and try again";
            case AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED:
                return "Attendance is already being broadcast";
            case AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED:
                return "This phone cannot broadcast over Bluetooth LE. Mark students from the list instead";
            default:
                return "Could not start the Bluetooth beacon (" + errorCode + ")";
        }
    }

    private void report(String message) {
        Listener target = listener;
        if (target != null) target.onFailure(message);
    }

    // MARK: - The notification the service is obliged to post

    private void startInForeground() {
        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Attendance broadcast",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(
                "Shown while your phone is broadcasting an open attendance register."
            );
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openRegister = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Intent stop = new Intent(this, AttendanceBeaconService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopBroadcast = PendingIntent.getService(
            this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_campuspulse)
            .setContentTitle(
                label.isEmpty() ? "Attendance is open" : "Attendance is open · " + label
            )
            .setContentText("Students nearby can mark themselves present.")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openRegister)
            .addAction(0, "Stop broadcasting", stopBroadcast)
            .build();

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
    }

    private static String valueOrEmpty(String value) {
        return value == null ? "" : value;
    }
}
