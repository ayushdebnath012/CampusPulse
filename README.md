# CampusPulse

CampusPulse is a classroom operations app inspired by Acadly. This rollout contains the official Autumn 2026-2027 rosters for **Soft Computing (MF41601)** and **Knowledge Based Systems in Engineering (ME60353)**, with separate Professor, Teaching Assistant, and Student workspaces.

## Included

- Password sign-up and login with a required department, open to any working email address in all three roles
- Password hashing, bearer sessions, and role-based API authorization
- Separate private TA and Student join codes for every course, visible only to its professor owner
- A selected-course switcher that changes the full workspace together
- A shared weekly agenda with previous days, class topics, and sub-class breakdowns
- Professor-owned courses with professor/TA roster, schedule, and material management
- Attendance marking by the owning professor or an enrolled TA
- Quiz publishing by the owning professor/enrolled TAs and one-response student submissions
- A persistent notification inbox plus Android phone alerts when attendance opens or a quiz or material is posted
- Browser-local student CSV/ICS timetable import
- Persistent JSON storage locally and PostgreSQL storage in cloud deployments
- Bluetooth LE proximity attendance across Android and iOS, sized for a full lecture theatre
- Capacitor Android **and iOS** projects, native class reminders, and automated APK/IPA builds
- A browser version on GitHub Pages that shares the same API and accounts as the installed apps

## Run the complete app locally

```powershell
cd backend
npm.cmd install
$env:FACULTY_SIGNUP_CODE="choose-a-private-code"
$env:COURSE_OWNER_EMAILS_JSON='{"soft401":"professor@mech.iitkgp.ac.in","kbs60353":"professor@mech.iitkgp.ac.in"}'
npm.cmd start
```

Open `http://127.0.0.1:8787`. Password sign-up works without OTP. SMTP, Brevo, or Resend is optional and is used only by the emailed verification and password-recovery routes.

Run the backend test:

```powershell
cd backend
npm.cmd test
```

## Who can create an account

Any address that can receive mail works, in every role — an institute address, Gmail, Outlook, anything. Sign-up used to be restricted to `iitkgp.ac.in`, which locked out visiting staff, exchange students, and anyone whose institute account had not been issued yet.

Course access does not depend on the address. A student or TA still needs that course's private join code, and those codes are visible only to the professor who owns the course. Note the trade-off this makes: because the professor role no longer requires a departmental address, anyone with the sign-up form can register as a professor and create their own courses. They cannot reach an existing course without its code, but if you want professor accounts gated again, set `FACULTY_SIGNUP_CODE` back up or restore the domain rule in `isValidEmail`.

## Deploy the backend

The repository includes `render.yaml`, which creates a Node web service and PostgreSQL database:

[Deploy CampusPulse to Render](https://render.com/deploy?repo=https://github.com/ayushdebnath012/CampusPulse)

During deployment, configure the private invitation variables. Email variables are optional while password recovery is not being used:

- `RESEND_API_KEY`
- `EMAIL_FROM`, such as `CampusPulse <noreply@your-verified-domain.example>`
- `FACULTY_SIGNUP_CODE`, a private invitation code used to provision professor accounts
- `COURSE_OWNER_EMAILS_JSON`, mapping each existing course ID/code to its professor's verified email
- `COURSE_JOIN_CODES_JSON`, private enrollment codes for the existing courses
- `PROFESSOR_PROFILE_OVERRIDES_JSON`, a private mapping of professor emails to database-only phone/department corrections
- `FIREBASE_SERVICE_ACCOUNT_JSON`, the complete Firebase service-account JSON used only by the backend to send phone alerts

For example:

```json
{"soft401":"professor@mech.iitkgp.ac.in","kbs60353":"professor@mech.iitkgp.ac.in"}
```

Existing seeded courses are fail-closed until their owner email mapping resolves to a verified professor account. Newly created courses are automatically exclusive to the professor who creates them. Each course gets a Student join code and a different TA join code; only the professor owner can see them. Students and TAs must use the code for their role. Enrolled TAs can manage rosters, schedules, topics, materials, attendance, and quizzes. Only the professor owner can create courses or remove materials.

Production keeps `ALLOW_DEV_VERIFICATION_CODE=false`; direct password sign-up does not depend on email delivery. Render's free PostgreSQL database is suitable for a prototype but may have retention limits; select an appropriate paid database for long-term records.

On the GitHub Pages app or in the APK, open **Settings**, enter the deployed HTTPS API URL, save, and sign up.

## Enable Android phone alerts

The notification inbox works through the CampusPulse API without Firebase. To also receive attendance, quiz, and material alerts while the Android app is in the background or closed:

1. Create a Firebase project and add an Android app with package name `in.campuspulse.app`.
2. Download that app's `google-services.json` file. Do not commit it.
3. Encode the file in PowerShell and save the result as the GitHub Actions secret `FIREBASE_ANDROID_CONFIG_BASE64`:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))
   ```

4. In Firebase, create a service-account private key. Paste the complete JSON object, without base64 encoding, into the Render secret `FIREBASE_SERVICE_ACCOUNT_JSON`.
5. Redeploy the Render service and run the Android build workflow. Install that new APK once, then allow notifications when Android asks.

Keep both Firebase files private. The Android file identifies the Firebase project; the service-account JSON is a server credential and must never be included in an APK, commit, log, issue, or pull request.

## Private roster data

Student names and roll numbers are intentionally excluded from Git because this repository is public. Local development reads the verified data from the ignored file `backend/data/course-rosters.json`. For Render, encode that file and save the result in the secret `COURSE_ROSTERS_JSON_BASE64` configured by the blueprint:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("backend/data/course-rosters.json"))
```

Do not commit the roster file or paste the secret into source code, build logs, issues, or pull requests. If the secret is temporarily unavailable, existing roster data already stored in PostgreSQL is retained, but a new database will not expose a roster until the secret is configured.

## Build the APK

Every push to `main` runs `.github/workflows/build-android.yml`, which also publishes the built APK to a public download link (no GitHub login required) that always points at the latest build:

```text
https://github.com/ayushdebnath012/CampusPulse/releases/download/android-latest/CampusPulse.apk
```

You can also download the `CampusPulse-Android` workflow artifact (requires a GitHub login), or run locally on a machine with Java 21 and Android SDK 36:

```powershell
npm.cmd install
npm.cmd run android:build
```

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`.

### Automatic web updates

Android builds include a local fallback copy of the app and the Capacitor updater. Every push to `main` packages `public/` as a versioned ZIP, publishes it through GitHub Pages, and writes a SHA-256 protected update manifest. Installed Android copies check that manifest on launch, download a newer web bundle in the background, and apply it after the app is restarted or backgrounded. The update status and a **Restart and update** action are available in **Settings**.

Only HTML, CSS, and JavaScript changes can be delivered this way. Changes to Android code, permissions, Capacitor configuration, or native plugins require a new APK. Install version 1.5.0 once; later web-only changes can arrive through the in-app updater.

### Keep Android upgrades installable

Android only accepts an APK as an upgrade when it is signed by the same key as the installed copy. Configure these GitHub Actions secrets once and keep the keystore backed up securely:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Create the base64 secret from a private keystore with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("campuspulse-release.jks"))
```

When those secrets are present, the workflow produces a signed release APK. Without them it produces a debug APK for testing; debug artifacts from different GitHub runners are not guaranteed to install over one another.

## Build the iOS app

The Xcode project is committed at `ios/`, with both native plugins, their `Info.plist` permission strings, and plugin registration already wired in. Nothing has to be assembled by hand.

Every push to `main` runs `.github/workflows/build-ios.yml` on a macOS runner. Without any Apple credentials it still compiles the whole project for the simulator and uploads `CampusPulse-iOS-Simulator`, which is enough to catch a broken build. **A build you can install on a real iPhone needs a paid Apple Developer account** — that is Apple's rule, not a limitation of this project. Add these repository secrets and the same workflow also produces a signed `CampusPulse.ipa`:

- `IOS_CERTIFICATE_BASE64` — base64 of your exported `.p12` distribution certificate
- `IOS_CERTIFICATE_PASSWORD` — the password used when exporting it
- `IOS_PROVISIONING_PROFILE_BASE64` — base64 of a `.mobileprovision` for `in.campuspulse.app`
- `IOS_PROVISIONING_PROFILE_NAME` — that profile's name, exactly as Apple shows it
- `IOS_TEAM_ID` — your ten-character Apple team identifier
- `IOS_EXPORT_METHOD` — `ad-hoc`, `app-store`, or `enterprise` (defaults to `ad-hoc`)

Create the base64 secrets with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("distribution.p12"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("CampusPulse.mobileprovision"))
```

On a Mac you can build and run it directly:

```bash
npm install
npm run ios:sync
npm run ios:open   # then press Cmd+R in Xcode
```

Bluetooth does not work in the iOS Simulator. Proximity attendance has to be tested on real hardware.

## Use CampusPulse without installing anything

The browser version is the same app, built from the same `public/` directory and talking to the same API, so accounts, courses, attendance, and quizzes are shared with the installed apps:

```text
https://ayushdebnath012.github.io/CampusPulse/
```

It is the fallback for anyone who cannot install the app — including iPhone users, while a signed build is not yet distributed. Everything works there except Bluetooth proximity, which needs the native plugin: on the website a student cannot mark themselves present from the beacon, so use the app for attendance and the website for everything else.

## Attendance is per class, not per day

A register belongs to one class, so a course that meets twice on a Tuesday takes attendance twice and each starts from a blank roll. Every new day likewise opens on a fresh register rather than showing the previous one.

- Opening attendance without naming a class attaches it to whichever of today's scheduled classes is nearest to now, so the one-tap button still produces a properly keyed session.
- Repeating the *same* class on the same day is refused as a double-tap; the professor is pointed at **reopen** instead, which is how missed students are added after the fact.
- A closed session is only offered as "current" on the day it was held. After that it moves into history.
- **Previous classes** on the attendance screen lists every past register for the course, labelled with its date, its class time and topic, and the present count, so two classes on one day are never confused. Students see the same list, with their own attendance, under their attendance record.

## Bluetooth and location together

Two signals decide whether a mark is genuine, and each covers the other's weakness.

**Bluetooth proves the room.** A phone has to hear the beacon over the air, which nothing outside the building can fake. Its distance estimate is honest but noisy — RSSI swings by 10 dB or more as people move.

**Location proves the venue.** The professor's position is recorded when attendance opens, and every student's own fix is compared against it. This is the check that stops a mark being sent from a hostel room.

Location is compulsory on both sides: attendance will not open without a fix, and a student who refuses the permission cannot mark themselves present.

Because indoor GPS is only accurate to tens of metres, each reading's own error bar is subtracted before judging, and the radius is deliberately wider than a room — `ATTENDANCE_GEOFENCE_METRES`, 150 m by default. That is not sloppiness: wrongly rejecting a student who is genuinely sitting in the lecture is a worse failure than admitting someone in the corridor, and Bluetooth is what excludes the corridor. A student whose Bluetooth reading looks marginal but whose location agrees is still marked present, which is how the back row gets counted.

Both measurements are stored on the record, so a disputed mark can be examined instead of argued about.

## Bluetooth proximity attendance

When a professor opens attendance, their device advertises a rotating session token over Bluetooth LE. Student devices listen for it and send back what they heard, so a code never has to be read out and only a phone in the room can produce a valid token.

Range is judged by **estimated distance**, not by a raw signal reading. A scan samples the beacon for a couple of seconds and takes the median of the strongest readings, because a single packet's RSSI swings by 10 dB or more as someone shifts in a seat. The default limit is 30 m, chosen to reach the back row of a large lecture theatre: wrongly excluding a student who is actually in the class is worse than including someone just outside it, and walls cost a further 10–20 dB, so the corridor mostly falls outside the limit on its own. Adjust `ATTENDANCE_RANGE_METRES` in `public/app.js` to change it.

Android and iOS interoperate in both directions, which takes some care because iOS refuses to put service data in an advertisement:

| Beacon | Carries the token in | Read by |
| --- | --- | --- |
| Android | BLE service data | Android and iOS |
| iOS | the advertised local name (`CP` + token) | Android and iOS |

Android 11 and below also need `ACCESS_FINE_LOCATION` **and** Location switched on before a scan returns anything; the app now asks for both and says which one is missing instead of timing out silently.

## Running a class of 300

The API was rewritten to survive a whole hall signing in at once, which previously showed up as "could not fetch":

- Reads share one load. Requests arriving together no longer queue behind each other, and the loaded document is reused until a write moves it on.
- Writes are batched. Concurrent writes are applied to one loaded copy and saved once, so 300 sign-ins cost a handful of database round trips instead of 300. If a mutator fails, the batch is replayed one at a time so nobody else's write is lost.
- Uploaded files are no longer shipped on every request. Material bytes are projected out of the shared document and fetched only by the download route.
- Password hashing gets a wider thread pool, since libuv's default of four threads serialised sign-ins.
- The client retries with backoff and a timeout, so a free-tier instance waking from sleep no longer surfaces as a bare failure.

Measured locally with 300 concurrent students, sign-in went from 14.9 s to 4.7 s and bootstrap from 2.9 s to 1.6 s; against PostgreSQL over a network the gap is considerably larger, because the old code performed 300 sequential full-document reads and rewrites.

Two things to be aware of on Render's free plan: the instance sleeps after 15 minutes idle and takes roughly a minute to wake, and its CPU is throttled. If a class reliably starts at a fixed time, keep the service warm or move to a paid instance.

## If someone does not receive their code

Email providers cap how fast they accept mail — Resend's free plan allows two requests a second — and a class signing up together sails past that. Rejected sends were previously reported as successful, so those students never received anything. Sends are now paced to the provider's limit, retried on throttling, and logged by recipient when they fail. `GET /api/health` reports `emailRuntime` with queued/delivered/failed counts and the last error, so a missing code can be diagnosed without shell access.

If failures persist, check that `EMAIL_FROM` uses a domain you have verified with the provider. An unverified sender is rejected for every recipient except your own address.
