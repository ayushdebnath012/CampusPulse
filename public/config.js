(() => {
  const defaultApiBase = "https://campuspulse.duckdns.org";
  const savedApiBase = String(
    localStorage.getItem("campusPulseApiBase") || "",
  ).trim().replace(/\/+$/, "");
  let savedHostname = "";
  try {
    savedHostname = new URL(savedApiBase).hostname.toLowerCase();
  } catch {
    // An invalid old override should never strand the installed application.
  }
  const localDevelopment =
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    location.port === "8787";
  // Production has one canonical API. Older builds allowed any saved URL to
  // override it, so a retired Render address, an old LAN IP, or an accidental
  // "offline" value could permanently strand an otherwise healthy app.
  // Preserve overrides only on the explicit local development server.
  const validSavedApi = savedApiBase && savedHostname ? savedApiBase : "";
  const apiBase = localDevelopment
    ? savedApiBase === "offline"
      ? ""
      : validSavedApi || location.origin
    : defaultApiBase;
  if (!localDevelopment && savedApiBase !== defaultApiBase) {
    localStorage.setItem("campusPulseApiBase", defaultApiBase);
  }
  window.CAMPUSPULSE_CONFIG = { apiBase };
})();
