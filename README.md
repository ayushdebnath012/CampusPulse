# CampusPulse

CampusPulse is a classroom operations app inspired by Acadly. This rollout contains the official Autumn 2026-2027 rosters for **Soft Computing (MF41601)** and **Knowledge Based Systems in Engineering (ME60353)**, with separate Professor, Teaching Assistant, and Student workspaces.

## Included

- Password sign-up and login with a required department; professors use `name@department.iitkgp.ac.in`
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
- Capacitor Android project, native class reminders, and automated APK builds

## Run the complete app locally

```powershell
cd backend
npm.cmd install
$env:FACULTY_SIGNUP_CODE="choose-a-private-code"
$env:TA_SIGNUP_CODE="choose-a-private-ta-code"
$env:COURSE_OWNER_EMAILS_JSON='{"soft401":"professor@mech.iitkgp.ac.in","kbs60353":"professor@mech.iitkgp.ac.in"}'
npm.cmd start
```

Open `http://127.0.0.1:8787`. Password sign-up works without OTP. SMTP or Resend is optional and is used only by the legacy verification and password-recovery routes.

Run the backend test:

```powershell
cd backend
npm.cmd test
```

## Deploy the backend

The repository includes `render.yaml`, which creates a Node web service and PostgreSQL database:

[Deploy CampusPulse to Render](https://render.com/deploy?repo=https://github.com/ayushdebnath012/CampusPulse)

During deployment, configure the private invitation variables. Email variables are optional while password recovery is not being used:

- `RESEND_API_KEY`
- `EMAIL_FROM`, such as `CampusPulse <noreply@your-verified-domain.example>`
- `FACULTY_SIGNUP_CODE`, a private invitation code used to provision professor accounts
- `TA_SIGNUP_CODE`, a private administrator code used to provision trusted TA accounts
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

Every push to `main` runs `.github/workflows/build-android.yml`. Download the `CampusPulse-Android` workflow artifact, or run locally on a machine with Java 21 and Android SDK 36:

```powershell
npm.cmd install
npm.cmd run android:build
```

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`.

### Automatic web updates

Android builds include a local fallback copy of the app and the Capacitor updater. Every push to `main` packages `public/` as a versioned ZIP, publishes it through GitHub Pages, and writes a SHA-256 protected update manifest. Installed Android copies check that manifest on launch, download a newer web bundle in the background, and apply it after the app is restarted or backgrounded. The update status and a **Restart and update** action are available in **Settings**.

Only HTML, CSS, and JavaScript changes can be delivered this way. Changes to Android code, permissions, Capacitor configuration, or native plugins require a new APK. Install version 1.4.2 once; later web-only changes can arrive through the in-app updater.

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
