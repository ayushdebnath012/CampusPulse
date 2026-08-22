package in.campuspulse.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceStatusPlugin.class);
        registerPlugin(ProximityPlugin.class);
        super.onCreate(savedInstanceState);

        // Let the web app close an in-page detail or step through its own route
        // trail. It returns false only on Overview, where Android may exit.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge().getWebView();
                if (webView == null) {
                    exitApp();
                    return;
                }

                webView.evaluateJavascript(
                    "typeof window.campusPulseHandleBack === 'function'"
                        + " ? window.campusPulseHandleBack() : null",
                    handled -> {
                        if ("true".equals(handled)) return;
                        if ("false".equals(handled)) {
                            exitApp();
                            return;
                        }
                        // A cached bundle from before campusPulseHandleBack was
                        // added still gets the legacy WebView behavior.
                        if (webView.canGoBack()) webView.goBack();
                        else exitApp();
                    }
                );
            }

            private void exitApp() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }
}
