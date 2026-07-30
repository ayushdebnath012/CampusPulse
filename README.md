# CampusPulse

A responsive classroom operations prototype inspired by attendance platforms such as Acadly. It includes:

- Bluetooth + Wi-Fi classroom readiness checks
- Faculty course creation with generated student join codes
- Student enrollment gates for attendance and quiz access
- Shared weekly course schedule for faculty, teaching assistants, and enrolled students
- Separate Professor, Teaching Assistant, and Student login workspaces
- Calendar-style weekly timetable shared across all three roles
- Local CSV/ICS timetable import for students without sharing ERP credentials
- Live, proximity-verified attendance simulation
- Student roster and attendance export
- Short live quiz creation and response tracking
- Review-before-upload ERP sync queue
- Persistent demo state using `localStorage`

## Run locally

```powershell
npm.cmd start
```

Then open `http://127.0.0.1:4173`.

For the production-compatible Next.js entrypoint:

```powershell
npm.cmd install
npm.cmd run build
```

## Production integration notes

The browser UI uses `navigator.onLine` and Web Bluetooth where supported. A production deployment should pair this frontend with:

1. A native mobile wrapper or managed classroom beacon SDK for reliable Wi-Fi SSID and Bluetooth proximity attestation.
2. An authenticated backend that signs check-in challenges, validates enrollment, and prevents replay/proxy attendance.
3. An ERP adapter that maps the normalized attendance and quiz payloads to the institution's API.
4. Role-based access, audit trails, consent/retention controls, and encryption in transit and at rest.

The ERP workflow is intentionally credential-free: student timetable files are parsed locally, and professors receive an ERP-ready attendance CSV for manual upload through the official portal.

## Demo the enrollment flow

1. Open **Classes** in Faculty view, or use the Soft Computing join code `SC401A`.
2. Use the login switch in the top-right to choose Faculty, Teaching Assistant, or Student.
3. Open **Classes**, enter the code, and join.
4. Attendance and course activities are now unlocked for that student.

Teaching Assistants can update quizzes and start attendance for Soft Computing. Only faculty can sync records to ERP.
