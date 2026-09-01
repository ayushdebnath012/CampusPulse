# CampusPulse iOS

Open this file in Xcode:

```text
ios/App/App.xcodeproj
```

The runnable scheme is `App`.

## Run on an iOS Simulator

From the repository root:

```bash
npm install
npm run ios:open
```

Then choose an iPhone simulator in Xcode and press Run.

You can also compile the simulator build from Terminal:

```bash
npm run ios:build:simulator
```

## Run on a Real iPhone

1. Open `ios/App/App.xcodeproj` in Xcode.
2. Select the `App` target.
3. In Signing & Capabilities, choose your Apple Developer team.
4. Connect your iPhone, select it as the run destination, and press Run.

The app bundle id is `in.campuspulse.app`. A real-device install requires Apple signing. Push notifications on iPhone also require Firebase iOS/APNs setup; the rest of the app can run without that extra push setup.
