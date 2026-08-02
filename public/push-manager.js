(() => {
  "use strict";

  const REGISTRATION_KEY = "campusPulsePushRegistration";
  const COURSE_EVENTS_CHANNEL_ID = "campuspulse_events";
  const POLL_INTERVAL_MS = 30000;
  const MAX_INBOX_ITEMS = 50;
  const ROUTES = new Set([
    "dashboard",
    "schedule",
    "classes",
    "notices",
    "students",
    "materials",
    "attendance",
    "quizzes",
    "settings",
  ]);

  let hooks = {};
  let active = false;
  let account = "";
  let pollTimer = null;
  let pollInFlight = null;
  let generation = 0;
  let registrationToken = "";
  let listenerHandles = [];
  let inbox = [];
  let unreadCount = 0;
  let inboxSignature = "";
  let status = {
    supported: false,
    permission: "unknown",
    registered: false,
    polling: false,
    error: "",
  };

  function pushPlugin() {
    return window.Capacitor?.Plugins?.PushNotifications || null;
  }

  function nativePlatform() {
    try {
      return window.Capacitor?.getPlatform?.() || "web";
    } catch {
      return "web";
    }
  }

  function pushSupported() {
    return nativePlatform() !== "web" && Boolean(pushPlugin());
  }

  function cleanAccount(value) {
    return String(value || "").trim().toLowerCase();
  }

  function parseObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  function notificationData(raw = {}) {
    const direct = parseObject(raw.data);
    const extra = parseObject(raw.extra);
    const nested = parseObject(direct.data);
    return { ...extra, ...direct, ...nested };
  }

  function normalizeRoute(value, type = "") {
    const aliases = {
      quiz: "quizzes",
      quizzes: "quizzes",
      material: "materials",
      materials: "materials",
      attendance: "attendance",
      notice: "notices",
      notices: "notices",
    };
    const clean = String(value || "")
      .trim()
      .replace(/^#\/?/, "")
      .replace(/^\/?/, "")
      .split(/[?#]/)[0]
      .toLowerCase();
    if (ROUTES.has(clean)) return clean;
    if (aliases[clean]) return aliases[clean];
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedType.includes("attendance")) return "attendance";
    if (normalizedType.includes("quiz")) return "quizzes";
    if (normalizedType.includes("material")) return "materials";
    if (normalizedType.includes("notice")) return "notices";
    return "dashboard";
  }

  function normalizeNotification(raw = {}, source = "inbox") {
    const data = notificationData(raw);
    const type = String(raw.type || raw.kind || data.type || data.kind || "update");
    const inboxId = String(
      raw.notificationId
        || data.notificationId
        || data.inboxId
        || (source === "inbox" ? raw.id : "")
        || "",
    );
    const messageId = String(raw.id || data.messageId || "");
    return {
      id: inboxId || messageId || `notification-${Date.now()}`,
      inboxId,
      messageId,
      type,
      title: String(raw.title || data.title || "CampusPulse update"),
      body: String(raw.body || raw.message || data.body || data.message || ""),
      courseId: String(raw.courseId || data.courseId || ""),
      route: normalizeRoute(raw.route || data.route, type),
      createdAt: raw.createdAt || data.createdAt || new Date().toISOString(),
      readAt: raw.readAt || data.readAt || (raw.read === true || raw.isRead === true
        ? new Date().toISOString()
        : null),
      data,
      source,
    };
  }

  function snapshot() {
    return {
      notifications: inbox.map((item) => ({ ...item, data: { ...item.data } })),
      unreadCount,
      status: { ...status },
    };
  }

  function safeCall(name, ...args) {
    try {
      hooks[name]?.(...args);
    } catch {
      // A presentation callback must never stop delivery or polling.
    }
  }

  function updateStatus(next) {
    status = { ...status, ...next };
    safeCall("onStatus", { ...status });
  }

  function publishInbox({ force = false } = {}) {
    const nextSignature = JSON.stringify({
      ids: inbox.map((item) => [item.id, item.readAt]),
      unreadCount,
    });
    if (!force && nextSignature === inboxSignature) return;
    inboxSignature = nextSignature;
    safeCall("onInbox", snapshot());
  }

  function readStoredRegistration() {
    try {
      const stored = JSON.parse(localStorage.getItem(REGISTRATION_KEY) || "null");
      if (!stored || typeof stored !== "object") return null;
      const token = String(stored.token || "");
      const storedAccount = cleanAccount(stored.account);
      return token && storedAccount ? { token, account: storedAccount } : null;
    } catch {
      return null;
    }
  }

  function saveRegistration(token) {
    registrationToken = String(token || "");
    if (!registrationToken || !account) return;
    localStorage.setItem(
      REGISTRATION_KEY,
      JSON.stringify({ token: registrationToken, account }),
    );
  }

  function clearStoredRegistration(targetAccount = account) {
    const stored = readStoredRegistration();
    if (!stored || stored.account === cleanAccount(targetAccount)) {
      localStorage.removeItem(REGISTRATION_KEY);
    }
    registrationToken = "";
  }

  async function request(path, options) {
    if (typeof hooks.request !== "function") {
      throw new Error("Notification API is not configured");
    }
    return hooks.request(path, options);
  }

  async function registerToken(token, runGeneration = generation) {
    const cleanToken = String(token?.value || token || "").trim();
    if (!active || !cleanToken || runGeneration !== generation) return;
    saveRegistration(cleanToken);
    try {
      await request("/api/notifications/devices", {
        method: "POST",
        body: { token: cleanToken, platform: nativePlatform() },
      });
      if (!active || runGeneration !== generation) return;
      updateStatus({ registered: true, error: "" });
    } catch (error) {
      if (!active || runGeneration !== generation) return;
      updateStatus({
        registered: false,
        error: error?.message || "Could not register this phone",
      });
    }
  }

  function insertLiveNotification(item) {
    const key = item.inboxId || item.messageId || item.id;
    if (!key || inbox.some((existing) => (
      (existing.inboxId || existing.messageId || existing.id) === key
    ))) return;
    inbox = [item, ...inbox].slice(0, MAX_INBOX_ITEMS);
    unreadCount += item.readAt ? 0 : 1;
    publishInbox();
  }

  async function receiveForeground(raw) {
    if (!active) return;
    const item = normalizeNotification(raw, "push");
    insertLiveNotification(item);
    safeCall("onForeground", { ...item, data: { ...item.data } });
    refreshInbox({ silent: true });
    window.setTimeout(() => {
      if (active) refreshInbox({ silent: true });
    }, 1500);
  }

  async function openFromNative(raw) {
    if (!active) return;
    const item = normalizeNotification(raw, "push");
    if (item.inboxId) markRead(item.inboxId).catch(() => {});
    safeCall("onOpen", { ...item, data: { ...item.data } });
    refreshInbox({ silent: true });
  }

  async function addListener(plugin, eventName, callback) {
    if (!plugin?.addListener) return;
    const handle = await plugin.addListener(eventName, callback);
    if (handle?.remove) listenerHandles.push(handle);
  }

  async function installNativeListeners(runGeneration) {
    if (listenerHandles.length || !pushSupported()) return;
    const push = pushPlugin();
    await addListener(push, "registration", (token) => {
      if (active && runGeneration === generation) registerToken(token, runGeneration);
    });
    await addListener(push, "registrationError", (error) => {
      if (!active || runGeneration !== generation) return;
      updateStatus({
        registered: false,
        error: error?.error || error?.message || "Phone registration failed",
      });
    });
    await addListener(push, "pushNotificationReceived", receiveForeground);
    await addListener(push, "pushNotificationActionPerformed", (action) => {
      openFromNative(action?.notification || action);
    });
  }

  async function removeNativeListeners() {
    const handles = listenerHandles;
    listenerHandles = [];
    await Promise.allSettled(handles.map((handle) => handle.remove()));
  }

  async function enablePush({ requestPermission = true } = {}) {
    if (!active || !pushSupported()) {
      updateStatus({ supported: false, permission: "unsupported", registered: false });
      return { permission: "unsupported" };
    }
    const runGeneration = generation;
    const push = pushPlugin();
    updateStatus({ supported: true });
    await installNativeListeners(runGeneration);
    if (push.createChannel) {
      await push.createChannel({
        id: COURSE_EVENTS_CHANNEL_ID,
        name: "Course activity",
        description: "Attendance, quiz, and material alerts from CampusPulse",
        importance: 4,
        visibility: 1,
        vibration: true,
        lights: true,
        lightColor: "#5B5BD6",
      }).catch(() => {});
    }
    let permission = await push.checkPermissions();
    let receive = permission.receive || permission.display || "prompt";
    if (requestPermission && receive !== "granted") {
      permission = await push.requestPermissions();
      receive = permission.receive || permission.display || "denied";
    }
    if (!active || runGeneration !== generation) return { permission: receive };
    updateStatus({ permission: receive, error: receive === "denied"
      ? "Phone alerts are disabled in Android settings"
      : "" });
    if (receive !== "granted") return { permission: receive };

    const stored = readStoredRegistration();
    if (stored?.account === account) {
      registrationToken = stored.token;
      registerToken(stored.token, runGeneration);
    }
    await push.register();
    return { permission: receive };
  }

  async function refreshInbox({ silent = false } = {}) {
    if (!active) return snapshot();
    if (pollInFlight) return pollInFlight;
    const runGeneration = generation;
    const runAccount = account;
    pollInFlight = (async () => {
      try {
        const payload = await request(`/api/notifications?limit=${MAX_INBOX_ITEMS}`);
        if (!active || runGeneration !== generation || runAccount !== account) return snapshot();
        const rows = Array.isArray(payload) ? payload : payload?.notifications;
        inbox = (Array.isArray(rows) ? rows : [])
          .map((item) => normalizeNotification(item, "inbox"))
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
          .slice(0, MAX_INBOX_ITEMS);
        unreadCount = Number.isFinite(Number(payload?.unreadCount))
          ? Math.max(0, Number(payload.unreadCount))
          : inbox.filter((item) => !item.readAt).length;
        updateStatus({
          polling: true,
          error: status.registered ? "" : status.error,
        });
        publishInbox();
        return snapshot();
      } catch (error) {
        if (active && runGeneration === generation) {
          updateStatus({
            polling: false,
            error: error?.message || "Notification inbox is temporarily unavailable",
          });
          if (!silent) safeCall("onError", error);
        }
        return snapshot();
      } finally {
        pollInFlight = null;
      }
    })();
    return pollInFlight;
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = window.setInterval(() => {
      if (active && document.visibilityState === "visible") {
        refreshInbox({ silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  async function start({ accountEmail } = {}) {
    const nextAccount = cleanAccount(accountEmail);
    if (!nextAccount) throw new Error("Sign in before starting notifications");
    if (active && nextAccount === account) {
      await refreshInbox({ silent: true });
      return snapshot();
    }
    if (active) await stop({ unregister: true });
    generation += 1;
    active = true;
    account = nextAccount;
    inbox = [];
    unreadCount = 0;
    inboxSignature = "";
    status = {
      supported: pushSupported(),
      permission: pushSupported() ? "checking" : "unsupported",
      registered: false,
      polling: true,
      error: "",
    };
    publishInbox({ force: true });
    startPolling();
    await refreshInbox({ silent: true });
    // start() is called only after the authenticated shell is visible. Keeping
    // permission work here prevents Android from prompting on the sign-in page.
    if (pushSupported()) {
      enablePush({ requestPermission: true }).catch((error) => {
        if (active) updateStatus({
          registered: false,
          error: error?.message || "Phone alerts unavailable",
        });
      });
    }
    return snapshot();
  }

  async function stop({ unregister = false } = {}) {
    const stoppingAccount = account;
    const stored = readStoredRegistration();
    const token = registrationToken || (
      stored?.account === stoppingAccount ? stored.token : ""
    );
    clearInterval(pollTimer);
    pollTimer = null;
    active = false;
    generation += 1;
    if (unregister && token && typeof hooks.request === "function") {
      try {
        await request("/api/notifications/devices", {
          method: "DELETE",
          body: { token },
        });
      } catch {
        // Invalidating the native token below still prevents cross-account alerts.
      }
    }
    if (unregister && pushSupported() && pushPlugin().unregister) {
      await pushPlugin().unregister().catch(() => {});
    }
    await removeNativeListeners();
    if (unregister) clearStoredRegistration(stoppingAccount);
    registrationToken = "";
    account = "";
    pollInFlight = null;
    inbox = [];
    unreadCount = 0;
    inboxSignature = "";
    updateStatus({ registered: false, polling: false });
    publishInbox({ force: true });
  }

  async function markRead(id) {
    const cleanId = String(id || "");
    const target = inbox.find((item) => item.id === cleanId || item.inboxId === cleanId);
    if (!target || target.readAt) return snapshot();
    target.readAt = new Date().toISOString();
    unreadCount = Math.max(0, unreadCount - 1);
    publishInbox();
    try {
      await request(`/api/notifications/${encodeURIComponent(cleanId)}/read`, {
        method: "PATCH",
        body: {},
      });
    } catch (error) {
      refreshInbox({ silent: true });
      throw error;
    }
    return snapshot();
  }

  async function markAllRead() {
    if (!unreadCount) return snapshot();
    const readAt = new Date().toISOString();
    inbox.forEach((item) => { item.readAt = item.readAt || readAt; });
    unreadCount = 0;
    publishInbox();
    try {
      await request("/api/notifications/read-all", { method: "POST", body: {} });
    } catch (error) {
      refreshInbox({ silent: true });
      throw error;
    }
    return snapshot();
  }

  document.addEventListener("visibilitychange", () => {
    if (active && document.visibilityState === "visible") {
      refreshInbox({ silent: true });
    }
  });
  window.addEventListener("online", () => {
    if (active) refreshInbox({ silent: true });
  });

  window.CAMPUSPULSE_PUSH = {
    configure(options = {}) {
      hooks = { ...hooks, ...options };
      return this;
    },
    start,
    stop,
    refresh: refreshInbox,
    enablePush,
    markRead,
    markAllRead,
    getState: snapshot,
    normalizeNotification,
  };
})();
