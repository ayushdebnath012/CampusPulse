# CampusPulse

CampusPulse is a classroom operations app inspired by Acadly. This rollout contains one course, **Soft Computing (CSE 401)**, with separate Professor, Teaching Assistant, and Student workspaces.

## Included

- Sign-up-first authentication with IIT KGP email validation and six-digit verification
- Password hashing, bearer sessions, and role-based API authorization
- Student enrollment with the private code `SC401A`
- A shared weekly schedule for professors, TAs, and students
- Wi-Fi + Bluetooth attendance readiness and enrolled-student check-in
- Quiz publishing by professors/TAs and one-response student submissions
- Professor-only ERP attendance CSV export
- Student CSV/ICS timetable import without storing ERP credentials
- Persistent JSON storage locally and PostgreSQL storage in cloud deployments
- Capacitor Android project and automated APK build

## Run the complete app locally

```powershell
cd backend
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:8787`. When SMTP or Resend is not configured, the development verification code is shown on the verification screen.

Run the backend test:

```powershell
cd backend
npm.cmd test
```

## Deploy the backend

The repository includes `render.yaml`, which creates a Node web service and PostgreSQL database:

[Deploy CampusPulse to Render](https://render.com/deploy?repo=https://github.com/ayushdebnath012/CampusPulse)

After deployment, add these optional Render environment variables for actual email delivery:

- `RESEND_API_KEY`
- `EMAIL_FROM`, such as `CampusPulse <noreply@your-verified-domain.example>`

For production, set `ALLOW_DEV_VERIFICATION_CODE=false` after email delivery is working. Render's free PostgreSQL database is suitable for a prototype but expires after 30 days; select a paid database for long-term records.

On the GitHub Pages app or in the APK, open **Settings**, enter the deployed HTTPS API URL, save, and sign up.

## Build the APK

Every push to `main` runs `.github/workflows/build-android.yml`. Download the `CampusPulse-Android` workflow artifact, or run locally on a machine with Java 21 and Android SDK 36:

```powershell
npm.cmd install
npm.cmd run android:build
```

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`.

## ERP boundary

CampusPulse does not store IIT KGP ERP passwords or reuse browser session IDs. Students can import a timetable file locally, and only the professor can download the normalized attendance CSV and upload it through the official ERP portal. Direct ERP writes require an institute-approved API or service account.
