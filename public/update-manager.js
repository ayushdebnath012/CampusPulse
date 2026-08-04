(() => {
  const MANIFEST_URL =
    "https://ayushdebnath012.github.io/CampusPulse/updates/latest.json";
  const TRUSTED_BUNDLE_PREFIX =
    "https://ayushdebnath012.github.io/CampusPulse/updates/";
  const updater = window.Capacitor?.Plugins?.CapacitorUpdater || null;
  // The Capacitor updater works the same on both native platforms, so an
  // installed iPhone picks up web-only changes just like an Android phone.
  const isNativeApp =
    ["android", "ios"].includes(window.Capacitor?.getPlatform?.()) && Boolean(updater);
  const listeners = new Set();
  let activeCheck = null;
  // The app registers a guard so a bundle never reloads mid-attendance.
  let applyGuard = null;

  const state = {
    supported: isNativeApp,
    status: isNativeApp ? "idle" : "unavailable",
    currentVersion: "embedded",
    latestVersion: "",
    stagedVersion: localStorage.getItem("campusPulseStagedWebVersion") || "",
    progress: 0,
    message: isNativeApp
      ? "Automatic web updates are enabled"
      : "Updates are delivered with the website",
  };

  function snapshot() {
    return { ...state };
  }

  function setApplyGuard(guard) {
    applyGuard = typeof guard === "function" ? guard : null;
  }

  function canApplyNow() {
    if (!applyGuard) return true;
    try {
      return applyGuard() !== false;
    } catch {
      return true;
    }
  }

  const DEFERRED_MESSAGE = "Update ready. It installs as soon as you finish up.";

  function publish(patch = {}) {
    Object.assign(state, patch);
    const detail = snapshot();
    listeners.forEach((listener) => listener(detail));
    document.dispatchEvent(
      new CustomEvent("campuspulse:update-status", { detail }),
    );
  }

  function validateManifest(manifest) {
    const version = String(manifest?.version || "").trim();
    const url = String(manifest?.url || "").trim();
    const checksum = String(manifest?.checksum || "").trim().toLowerCase();
    if (!/^[a-zA-Z0-9._+-]{3,100}$/.test(version)) {
      throw new Error("The update version is invalid");
    }
    if (!url.startsWith(TRUSTED_BUNDLE_PREFIX) || !url.endsWith(".zip")) {
      throw new Error("The update source is not trusted");
    }
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error("The update checksum is invalid");
    }
    return { version, url, checksum };
  }

  async function fetchManifest() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const separator = MANIFEST_URL.includes("?") ? "&" : "?";
      const response = await fetch(`${MANIFEST_URL}${separator}t=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Update check failed (${response.status})`);
      return validateManifest(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getCurrentVersion() {
    const result = await updater.current();
    const version = String(result?.bundle?.version || "embedded");
    state.currentVersion = version;
    if (state.stagedVersion === version) {
      state.stagedVersion = "";
      localStorage.removeItem("campusPulseStagedWebVersion");
    }
    return version;
  }

  async function checkForUpdate({ manual = false } = {}) {
    if (!isNativeApp) {
      publish({ status: "unavailable" });
      return snapshot();
    }
    if (activeCheck) return activeCheck;

    activeCheck = (async () => {
      publish({
        status: "checking",
        progress: 0,
        message: manual ? "Checking for updates…" : state.message,
      });
      try {
        const [manifest, currentVersion] = await Promise.all([
          fetchManifest(),
          getCurrentVersion(),
        ]);
        state.latestVersion = manifest.version;

        if (manifest.version === currentVersion) {
          publish({
            status: "current",
            message: "CampusPulse is up to date",
          });
          return snapshot();
        }
        if (manifest.version === state.stagedVersion) {
          if (!canApplyNow()) {
            publish({ status: "ready", progress: 100, message: DEFERRED_MESSAGE });
            return snapshot();
          }
          publish({
            status: "applying",
            progress: 100,
            message: "Update ready. Restarting automatically...",
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          await updater.reload();
          return snapshot();
        }

        publish({
          status: "downloading",
          progress: 0,
          message: "Downloading the latest improvements…",
        });
        const bundle = await updater.download(manifest);
        await updater.next({ id: bundle.id });
        state.stagedVersion = manifest.version;
        localStorage.setItem("campusPulseStagedWebVersion", manifest.version);
        if (!canApplyNow()) {
          publish({ status: "ready", progress: 100, message: DEFERRED_MESSAGE });
          return snapshot();
        }
        publish({
          status: "applying",
          progress: 100,
          message: "Update downloaded. Restarting automatically...",
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        await updater.reload();
        return snapshot();
      } catch (error) {
        publish({
          status: "error",
          message:
            error?.name === "AbortError"
              ? "Update check timed out. The embedded app is still available."
              : error?.message || "Could not check for updates",
        });
        return snapshot();
      } finally {
        activeCheck = null;
      }
    })();
    return activeCheck;
  }

  async function restartToUpdate() {
    if (!isNativeApp || state.status !== "ready") return false;
    publish({ status: "applying", message: "Restarting with the update…" });
    await updater.reload();
    return true;
  }

  // Called when the app leaves a screen that was too busy to interrupt.
  async function applyStagedUpdate() {
    if (!isNativeApp || state.status !== "ready" || !state.stagedVersion) return false;
    if (!canApplyNow()) return false;
    publish({ status: "applying", message: "Installing the update…" });
    await updater.reload();
    return true;
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  window.CAMPUSPULSE_UPDATES = {
    state,
    checkForUpdate,
    restartToUpdate,
    applyStagedUpdate,
    setApplyGuard,
    subscribe,
  };

  if (!isNativeApp) return;

  // This must happen before any network work so a healthy downloaded bundle is
  // not rolled back simply because the API or update host is temporarily slow.
  updater.notifyAppReady().catch(() => {});
  updater.addListener?.("download", (event) => {
    publish({
      status: "downloading",
      progress: Number(event?.percent || 0),
      message: `Downloading the latest improvements… ${Number(event?.percent || 0)}%`,
    });
  });

  setTimeout(() => checkForUpdate(), 1200);
  setInterval(() => checkForUpdate(), 15 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
})();
