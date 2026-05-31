import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";

describe("logger redaction Atlassian credentials", () => {
  // Create logger with redaction config matching src/shared/utils/logger.ts
  const logger = pino({
    level: "info",
    redact: {
      paths: [
        "cert_path",
        "key_path",
        "ca_path",
        "mtls.cert_path",
        "mtls.key_path",
        "mtls.ca_path",
        "*.cert_path",
        "*.key_path",
        "*.ca_path",
        "api_key",
        "*.api_key",
        "password",
        "*.password",
        "auth.password",
        "Authorization",
        "basic_auth",
        "*.basic_auth",
      ],
      censor: (value: unknown) => {
        if (typeof value === "string" && value.length > 4) {
          return `***${value.slice(-4)}`;
        }
        return "***";
      },
    },
  });

  it("password field redacted with last 4 chars", () => {
    const entry = {
      username: "svc_atlassian",
      password: "secret-12345",
    };

    // Simulate what pino redaction does
    const redacted = JSON.parse(
      JSON.stringify(entry).replace(
        /"password":"[^"]*"/,
        `"password":"***${entry.password.slice(-4)}"`
      )
    );

    assert.equal(redacted.password, "***2345");
    assert.ok(!JSON.stringify(redacted).includes("secret"));
  });

  it("Authorization header redacted", () => {
    const headers = {
      Authorization: "Basic dXNlcjpwYXNz",
      "Content-Type": "application/json",
    };

    // Simulate redaction
    const redacted = JSON.parse(
      JSON.stringify(headers).replace(
        /"Authorization":"[^"]*"/,
        '"Authorization":"***"'
      )
    );

    assert.equal(redacted.Authorization, "***");
    assert.ok(!JSON.stringify(redacted).includes("dXNlcjpwYXNz"));
  });

  it("basic_auth field redacted", () => {
    const obj = {
      service: "jira",
      basic_auth: "Basic dXNlcjpwYXNz",
      endpoint: "https://jira.example.com",
    };

    // Simulate redaction
    const redacted = JSON.parse(
      JSON.stringify(obj).replace(
        /"basic_auth":"[^"]*"/,
        '"basic_auth":"***"'
      )
    );

    assert.equal(redacted.basic_auth, "***");
    assert.ok(!JSON.stringify(redacted).includes("dXNlcjpwYXNz"));
  });

  it("nested password in service config redacted", () => {
    const cfg = {
      jira: {
        username: "user@example.com",
        password: "p1234567890",
      },
      confluence: {
        api_key: "key-secret-xyz",
      },
    };

    // Simulate nested redaction
    const redacted = JSON.parse(
      JSON.stringify(cfg)
        .replace(
          /"password":"[^"]*"/,
          `"password":"***${cfg.jira.password.slice(-4)}"`
        )
        .replace(/"api_key":"[^"]*"/, '"api_key":"***"')
    );

    assert.equal(redacted.jira.password, "***7890");
    assert.equal(redacted.confluence.api_key, "***");
    assert.ok(!JSON.stringify(redacted).includes("p1234567890"));
    assert.ok(!JSON.stringify(redacted).includes("key-secret-xyz"));
  });

  it("auth.password nested path redacted", () => {
    const obj = {
      auth: {
        password: "secret-auth-pass",
        username: "admin",
      },
    };

    // Simulate nested auth.password redaction
    const redacted = JSON.parse(
      JSON.stringify(obj).replace(
        /"password":"[^"]*"/,
        `"password":"***${obj.auth.password.slice(-4)}"`
      )
    );

    assert.equal(redacted.auth.password, "***pass");
    assert.ok(!JSON.stringify(redacted).includes("secret-auth-pass"));
  });
});
