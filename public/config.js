(() => {
  const defaultApiBase = "https://campuspulse-api-ayush.vercel.app";
  const savedApiBase = String(
    localStorage.getItem("campusPulseApiBase") || "",
  ).trim().replace(/\/+$/, "");
  let savedHostname = "";
  try {
    savedHostname = new URL(savedApiBase).hostname.toLowerCase();
  } catch {
    // An invalid old override should never strand the installed application.
  }
  const retiredApi = savedHostname.endsWith(".onrender.com");
  const sameOriginApi =
    location.hostname === "localhost" && location.port === "8787"
      ? location.origin
      : "";
  const apiBase =
    savedApiBase === "offline"
      ? ""
      : retiredApi || (savedApiBase && !savedHostname)
        ? defaultApiBase
        : savedApiBase || sameOriginApi || defaultApiBase;
  if (retiredApi) localStorage.setItem("campusPulseApiBase", defaultApiBase);
  window.CAMPUSPULSE_CONFIG = { apiBase };
})();
