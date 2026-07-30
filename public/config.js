(() => {
  const savedApiBase = localStorage.getItem("campusPulseApiBase") || "";
  const sameOriginApi =
    (location.hostname === "localhost" && location.port === "8787") ||
    location.hostname.endsWith(".onrender.com")
      ? location.origin
      : "";
  window.CAMPUSPULSE_CONFIG = {
    apiBase: savedApiBase || sameOriginApi,
  };
})();
