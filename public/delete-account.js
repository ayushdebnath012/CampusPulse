const form = document.querySelector("#deleteAccountForm");
const button = document.querySelector("#deleteButton");
const result = document.querySelector("#result");
const apiBase = String(window.CAMPUSPULSE_CONFIG?.apiBase || "").replace(/\/+$/, "");

function showResult(message, type) {
  result.textContent = message;
  result.className = `notice ${type}`;
  result.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!apiBase) return showResult("The CampusPulse backend is not configured.", "error");
  if (!window.confirm("This permanently deletes your account and activity data. Continue?")) return;

  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  button.textContent = "Deleting account…";
  result.hidden = true;

  try {
    const login = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const loginBody = await login.json().catch(() => ({}));
    if (!login.ok) throw new Error(loginBody.error || "Could not verify those credentials");

    const deletion = await fetch(`${apiBase}/api/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    if (!deletion.ok) {
      const deletionBody = await deletion.json().catch(() => ({}));
      throw new Error(deletionBody.error || "Could not delete the account");
    }

    form.reset();
    form.hidden = true;
    showResult("Your CampusPulse account and associated activity data were deleted.", "success");
  } catch (error) {
    showResult(error.message || "Account deletion failed", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Permanently delete my account";
  }
});
