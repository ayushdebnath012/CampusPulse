const crypto = require("node:crypto");

const FIREBASE_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

// FCM only accepts string values in a data message. Keeping this conversion in
// the notifier also protects future callers that pass numbers or booleans.
function normalizeMessageData(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => {
        let normalized;
        if (typeof item === "string") normalized = item;
        else if (["number", "boolean", "bigint"].includes(typeof item)) {
          normalized = String(item);
        } else {
          try {
            normalized = JSON.stringify(item);
          } catch {
            normalized = String(item);
          }
        }
        return [String(key).slice(0, 100), normalized.slice(0, 4000)];
      })
      .filter(([key]) => key),
  );
}

function invalidRegistrationToken(status, payload) {
  const error = payload?.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  if (details.some((detail) => detail?.errorCode === "UNREGISTERED")) return true;
  const message = String(error.message || "");
  return (
    (status === 400 || status === 404) &&
    /registration token|requested entity was not found/i.test(message)
  );
}

function disabledNotifier(status = "disabled") {
  return {
    configured: false,
    provider: "firebase-http-v1",
    status,
    async send() {
      return { delivered: false, reason: status };
    },
  };
}

function createFirebaseNotifier(env = process.env, options = {}) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return disabledNotifier();

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    return disabledNotifier("invalid");
  }

  const projectId = String(serviceAccount?.project_id || "").trim();
  const clientEmail = String(serviceAccount?.client_email || "").trim();
  const privateKey = String(serviceAccount?.private_key || "").replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) return disabledNotifier("invalid");

  let signingKey;
  try {
    signingKey = crypto.createPrivateKey(privateKey);
  } catch {
    return disabledNotifier("invalid");
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") return disabledNotifier("unavailable");
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10_000);
  const requestSignal = () =>
    typeof globalThis.AbortSignal?.timeout === "function"
      ? globalThis.AbortSignal.timeout(timeoutMs)
      : undefined;

  let accessToken = "";
  let accessTokenExpiresAt = 0;
  let accessTokenRequest = null;

  async function getAccessToken() {
    if (accessToken && accessTokenExpiresAt > Date.now() + 60_000) return accessToken;
    if (!accessTokenRequest) {
      accessTokenRequest = (async () => {
        const issuedAt = Math.floor(Date.now() / 1000);
        const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const claims = base64Url(
          JSON.stringify({
            iss: clientEmail,
            scope: FIREBASE_SCOPE,
            aud: GOOGLE_TOKEN_URL,
            iat: issuedAt,
            exp: issuedAt + 3600,
          }),
        );
        const unsignedJwt = `${header}.${claims}`;
        const signature = crypto
          .sign("RSA-SHA256", Buffer.from(unsignedJwt), signingKey)
          .toString("base64url");
        const assertion = `${unsignedJwt}.${signature}`;
        const response = await fetchImpl(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          signal: requestSignal(),
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.access_token) {
          const error = new Error("Firebase authentication failed");
          error.status = response.status;
          throw error;
        }
        accessToken = String(payload.access_token);
        const expiresIn = Math.max(60, Number(payload.expires_in) || 3600);
        accessTokenExpiresAt = Date.now() + expiresIn * 1000;
        return accessToken;
      })();
    }
    try {
      return await accessTokenRequest;
    } finally {
      accessTokenRequest = null;
    }
  }

  return {
    configured: true,
    provider: "firebase-http-v1",
    status: "configured",
    async send({ token, title, body = "", data = {} }) {
      const bearerToken = await getAccessToken();
      const response = await fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
          },
          signal: requestSignal(),
          body: JSON.stringify({
            message: {
              token: String(token),
              notification: {
                title: String(title || "CampusPulse").slice(0, 120),
                body: String(body || "").slice(0, 500),
              },
              data: normalizeMessageData(data),
              android: {
                priority: "high",
                notification: {
                  channel_id: "campuspulse_events",
                  sound: "default",
                },
              },
              apns: { payload: { aps: { sound: "default" } } },
            },
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error("Firebase push delivery failed");
        error.status = response.status;
        error.invalidToken = invalidRegistrationToken(response.status, payload);
        throw error;
      }
      return { delivered: true, id: payload.name || "" };
    },
  };
}

module.exports = {
  createFirebaseNotifier,
  invalidRegistrationToken,
  normalizeMessageData,
};
