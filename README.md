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

### Getting it onto students' iPhones

The installed iOS app is still the strongest attendance path because it can hear the classroom Bluetooth beacon. Safari has no Web Bluetooth, so the website uses a separate same-network fallback: when the professor or an enrolled TA starts attendance, enrolled iPhone users automatically see the open session and can prove that their request came through the same classroom network while Safari verifies their precise location.

**TestFlight is the route for a class.** It takes up to 10,000 testers from a single public link, so students install Apple's TestFlight app, open the link, and get CampusPulse. Builds stay valid for 90 days.

1. Enrol in the [Apple Developer Program](https://developer.apple.com/programs/) (99 USD/year).
2. In App Store Connect, create an app record with the bundle identifier `in.campuspulse.app`.
3. Create a distribution certificate and an App Store provisioning profile, then add the six `IOS_*` secrets above, with `IOS_EXPORT_METHOD` set to `app-store`.
4. Under **Users and Access → Integrations**, create an App Store Connect API key and add three more secrets — a key avoids two-factor prompts in CI:
   - `APP_STORE_CONNECT_KEY_BASE64` — base64 of the downloaded `.p8`
   - `APP_STORE_CONNECT_KEY_ID`
   - `APP_STORE_CONNECT_ISSUER_ID`
5. Push to `main`. The workflow signs the build and uploads it to TestFlight, where you enable public link testing and share the link.

Until that account exists, iPhone users can sign in and mark attendance from the website as long as they are on the same classroom Wi-Fi used to open the register and both phones provide a sufficiently precise location. If either signal is unavailable, a professor or TA can still mark them from the roster.

**iOS push notifications need one more piece.** The push plugin returns an Apple APNs token, but the backend delivers through Firebase, which will not accept it. To make alerts work on iPhone you also need the Firebase iOS SDK added to the Xcode project, a `GoogleService-Info.plist`, and an APNs auth key uploaded to Firebase. Android push is unaffected.

## Use CampusPulse without installing anything

The browser version is the same app, built from the same `public/` directory and talking to the same API, so accounts, courses, attendance, and quizzes are shared with the installed apps:

```text
https://ayushdebnath012.github.io/CampusPulse/
```

It is the fallback for anyone who cannot install the app — including iPhone users, while a signed build is not yet distributed. The website cannot use Bluetooth proximity, but it can self-mark attendance through the classroom Wi-Fi and precise-location fallback described below.

## iPhone website attendance

Starting attendance once opens the same shared session for native apps and the website. Enrolled students already poll the API for an open register, so an iPhone user sees the attendance card automatically on the dashboard or Attendance page. No second register or iPhone-specific action is required from the professor or TA who opened it.

Website check-in is enabled only when the start request captures both a trustworthy client network and a sufficiently precise classroom location. The API stores a salted, session-specific fingerprint of the teaching device's network rather than the IP address itself. An iPhone check-in must then satisfy all of these checks:

- the student is signed in, enrolled, and bound to a roll-list entry;
- the request reaches the API through the same IPv4 address or IPv6 `/64` network used to start attendance;
- Safari supplies a location close enough to the professor's or TA's classroom fix; and
- the student's reported accuracy is at most `WEB_ATTENDANCE_MAX_ACCURACY_METRES` (100 m by default).

The mark is recorded as `student-web-wifi`, with separate network and location verification fields, so an export never presents it as Bluetooth evidence. If iCloud Private Relay changes Safari's public address, the student may need to turn off **Limit IP Address Tracking** for that classroom Wi-Fi. A campus-wide NAT can cover more than one room, so location remains mandatory; an institution with an Aruba, Cisco, or UniFi controller should eventually replace public-address comparison with access-point identity for stronger room-level proof.

## Attendance is per class, not per day

A register belongs to one class, so a course that meets twice on a Tuesday takes attendance twice and each starts from a blank roll. Every new day likewise opens on a fresh register rather than showing the previous one.

- Opening attendance without naming a class attaches it to whichever of today's scheduled classes is nearest to now, so the one-tap button still produces a properly keyed session.
- Repeating the *same* class on the same day is refused as a double-tap; the professor is pointed at **reopen** instead, which is how missed students are added after the fact.
- A closed session is only offered as "current" on the day it was held. After that it moves into history.
- **Previous classes** on the attendance screen lists every past register for the course, labelled with its date, its class time and topic, and the present count, so two classes on one day are never confused. Students see the same list, with their own attendance, under their attendance record.

## Reading and exporting attendance

Every register has a **Excel** button that downloads that class as an `.xlsx`: roll number, name, present or absent, when the mark was made, who made it, and what the two proximity signals measured. The file is written directly in the browser, so it works offline and on the website as well as in the app.

Tapping any student on the register opens their whole record for the course — running percentage, classes attended and missed, contact details once they have signed up, and every class the course has held with whether they were there. That record downloads as its own spreadsheet too. It is visible to the professor who owns the course and to enrolled TAs, and to nobody else; a student cannot open it, not even their own.

Classes held before a student appeared on the roll list are left out of their totals, so someone added mid-term does not start at zero percent.

## Exam marks

Each course decides what it assesses. A new course starts with six tests, a mid sem and an end sem, because that suits the courses this began with — but that is only a starting point. **Students → Exams** renames them, adds a viva or a project or a lab report, and removes what the course does not set. A mark is only ever stored against a roll number that is on the roll list.

Renaming an exam keeps the marks already recorded for it, because marks hang off a stable identifier rather than the name on screen. Removing an exam deletes its marks, which the app confirms first and the API reports back.

What each exam is marked out of is set in that same place, before any marks are entered. A total cannot be dropped below a mark already awarded — the student holding it is named rather than the score being quietly broken. Once a total is set, an upload no longer has to carry it.

Marks go in two ways. **Students → Exam marks** takes a whole exam from a spreadsheet: pick the exam, say what it is out of, and upload an `.xlsx` or `.csv` with a roll number column and a marks column. The marks column is found by name where possible and inferred from the numbers where not, because exported sheets rarely use the heading you expect. Anyone missing from the sheet keeps the mark they already had, so uploading part of a class is normal rather than destructive — and roll numbers that are not on the roster are reported back rather than quietly stored.

Individual marks are typed directly on a student's record. A blank clears a mark rather than storing a zero: not sitting an exam and scoring nothing are different things, and the difference shows in the totals.

A mark above what the exam is out of is refused, and the whole upload is rejected together rather than half applied.

Students see their own marks on their attendance screen, and only their own. The full grid is course-team only.

Both the register and the student list have a search box that matches on name or roll number. It ignores case, surrounding spaces, and punctuation inside a roll number, so `22-me-31034` and `22ME31034` find the same student. Searching filters what is shown without changing the present count, which still describes the whole class.

## Proximity and location together

Native and website check-ins use different proximity signals, and every record says which path was used.

**Bluetooth proves the room.** A phone has to hear the beacon over the air, which nothing outside the building can fake. Its distance estimate is honest but noisy — RSSI swings by 10 dB or more as people move.

**Location proves the venue.** The professor's or TA's position is recorded when attendance opens, and every student's own fix is compared against it. This is the check that stops a mark being sent from a hostel room.

**The website network check proves a shared access path.** Safari cannot reveal the SSID, BSSID, or Wi-Fi signal strength, so the API compares a salted fingerprint of the network path instead. This is weaker than Bluetooth on a campus-wide network, which is why website marks always require a precise location as well.

Location is asked for on both sides and used whenever it is available. It is not allowed to block the professor from opening a register or a native Bluetooth check-in, because an installed app may be unable to request permission. It is mandatory for website self-marking, where there is no beacon to fall back on. Every record stores which signals actually verified it.

Because indoor GPS is only accurate to tens of metres, each reading's own error bar is subtracted before judging, and the radius is deliberately wider than a room — `ATTENDANCE_GEOFENCE_METRES`, 150 m by default. Native attendance relies on Bluetooth to exclude the corridor. Website attendance instead rejects a student fix whose accuracy is worse than `WEB_ATTENDANCE_MAX_ACCURACY_METRES`, 100 m by default, and also requires the classroom network match.

Both measurements are stored on the record, so a disputed mark can be examined instead of argued about.

## Bluetooth proximity attendance

When a professor opens attendance, their device advertises a rotating session token over Bluetooth LE. Student devices listen for it and send back what they heard, so a code never has to be read out and only a phone in the room can produce a valid token.

Different courses can remain open at the same time. Opening another course adds its register to the teaching device's live set instead of replacing the first one, and closing one register leaves the others running. The Android foreground service cycles the BLE advertiser across every live course and keeps deriving fresh tokens while the phone is locked or another app is open. The in-app live bar shows any other registers still running. iOS can cycle multiple tokens while CampusPulse is active, but iOS may suspend third-party BLE advertising in the background; students using the iPhone website are unaffected because their shared Wi-Fi and location check-in is served by the open backend session.

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

Measured locally with 310 students taking a class end to end — sign-ups, sign-ins, the whole room marking attendance, then closing the register:

| Step | 310 students |
| --- | --- |
| Sign-ups | 3.5 s, all succeeded |
| Sign-ins | 4.5 s, all succeeded |
| Concurrent check-ins | 1.3 s, **all 310 marks persisted** |
| Closing the register | 53 ms |

For comparison, the old code took 14.9 s for 310 sign-ins on the same machine. Against PostgreSQL over a network the gap is far wider, because it performed 310 sequential full-document reads and rewrites.

Two things to be aware of on Render's free plan: the instance sleeps after 15 minutes idle and takes roughly a minute to wake, and its CPU is throttled. If a class reliably starts at a fixed time, keep the service warm or move to a paid instance.

### Testing it on a real deployment

`render.yaml` also defines `campuspulse-api-staging`, a throwaway copy on its own database. It sets `NODE_ENV=staging` and configures no email provider, so password sign-up works without an emailed code — which is what makes it possible to create a class of test accounts. Production deliberately cannot be put in that state: the bypass is gated on `NODE_ENV` not being `production`, so a live deployment always requires a real emailed code.

Deploy that service once, then:

```powershell
$env:CAMPUSPULSE_API="https://campuspulse-api-staging.onrender.com"
node scripts/load-test.mjs
```

It creates a professor, a course, 310 students, has them all mark attendance at once, reports timings, then deletes every account and the course. Cleanup runs even if a step fails, and everything it creates carries a unique tag so residue is identifiable. It refuses to run against the production host.

Never point it at production, and never give the staging service the production database or the roster secret.

## If someone does not receive their code

Email providers cap how fast they accept mail — Resend's free plan allows two requests a second — and a class signing up together sails past that. Rejected sends were previously reported as successful, so those students never received anything. Sends are now paced to the provider's limit, retried on throttling, and logged by recipient when they fail. `GET /api/health` reports `emailRuntime` with queued/delivered/failed counts and the last error, so a missing code can be diagnosed without shell access.

If failures persist, check that `EMAIL_FROM` uses a domain you have verified with the provider. An unverified sender is rejected for every recipient except your own address.
