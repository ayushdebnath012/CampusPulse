(() => {
  const STORAGE_KEY = "campusPulseClassReminderSettings";
  const CHANNEL_ID = "class-reminders";
  const KIND = "campuspulse-class-reminder";
  const plugin = window.Capacitor?.Plugins?.LocalNotifications || null;
  const supported =
    window.Capacitor?.getPlatform?.() === "android" && Boolean(plugin);

  const weekdays = new Map([
    ["sun", 1],
    ["sunday", 1],
    ["mon", 2],
    ["monday", 2],
    ["tue", 3],
    ["tues", 3],
    ["tuesday", 3],
    ["wed", 4],
    ["wednesday", 4],
    ["thu", 5],
    ["thur", 5],
    ["thurs", 5],
    ["thursday", 5],
    ["fri", 6],
    ["friday", 6],
    ["sat", 7],
    ["saturday", 7],
  ]);

  function cleanAccount(value) {
    return String(value || "").trim().toLowerCase();
  }

  function readAllSettings() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }

  function settingsFor(accountEmail) {
    const stored = readAllSettings()[cleanAccount(accountEmail)] || {};
    const leadMinutes = [5, 10, 15, 30, 60].includes(Number(stored.leadMinutes))
      ? Number(stored.leadMinutes)
      : 15;
    return { enabled: Boolean(stored.enabled), leadMinutes };
  }

  function saveSettings(accountEmail, value) {
    const account = cleanAccount(accountEmail);
    if (!account) return;
    const all = readAllSettings();
    all[account] = {
      enabled: Boolean(value.enabled),
      leadMinutes: Number(value.leadMinutes) || 15,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function forgetSettings(accountEmail) {
    const account = cleanAccount(accountEmail);
    if (!account) return;
    const all = readAllSettings();
    delete all[account];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function parseTime(value) {
    const match = String(value || "")
      .trim()
      .match(/^(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const period = match[3]?.toUpperCase();
    if (minute > 59) return null;
    if (period) {
      if (hour < 1 || hour > 12) return null;
      if (period === "PM" && hour !== 12) hour += 12;
      if (period === "AM" && hour === 12) hour = 0;
    } else if (hour > 23) {
      return null;
    }
    return { hour, minute };
  }

  function stableId(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) & 0x7fffffff || 1;
  }

  function scheduleDescriptor(event, accountEmail, leadMinutes) {
    let weekday = weekdays.get(String(event.day || "").trim().toLowerCase());
    const time = parseTime(event.start);
    if (!weekday || !time) return null;
    let reminderMinutes = time.hour * 60 + time.minute - leadMinutes;
    if (reminderMinutes < 0) {
      reminderMinutes += 24 * 60;
      weekday = weekday === 1 ? 7 : weekday - 1;
    }
    const hour = Math.floor(reminderMinutes / 60);
    const minute = reminderMinutes % 60;
    const identity = [
      cleanAccount(accountEmail),
      event.id || event.courseId || "schedule",
      event.day,
      event.start,
      event.topic,
      leadMinutes,
    ].join("|");
    const courseLabel = String(event.courseCode || event.topic || "Class").trim();
    const topic = String(event.topic || event.courseName || courseLabel).trim();
    const room = String(event.room || "Room TBA").trim();
    return {
      title: `${courseLabel} in ${leadMinutes} minutes`,
      body: `${topic} · ${room}`,
      id: stableId(identity),
      schedule: {
        on: { weekday, hour, minute },
        allowWhileIdle: true,
      },
      channelId: CHANNEL_ID,
      group: "campuspulse-classes",
      autoCancel: true,
      extra: {
        kind: KIND,
        accountEmail: cleanAccount(accountEmail),
        scheduleId: String(event.id || ""),
      },
    };
  }

  function notificationExtra(notification) {
    const extra = notification?.extra;
    if (!extra || typeof extra === "object") return extra || {};
    try {
      return JSON.parse(extra);
    } catch {
      return {};
    }
  }

  async function cancelOwned(accountEmail) {
    if (!supported) return 0;
    const account = cleanAccount(accountEmail);
    const pending = await plugin.getPending();
    const notifications = (pending.notifications || [])
      .filter((notification) => {
        const extra = notificationExtra(notification);
        return extra.kind === KIND && extra.accountEmail === account;
      })
      .map((notification) => ({ id: notification.id }));
    if (notifications.length) await plugin.cancel({ notifications });
    return notifications.length;
  }

  async function notificationPermission({ request = false } = {}) {
    if (!supported) return "unsupported";
    let status = await plugin.checkPermissions();
    if (request && status.display !== "granted") {
      status = await plugin.requestPermissions();
    }
    return status.display;
  }

  async function ensureChannel() {
    if (!supported || !plugin.createChannel) return;
    await plugin.createChannel({
      id: CHANNEL_ID,
      name: "Class reminders",
      description: "Alerts before scheduled CampusPulse classes",
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: "#5B5BD6",
    });
  }

  function buildNotifications(events, accountEmail, leadMinutes) {
    const seen = new Set();
    const notifications = [];
    let skipped = 0;
    for (const event of Array.isArray(events) ? events : []) {
      const descriptor = scheduleDescriptor(event, accountEmail, leadMinutes);
      if (!descriptor) {
        skipped += 1;
        continue;
      }
      const key = [
        descriptor.schedule.on.weekday,
        descriptor.schedule.on.hour,
        descriptor.schedule.on.minute,
        descriptor.title,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      notifications.push(descriptor);
    }
    return { notifications, skipped };
  }

  async function schedule({ accountEmail, events, leadMinutes, requestPermission }) {
    if (!supported) {
      throw new Error("Phone reminders require the latest CampusPulse Android app");
    }
    const account = cleanAccount(accountEmail);
    if (!account) throw new Error("Sign in before enabling class reminders");
    const normalizedLead = [5, 10, 15, 30, 60].includes(Number(leadMinutes))
      ? Number(leadMinutes)
      : 15;
    const { notifications, skipped } = buildNotifications(
      events,
      account,
      normalizedLead,
    );
    if (!notifications.length) {
      await cancelOwned(account);
      if (!requestPermission) {
        return {
          scheduled: 0,
          skipped,
          leadMinutes: normalizedLead,
          exactAlarm: "unknown",
        };
      }
      throw new Error("Add a valid weekly timetable before enabling reminders");
    }
    const permission = await notificationPermission({ request: requestPermission });
    if (permission !== "granted") {
      throw new Error("Allow notifications in Android settings to enable class reminders");
    }
    await ensureChannel();
    await cancelOwned(account);
    await plugin.schedule({ notifications });
    saveSettings(account, { enabled: true, leadMinutes: normalizedLead });
    let exactAlarm = "unknown";
    if (plugin.checkExactNotificationSetting) {
      try {
        exactAlarm = (await plugin.checkExactNotificationSetting()).exact_alarm;
      } catch {
        exactAlarm = "unknown";
      }
    }
    return {
      scheduled: notifications.length,
      skipped,
      leadMinutes: normalizedLead,
      exactAlarm,
    };
  }

  async function enable(options) {
    return schedule({ ...options, requestPermission: true });
  }

  async function reconcile({ accountEmail, events }) {
    const settings = settingsFor(accountEmail);
    if (!settings.enabled || !supported) {
      return { scheduled: 0, skipped: 0, enabled: settings.enabled };
    }
    try {
      return await schedule({
        accountEmail,
        events,
        leadMinutes: settings.leadMinutes,
        requestPermission: false,
      });
    } catch (error) {
      return { scheduled: 0, skipped: 0, enabled: true, error: error.message };
    }
  }

  async function disable(accountEmail, { forget = false } = {}) {
    await cancelOwned(accountEmail);
    if (forget) forgetSettings(accountEmail);
    else {
      const settings = settingsFor(accountEmail);
      saveSettings(accountEmail, { ...settings, enabled: false });
    }
  }

  async function suspend(accountEmail) {
    await cancelOwned(accountEmail);
  }

  async function requestExactTiming() {
    if (!supported || !plugin.changeExactNotificationSetting) return "unsupported";
    return (await plugin.changeExactNotificationSetting()).exact_alarm;
  }

  window.CAMPUSPULSE_REMINDERS = {
    supported,
    getSettings: settingsFor,
    enable,
    reconcile,
    disable,
    suspend,
    requestExactTiming,
  };
})();
