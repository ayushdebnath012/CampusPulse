(() => {
  const savedApiBase = localStorage.getItem("campusPulseApiBase") || "";
  const defaultApiBase = "https://campuspulse-api-ayush.onrender.com";
  const sameOriginApi =
    (location.hostname === "localhost" && location.port === "8787") ||
    location.hostname.endsWith(".onrender.com")
      ? location.origin
      : "";
  window.CAMPUSPULSE_CONFIG = {
    apiBase:
      savedApiBase === "offline"
        ? ""
        : savedApiBase || sameOriginApi || defaultApiBase,
  };
})();
