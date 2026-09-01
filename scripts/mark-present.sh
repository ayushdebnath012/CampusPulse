#!/usr/bin/env bash
#
# Marks one student present on a register that has already been closed.
#
# A curl port of scripts/mark-present.mjs, for machines with no Node installed.
# It makes exactly the same three calls the app's "Reopen to add students"
# button makes: reopen, add the roll, close again.
#
# Usage:
#   ./scripts/mark-present.sh --email prof@example.edu --course MF41601 \
#     --roll 23ME10094 --date 2026-08-25
#
#   --api <url>            API base (default: https://campuspulse-api-ayush.vercel.app)
#   --email <address>      Professor or TA login for the course
#   --role <faculty|ta>    Login role (default: faculty)
#   --course <code|name>   Course code, name, or id — punctuation and case ignored
#   --roll <number>        Roll number to mark present
#   --date <yyyy-mm-dd>    Class date. Defaults to the most recent Tuesday.
#   --session-id <id>      Use this register instead of matching on date
#   --dry-run              Read everything, show the register, change nothing
#   --yes                  Skip the confirmation prompt
#
# Closing a register notifies every student in the course of their own result,
# so this sends the whole class a fresh attendance notice for an old class.
#
# The password is read from CAMPUSPULSE_PASSWORD, or prompted for silently, so
# it stays out of your shell history and the process list.
set -euo pipefail

API="https://campuspulse-api-ayush.vercel.app"
EMAIL=""; ROLE="faculty"; COURSE_WANTED=""; ROLL=""; DATE=""; SESSION_WANTED=""
DRY_RUN=0; ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --api)        API="${2%/}"; shift 2 ;;
    --email)      EMAIL="$2"; shift 2 ;;
    --role)       ROLE="$2"; shift 2 ;;
    --course)     COURSE_WANTED="$2"; shift 2 ;;
    --roll)       ROLL="$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"; shift 2 ;;
    --date)       DATE="$2"; shift 2 ;;
    --session-id) SESSION_WANTED="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --yes)        ASSUME_YES=1; shift ;;
    *) printf '\n\xe2\x9c\x96 Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

fail() { printf '\n\xe2\x9c\x96 %s\n' "$1" >&2; exit 1; }

[ -n "$EMAIL" ]         || fail "Pass --email followed by your professor login"
[ "$ROLE" = "faculty" ] || [ "$ROLE" = "ta" ] || fail "--role must be faculty or ta, not \"$ROLE\""
[ -n "$COURSE_WANTED" ] || fail "Pass --course followed by the course code, name, or id"
[ -n "$ROLL" ]          || fail "Pass --roll followed by the roll number to mark present"

# The most recent Tuesday, today included, in UTC — registers are matched on the
# UTC half of startedAt, which is how the app decides what counts as today.
if [ -z "$DATE" ] && [ -z "$SESSION_WANTED" ]; then
  back=$(( ( $(date -u +%u) - 2 + 7 ) % 7 ))
  DATE="$(date -u -v-${back}d +%Y-%m-%d)"
  printf 'No --date given — using the most recent Tuesday, %s.\n\n' "$DATE"
fi
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
printf 'Signed in as %s\n\n' "$(printf '%s' "$RESP_BODY" | jq -r '.user.name')"

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
$(printf '%s' "$PAST" | jq -r '.sessions[0:8][] | "  \(.startedAt[0:10])  \(.present)/\(.total)  \(.id)"')"
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
# find out whether this correction is even needed.
api GET "/api/attendance/$(uri "$SESSION_ID")"
ok || fail "Could not read register $SESSION_ID ($RESP_STATUS)"
RECORD="$(printf '%s' "$RESP_BODY" | jq -c --arg r "$ROLL" '.attendance.records[]? | select(.rollNumber == $r)')"
[ -n "$RECORD" ] || fail "$ROLL is not on this register. They are not on the $COURSE_CODE roll list — add them on the Students tab first, then re-run."

printf 'Register: %s on %s\n' \
  "$(printf '%s' "$REGISTER" | jq -r '.classLabel // "unlabelled class"')" \
  "$(printf '%s' "$REGISTER" | jq -r '.startedAt[0:10]')"
printf '          %s of %s present, closed %s\n' \
  "$(printf '%s' "$REGISTER" | jq -r '.present')" "$TOTAL" \
  "$(printf '%s' "$REGISTER" | jq -r '(.closedAt // "?")[0:16] | sub("T";" ")')"
printf 'Student:  %s — %s — currently %s\n\n' "$ROLL" \
  "$(printf '%s' "$RECORD" | jq -r '.name // "name not on record"')" \
  "$(printf '%s' "$RECORD" | jq -r 'if .present then "PRESENT" else "ABSENT" end')"

if [ "$(printf '%s' "$RECORD" | jq -r '.present')" = "true" ]; then
  printf '\xe2\x9c\x93 Already marked present on this register. Nothing to change.\n'
  exit 0
fi

# Reopening closes whatever else is open for this course, which would end a live
# register mid-class. Worth knowing before, not after.
api GET "/api/attendance/current?courseId=$(uri "$COURSE_ID")"
if ok && [ "$(printf '%s' "$RESP_BODY" | jq -r '.attendance.status // empty')" = "open" ]; then
  fail "$COURSE_CODE has a register open right now ($(printf '%s' "$RESP_BODY" | jq -r '.attendance.id')). Reopening this one would close it. Wait until that class is finished."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'Dry run — would reopen %s, add %s, and close it again.\n' "$SESSION_ID" "$ROLL"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Mark %s present on %s %s?\n' "$ROLL" "$COURSE_CODE" "$DATE"
  read -r -p "This reopens and re-closes the register, which sends all $TOTAL students a notification of their own result for that class. Type yes to continue: " answer
  [ "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" = "yes" ] || fail "Cancelled — nothing was changed."
fi

# ---- the three steps the app's button makes ------------------------------
api POST "/api/attendance/$(uri "$SESSION_ID")/reopen" '{}'
ok || fail "Could not reopen the register ($RESP_STATUS): $(err)"
printf '\xe2\x9c\x93 Reopened\n'

api POST "/api/attendance/$(uri "$SESSION_ID")/add-student" "$(jq -nc --arg r "$ROLL" '{rollNumber:$r}')"
if ! ok; then
  printf '\xe2\x9c\x96 Could not add %s (%s): %s\n' "$ROLL" "$RESP_STATUS" "$(err)" >&2
  printf '  The register is still OPEN. Close it in the app, or re-run once that is fixed.\n' >&2
  exit 1
fi
printf '\xe2\x9c\x93 %s marked present\n' "$ROLL"

api POST "/api/attendance/$(uri "$SESSION_ID")/close" '{}'
if ! ok; then
  printf '\xe2\x9c\x96 %s was marked, but the register would not close (%s).\n' "$ROLL" "$RESP_STATUS" >&2
  printf '  It is still open and students can check in. Close it in the app now.\n' >&2
  exit 1
fi
printf '\xe2\x9c\x93 Closed again\n\n'

# Read it back rather than trusting the write: this is a graded record.
api GET "/api/attendance/$(uri "$SESSION_ID")"
present_now="$(printf '%s' "$RESP_BODY" | jq -r --arg r "$ROLL" '[.attendance.records[]? | select(.rollNumber == $r)][0].present // false')"
count_now="$(printf '%s' "$RESP_BODY" | jq -r '[.attendance.records[]? | select(.present)] | length')"
[ "$present_now" = "true" ] || fail "$ROLL still does not read as present. Check the register in the app."
printf '\xe2\x9c\x93 Verified: %s is present on %s %s. Register now %s of %s.\n' \
  "$ROLL" "$COURSE_CODE" "$DATE" "$count_now" "$TOTAL"
