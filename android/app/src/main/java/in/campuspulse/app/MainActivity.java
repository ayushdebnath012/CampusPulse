package in.campuspulse.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceStatusPlugin.class);
        registerPlugin(ProximityPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
