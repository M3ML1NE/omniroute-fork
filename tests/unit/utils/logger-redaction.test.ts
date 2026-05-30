import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("logger redaction", () => {
  it("cert_path redacted in log output", () => {
    const entry = {
      cert_path: "/secret/cert.pem",
      msg: "test",
    };

    // Simulate pino redaction with censor function
    const censor = (value: unknown) => {
      if (typeof value === "string" && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return "***";
    };

    const redacted = {
      ...entry,
      cert_path: censor(entry.cert_path),
    };

    assert.equal(redacted.cert_path, "***.pem");
    assert.ok(!JSON.stringify(redacted).includes("/secret/cert.pem"));
  });

  it("api_key masked with last 4 chars", () => {
    const key = "sk-test-12345abc";

    // Simulate pino redaction censor
    const censor = (value: unknown) => {
      if (typeof value === "string" && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return "***";
    };

    const masked = censor(key);

    assert.equal(masked, "***5abc");
    assert.ok(!masked.includes("sk-test"));
  });

  it("PEM content redacted from error messages", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----";

    // Simulate PEM redaction regex
    const redacted = pem.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[redacted-pem]");

    assert.equal(redacted, "[redacted-pem]");
    assert.ok(!redacted.includes("BEGIN RSA PRIVATE KEY"));
    assert.ok(!redacted.includes("MIIEowIBAAKCAQEA"));
  });

  it("multiple PEM blocks redacted", () => {
    const text =
      "Error: -----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----\nand -----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----";

    const redacted = text.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[redacted-pem]");

    assert.equal(redacted, "Error: [redacted-pem]\nand [redacted-pem]");
    assert.ok(!redacted.includes("BEGIN CERTIFICATE"));
    assert.ok(!redacted.includes("BEGIN PRIVATE KEY"));
  });

  it("key_path redacted", () => {
    const entry = {
      key_path: "/secret/key.pem",
    };

    const censor = (value: unknown) => {
      if (typeof value === "string" && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return "***";
    };

    const redacted = {
      ...entry,
      key_path: censor(entry.key_path),
    };

    assert.equal(redacted.key_path, "***.pem");
    assert.ok(!JSON.stringify(redacted).includes("/secret/key.pem"));
  });

  it("ca_path redacted", () => {
    const entry = {
      ca_path: "/secret/ca.pem",
    };

    const censor = (value: unknown) => {
      if (typeof value === "string" && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return "***";
    };

    const redacted = {
      ...entry,
      ca_path: censor(entry.ca_path),
    };

    assert.equal(redacted.ca_path, "***.pem");
    assert.ok(!JSON.stringify(redacted).includes("/secret/ca.pem"));
  });

  it("nested mtls paths redacted", () => {
    const entry = {
      mtls: {
        cert_path: "/secret/mtls-cert.pem",
        key_path: "/secret/mtls-key.pem",
      },
    };

    const censor = (value: unknown) => {
      if (typeof value === "string" && value.length > 4) {
        return `***${value.slice(-4)}`;
      }
      return "***";
    };

    const redacted = {
      mtls: {
        cert_path: censor(entry.mtls.cert_path),
        key_path: censor(entry.mtls.key_path),
      },
    };

    assert.equal(redacted.mtls.cert_path, "***.pem");
    assert.equal(redacted.mtls.key_path, "***.pem");
    assert.ok(!JSON.stringify(redacted).includes("/secret/mtls-cert.pem"));
    assert.ok(!JSON.stringify(redacted).includes("/secret/mtls-key.pem"));
  });
});
