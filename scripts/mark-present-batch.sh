#!/usr/bin/env bash
#
# Marks several students present on one register that has already been closed.
#
# The batch form of scripts/mark-present.sh. Same three calls the app's "Reopen
# to add students" button makes — reopen, add the roll, close again — but the
# reopen and the close happen ONCE for the whole list instead of once per
# student. That matters: closing a register notifies every student in the
# course of their own result, so correcting six students one at a time sends
# the whole class six notices for a class that is already over.
#
# Usage:
#   ./scripts/mark-present-batch.sh --email prof@example.edu --course MF41601 \
#     --date 2026-08-31 --roll 23ME31053 --roll 23MF10041 --roll 23MF10026
#
#   --api <url>            API base (default: https://campuspulse.duckdns.org)
#   --email <address>      Professor or TA login for the course
#   --role <faculty|ta>    Login role (default: faculty)
#   --course <code|name>   Course code, name, or id — punctuation and case ignored
#   --roll <number>        Roll to mark present. Repeat for each student.
#   --date <yyyy-mm-dd>    Class date. Required unless --session-id is given.
#   --session-id <id>      Use this register instead of matching on date
#   --dry-run              Read everything, show the register, change nothing
#   --yes                  Skip the confirmation prompt
#
# Rolls already present are skipped, not re-added. A roll that is not on the
# course roll list is reported and the run stops before anything is reopened —
# a partial correction is worse than none, because it leaves you unsure which
# half landed.
#
# The password is read from CAMPUSPULSE_PASSWORD, or prompted for silently, so
# it stays out of your shell history and the process list.
set -euo pipefail

# The apps read public/config.js, which serves the duckdns host since the AWS
# cutover. A correction filed against the retired Vercel host would land in a
# database no student is reading.
API="https://campuspulse.duckdns.org"
EMAIL=""; ROLE="faculty"; COURSE_WANTED=""; DATE=""; SESSION_WANTED=""
DRY_RUN=0; ASSUME_YES=0
ROLLS=""   # newline separated; bash 3.2 arrays under `set -u` are more trouble

while [ $# -gt 0 ]; do
  case "$1" in
    --api)        API="${2%/}"; shift 2 ;;
    --email)      EMAIL="$2"; shift 2 ;;
    --role)       ROLE="$2"; shift 2 ;;
    --course)     COURSE_WANTED="$2"; shift 2 ;;
    --roll)       ROLLS="$ROLLS$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')
"; shift 2 ;;
    --date)       DATE="$2"; shift 2 ;;
    --session-id) SESSION_WANTED="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --yes)        ASSUME_YES=1; shift ;;
    *) printf '\n\xe2\x9c\x96 Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

fail() { printf '\n\xe2\x9c\x96 %s\n' "$1" >&2; exit 1; }

ROLLS="$(printf '%s' "$ROLLS" | grep -v '^$' | sort -u || true)"

[ -n "$EMAIL" ]         || fail "Pass --email followed by your professor login"
[ "$ROLE" = "faculty" ] || [ "$ROLE" = "ta" ] || fail "--role must be faculty or ta, not \"$ROLE\""
[ -n "$COURSE_WANTED" ] || fail "Pass --course followed by the course code, name, or id"
[ -n "$ROLLS" ]         || fail "Pass at least one --roll followed by a roll number"
[ -n "$DATE" ] || [ -n "$SESSION_WANTED" ] || fail "Pass --date yyyy-mm-dd (or --session-id)"
if [ -n "$DATE" ] && ! printf '%s' "$DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  fail "--date must look like 2026-08-25, not \"$DATE\""
fi

TOKEN=""
RESP_BODY=""; RESP_STATUS=""
api() { # api METHOD ROUTE [JSON_BODY]
  local method="$1" route="$2" body="${3-}" raw
  local args=(-sS -X "$method" -w $'\n%{http_code}')
  [ -n "$TOKEN" ] && args+=(-H "authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(-H "content-type: application/json" -d "$body")
  raw="$(curl "${args[@]}" "$API$route")" || fail "Could not reach $API"
  RESP_STATUS="${raw##*$'\n'}"
  RESP_BODY="${raw%$'\n'*}"
}
ok() { [ "$RESP_STATUS" -ge 200 ] && [ "$RESP_STATUS" -lt 300 ]; }
err() { printf '%s' "$RESP_BODY" | jq -r '.error // empty' 2>/dev/null || true; }
uri() { jq -rn --arg v "$1" '$v|@uri'; }

if [ -z "${CAMPUSPULSE_PASSWORD:-}" ]; then
  read -r -s -p "CampusPulse password: " CAMPUSPULSE_PASSWORD
  printf '\n'
fi

api POST /api/auth/login "$(jq -nc --arg e "$EMAIL" --arg p "$CAMPUSPULSE_PASSWORD" --arg r "$ROLE" \
  '{email:$e,password:$p,role:$r}')"
ok || fail "Login failed ($RESP_STATUS): $(err)"
TOKEN="$(printf '%s' "$RESP_BODY" | jq -r '.token')"
printf 'Signed in as %s  (%s)\n\n' "$(printf '%s' "$RESP_BODY" | jq -r '.user.name')" "$API"

# ---- which course --------------------------------------------------------
api GET /api/courses
ok || fail "Could not list courses ($RESP_STATUS)"
needle="$(printf '%s' "$COURSE_WANTED" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
matches="$(printf '%s' "$RESP_BODY" | jq -r --arg needle "$needle" --arg raw "$COURSE_WANTED" '
  .courses[]
  | . as $c
  | (($c.courseCode // "") | ascii_downcase | gsub("[^a-z0-9]";"")) as $code
  | (($c.name // "")       | ascii_downcase | gsub("[^a-z0-9]";"")) as $name
  | select($code == $needle or $name == $needle or $c.id == $raw
           or ($code | contains($needle)) or ($name | contains($needle)))
  | "\($c.id)\t\($c.courseCode)\t\($c.name)"')"
if [ -z "$matches" ]; then
  fail "No course matches \"$COURSE_WANTED\" on this account. It has: $(printf '%s' "$RESP_BODY" \
    | jq -r '[.courses[] | "\(.courseCode) (\(.name))"] | join(", ") | if . == "" then "no courses" else . end')"
fi
if [ "$(printf '%s\n' "$matches" | wc -l)" -gt 1 ]; then
  fail "\"$COURSE_WANTED\" matches more than one course: $(printf '%s\n' "$matches" | cut -f2 | paste -sd, -). Use the exact code."
fi
COURSE_ID="$(printf '%s' "$matches" | cut -f1)"
COURSE_CODE="$(printf '%s' "$matches" | cut -f2)"
printf 'Course: %s — %s\n' "$COURSE_CODE" "$(printf '%s' "$matches" | cut -f3)"

# ---- which register ------------------------------------------------------
api GET "/api/attendance/past?courseId=$(uri "$COURSE_ID")"
ok || fail "Could not read the attendance history ($RESP_STATUS)"
PAST="$RESP_BODY"
if [ -n "$SESSION_WANTED" ]; then
  found="$(printf '%s' "$PAST" | jq -r --arg id "$SESSION_WANTED" '.sessions[] | select(.id == $id) | .id')"
else
  found="$(printf '%s' "$PAST" | jq -r --arg d "$DATE" '.sessions[] | select((.startedAt // "")[0:10] == $d) | .id')"
fi
if [ -z "$found" ]; then
  fail "No closed register for $COURSE_CODE on ${SESSION_WANTED:-$DATE}.

Most recent registers:
$(printf '%s' "$PAST" | jq -r '.sessions[0:12][] | "  \(.startedAt[0:10])  \(.present)/\(.total)  \(.id)"')"
fi
if [ "$(printf '%s\n' "$found" | wc -l)" -gt 1 ]; then
  fail "$COURSE_CODE has more than one register on $DATE:
$(printf '%s' "$PAST" | jq -r --arg d "$DATE" '.sessions[] | select((.startedAt // "")[0:10] == $d)
  | "  \(.classLabel // "unlabelled class")  \(.present)/\(.total)  --session-id \(.id)"')

Re-run with --session-id."
fi
SESSION_ID="$found"
REGISTER="$(printf '%s' "$PAST" | jq -c --arg id "$SESSION_ID" '.sessions[] | select(.id == $id)')"
TOTAL="$(printf '%s' "$REGISTER" | jq -r '.total')"

# The listing carries counts but not the roster, so read the register itself to
# find out which of these corrections are even needed.
api GET "/api/attendance/$(uri "$SESSION_ID")"
ok || fail "Could not read register $SESSION_ID ($RESP_STATUS)"
DETAIL="$RESP_BODY"

printf 'Register: %s on %s\n' \
  "$(printf '%s' "$REGISTER" | jq -r '.classLabel // "unlabelled class"')" \
  "$(printf '%s' "$REGISTER" | jq -r '.startedAt[0:10]')"
printf '          %s of %s present, closed %s\n\n' \
  "$(printf '%s' "$REGISTER" | jq -r '.present')" "$TOTAL" \
  "$(printf '%s' "$REGISTER" | jq -r '(.closedAt // "?")[0:16] | sub("T";" ")')"

# ---- classify every roll before changing anything ------------------------
TO_ADD=""; MISSING=""; ALREADY=""
while IFS= read -r roll; do
  [ -n "$roll" ] || continue
  record="$(printf '%s' "$DETAIL" | jq -c --arg r "$roll" '.attendance.records[]? | select(.rollNumber == $r)')"
  if [ -z "$record" ]; then
    MISSING="$MISSING  $roll — NOT ON THE $COURSE_CODE ROLL LIST
"
    continue
  fi
  name="$(printf '%s' "$record" | jq -r '.name // "name not on record"')"
  if [ "$(printf '%s' "$record" | jq -r '.present')" = "true" ]; then
    ALREADY="$ALREADY  $roll — $name — already present
"
  else
    TO_ADD="$TO_ADD$roll
"
    printf '  %s — %s — currently ABSENT\n' "$roll" "$name"
  fi
done <<EOF
$ROLLS
EOF

[ -n "$ALREADY" ] && printf '\nAlready correct, will be skipped:\n%s' "$ALREADY"
if [ -n "$MISSING" ]; then
  printf '\n'
  fail "These rolls are not on this register, so nothing was changed:
$MISSING
Add them on the Students tab first, then re-run. Nothing has been reopened."
fi
if [ -z "$TO_ADD" ]; then
  printf '\n\xe2\x9c\x93 Every roll is already present on this register. Nothing to change.\n'
  exit 0
fi
COUNT="$(printf '%s' "$TO_ADD" | grep -c '^' || true)"

# Reopening closes whatever else is open for this course, which would end a live
# register mid-class. Worth knowing before, not after.
api GET "/api/attendance/current?courseId=$(uri "$COURSE_ID")"
if ok && [ "$(printf '%s' "$RESP_BODY" | jq -r '.attendance.status // empty')" = "open" ]; then
  fail "$COURSE_CODE has a register open right now ($(printf '%s' "$RESP_BODY" | jq -r '.attendance.id')). Reopening this one would close it. Wait until that class is finished."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\nDry run — would reopen %s, add %s student(s), and close it again.\n' "$SESSION_ID" "$COUNT"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '\nMark %s student(s) present on %s %s?\n' "$COUNT" "$COURSE_CODE" "${DATE:-$SESSION_ID}"
  read -r -p "This reopens and re-closes the register once, which sends all $TOTAL students a notification of their own result for that class. Type yes to continue: " answer
  [ "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" = "yes" ] || fail "Cancelled — nothing was changed."
fi

# ---- the three steps the app's button makes, once for the whole list -----
api POST "/api/attendance/$(uri "$SESSION_ID")/reopen" '{}'
ok || fail "Could not reopen the register ($RESP_STATUS): $(err)"
printf '\n\xe2\x9c\x93 Reopened\n'

# From here the register is OPEN. Every path below must reach the close call,
# so a failed add is recorded and carried rather than exiting.
ADD_FAILED=""
while IFS= read -r roll; do
  [ -n "$roll" ] || continue
  api POST "/api/attendance/$(uri "$SESSION_ID")/add-student" "$(jq -nc --arg r "$roll" '{rollNumber:$r}')"
  if ok; then
    printf '\xe2\x9c\x93 %s marked present\n' "$roll"
  else
    printf '\xe2\x9c\x96 %s could not be added (%s): %s\n' "$roll" "$RESP_STATUS" "$(err)" >&2
    ADD_FAILED="$ADD_FAILED $roll"
  fi
done <<EOF
$TO_ADD
EOF

api POST "/api/attendance/$(uri "$SESSION_ID")/close" '{}'
if ! ok; then
  printf '\n\xe2\x9c\x96 The register would not close (%s): %s\n' "$RESP_STATUS" "$(err)" >&2
  printf '  It is still OPEN and students can check in. Close it in the app now.\n' >&2
  exit 1
fi
printf '\xe2\x9c\x93 Closed again\n\n'

# Read it back rather than trusting the writes: this is a graded record.
api GET "/api/attendance/$(uri "$SESSION_ID")"
ok || fail "Corrections were made but the register could not be read back. Check it in the app."
NOT_PRESENT=""
while IFS= read -r roll; do
  [ -n "$roll" ] || continue
  if [ "$(printf '%s' "$RESP_BODY" | jq -r --arg r "$roll" \
      '[.attendance.records[]? | select(.rollNumber == $r)][0].present // false')" != "true" ]; then
    NOT_PRESENT="$NOT_PRESENT $roll"
  fi
done <<EOF
$TO_ADD
EOF
count_now="$(printf '%s' "$RESP_BODY" | jq -r '[.attendance.records[]? | select(.present)] | length')"

[ -z "$NOT_PRESENT" ] || fail "These rolls still do not read as present:$NOT_PRESENT. Check the register in the app."
[ -z "$ADD_FAILED" ] || fail "The register is closed, but these rolls were never added:$ADD_FAILED"
printf '\xe2\x9c\x93 Verified: %s student(s) now present on %s %s. Register now %s of %s.\n' \
  "$COUNT" "$COURSE_CODE" "${DATE:-$SESSION_ID}" "$count_now" "$TOTAL"
