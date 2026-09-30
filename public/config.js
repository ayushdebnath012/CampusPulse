(() => {
  // The IIT KGP firewall blocks Dynamic DNS hosts, so phones on campus Wi-Fi
  // cannot reach campuspulse.duckdns.org at all. This API Gateway front
  // forwards every path to it and is reachable from campus.
  const defaultApiBase = "https://1jz5vennqh.execute-api.ap-south-1.amazonaws.com";
  // The EC2 host still serves this site itself; a page loaded from there keeps
  // calling its own origin, which the API's CORS allowlist does not include.
  const originHost = "campuspulse.duckdns.org";
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
    : location.hostname === originHost
      ? location.origin
      : defaultApiBase;
  if (!localDevelopment && savedApiBase !== defaultApiBase) {
    localStorage.setItem("campusPulseApiBase", defaultApiBase);
  }
  window.CAMPUSPULSE_CONFIG = { apiBase };
})();
