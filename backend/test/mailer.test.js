const test = require("node:test");
const assert = require("node:assert/strict");

const { createMailer } = require("../src/mailer");

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const at = Date.now();
    calls.push({ url: String(url), body: JSON.parse(options.body), at });
    return handler(calls.length, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function ok() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rateLimited(retryAfterSeconds) {
  return new Response(JSON.stringify({ message: "Too many requests" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {}),
    },
  });
}

const RESEND_ENV = {
  RESEND_API_KEY: "test-key",
  EMAIL_FROM: "CampusPulse <noreply@example.test>",
};

test("a burst of sign-ups is paced instead of overrunning the provider", async (t) => {
  const fetcher = stubFetch(() => ok());
  t.after(fetcher.restore);

  // Well under the real provider limit, so the test measures pacing quickly.
  const mailer = createMailer({ ...RESEND_ENV, EMAIL_MIN_INTERVAL_MS: "40" });
  const recipients = Array.from(
    { length: 8 },
    (_unused, index) => `student.${index}@kgpian.iitkgp.ac.in`,
  );

  const results = await Promise.all(
    recipients.map((email, index) =>
      mailer.sendVerification({ email, name: `Student ${index}`, code: "123456" }),
    ),
  );

  assert.equal(results.filter((result) => result.delivered).length, recipients.length);
  assert.equal(fetcher.calls.length, recipients.length);
  assert.deepEqual(
    fetcher.calls.map((call) => call.body.to[0]),
    recipients,
    "every recipient is sent exactly one message, in order",
  );

  const gaps = fetcher.calls
    .slice(1)
    .map((call, index) => call.at - fetcher.calls[index].at);
  assert.ok(
    gaps.every((gap) => gap >= 30),
    `sends should be spaced out, saw gaps ${gaps.join(", ")}ms`,
  );
  assert.equal(mailer.stats.delivered, recipients.length);
  assert.equal(mailer.stats.failed, 0);
});

test("a throttled send is retried rather than silently lost", async (t) => {
  const fetcher = stubFetch((attempt) => (attempt < 3 ? rateLimited(0) : ok()));
  t.after(fetcher.restore);

  const mailer = createMailer({ ...RESEND_ENV, EMAIL_MIN_INTERVAL_MS: "0" });
  const result = await mailer.sendVerification({
    email: "student@kgpian.iitkgp.ac.in",
    name: "Student",
    code: "123456",
  });

  assert.deepEqual(result, { delivered: true });
  assert.equal(fetcher.calls.length, 3, "the send is retried until it is accepted");
  assert.equal(mailer.stats.delivered, 1);
  assert.equal(mailer.stats.failed, 0);
  assert.ok(mailer.stats.retried >= 2);
});

test("a rejected sender fails immediately and is reported", async (t) => {
  const fetcher = stubFetch(() =>
    new Response(JSON.stringify({ message: "The domain is not verified" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  t.after(fetcher.restore);

  const mailer = createMailer({ ...RESEND_ENV, EMAIL_MIN_INTERVAL_MS: "0" });
  await assert.rejects(
    mailer.sendVerification({
      email: "student@kgpian.iitkgp.ac.in",
      name: "Student",
      code: "123456",
    }),
    (error) => {
      assert.equal(error.deliveryFailed, true);
      assert.match(error.message, /domain is not verified/);
      return true;
    },
  );
  assert.equal(
    fetcher.calls.length,
    1,
    "an unverified sender is not worth retrying",
  );
  assert.equal(mailer.stats.failed, 1);
  assert.match(mailer.stats.lastError, /domain is not verified/);
});

test("one failed recipient does not stop the rest of the queue", async (t) => {
  const fetcher = stubFetch((_attempt, calls) =>
    calls[calls.length - 1].body.to[0].startsWith("blocked")
      ? new Response(JSON.stringify({ message: "Invalid recipient" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        })
      : ok(),
  );
  t.after(fetcher.restore);

  const mailer = createMailer({ ...RESEND_ENV, EMAIL_MIN_INTERVAL_MS: "0" });
  const results = await Promise.allSettled([
    mailer.sendVerification({ email: "first@kgpian.iitkgp.ac.in", name: "A", code: "1" }),
    mailer.sendVerification({ email: "blocked@kgpian.iitkgp.ac.in", name: "B", code: "2" }),
    mailer.sendVerification({ email: "third@kgpian.iitkgp.ac.in", name: "C", code: "3" }),
  ]);

  assert.deepEqual(
    results.map((entry) => entry.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(mailer.stats.delivered, 2);
  assert.equal(mailer.stats.failed, 1);
});

test("with no provider configured the code is previewed rather than dropped", async () => {
  const mailer = createMailer({});
  assert.equal(mailer.configured, false);
  assert.equal(mailer.provider, "disabled");
  const result = await mailer.sendVerification({
    email: "student@kgpian.iitkgp.ac.in",
    name: "Student",
    code: "424242",
  });
  assert.deepEqual(result, { delivered: false, previewCode: "424242" });
});
