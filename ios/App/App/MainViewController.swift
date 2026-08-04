import UIKit
import Capacitor

/// Hosts the Capacitor web view and registers the plugins that live in this app
/// target rather than in a Swift package.
///
/// Capacitor discovers packaged plugins on its own, but plugins compiled into
/// the app have to be handed to the bridge explicitly. `capacitorDidLoad` is the
/// documented place to do it: it runs after the bridge exists and before the web
/// view loads, so the first call from JavaScript already finds them.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ProximityPlugin())
        bridge?.registerPluginInstance(DeviceStatusPlugin())
    }
}
