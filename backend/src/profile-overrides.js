function professorProfileOverrides(env = process.env) {
  const raw = String(env.PROFESSOR_PROFILE_OVERRIDES_JSON || "").trim();
  if (!raw) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PROFESSOR_PROFILE_OVERRIDES_JSON must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("PROFESSOR_PROFILE_OVERRIDES_JSON must be a JSON object");
  }
  return new Map(
    Object.entries(parsed).map(([email, profile]) => [
      String(email).trim().toLowerCase(),
      {
        ...(String(profile?.phone || "").trim()
          ? { phone: String(profile.phone).trim() }
          : {}),
        ...(String(profile?.department || "").trim()
          ? { department: String(profile.department).trim() }
          : {}),
      },
    ]),
  );
}

function applyUserProfileOverride(user, env = process.env) {
  if (!user || user.role !== "faculty") return user;
  const override = professorProfileOverrides(env).get(
    String(user.email || "").trim().toLowerCase(),
  );
  return override ? { ...user, ...override } : user;
}

async function applyProfessorProfileOverrides(store, env = process.env) {
  const overrides = professorProfileOverrides(env);
  if (!overrides.size) return { updated: 0 };
  return store.update((database) => {
    let updated = 0;
    database.users = database.users.map((user) => {
      if (user.role !== "faculty") return user;
      const override = overrides.get(String(user.email || "").trim().toLowerCase());
      if (!override) return user;
      const overridden = { ...user, ...override };
      if (
        overridden.phone !== user.phone ||
        overridden.department !== user.department
      ) {
        updated += 1;
      }
      return overridden;
    });
    return { updated };
  });
}

module.exports = {
  professorProfileOverrides,
  applyProfessorProfileOverrides,
  applyUserProfileOverride,
};
