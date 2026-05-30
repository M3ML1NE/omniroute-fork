import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  getAgent,
  clearPool,
  _getPoolSize,
} from "../../../open-sse/services/mtlsAgent.js";
import type { MtlsConfig } from "../../../open-sse/types/keyStore.js";

const TMP = join(tmpdir(), `mtls-test-${Date.now()}-${process.pid}`);

before(() => {
  mkdirSync(TMP, { recursive: true });
  // Try to generate self-signed certs for realistic testing.
  // Fall back to dummy PEM strings if openssl is unavailable —
  // https.Agent constructor accepts any Buffer for cert/key/ca,
  // it doesn't parse them until the agent is used for an actual TLS handshake.
  try {
    execSync(`openssl genrsa -out ${TMP}/ca.key 2048 2>/dev/null`);
    execSync(
      `openssl req -new -x509 -days 1 -key ${TMP}/ca.key -out ${TMP}/ca.crt -subj "/CN=TestCA" 2>/dev/null`,
    );
    execSync(`openssl genrsa -out ${TMP}/client.key 2048 2>/dev/null`);
    execSync(
      `openssl req -new -key ${TMP}/client.key -out ${TMP}/client.csr -subj "/CN=TestClient" 2>/dev/null`,
    );
    execSync(
      `openssl x509 -req -days 1 -in ${TMP}/client.csr -CA ${TMP}/ca.crt -CAkey ${TMP}/ca.key -CAcreateserial -out ${TMP}/client.crt 2>/dev/null`,
    );
  } catch {
    const dummyCert =
      "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END CERTIFICATE-----\n";
    const dummyKey =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";
    writeFileSync(join(TMP, "ca.crt"), dummyCert);
    writeFileSync(join(TMP, "client.crt"), dummyCert);
    writeFileSync(join(TMP, "client.key"), dummyKey);
  }
  clearPool();
});

after(() => {
  clearPool();
  rmSync(TMP, { recursive: true, force: true });
});

const cfg = (): MtlsConfig => ({
  cert_path: join(TMP, "client.crt"),
  key_path: join(TMP, "client.key"),
  ca_path: join(TMP, "ca.crt"),
});

describe("mtlsAgent", () => {
  it("same config returns same Agent instance (pool hit)", () => {
    clearPool();
    const c = cfg();
    const a1 = getAgent(c);
    const a2 = getAgent(c);
    assert.strictEqual(a1, a2, "pool should return same cached agent");
  });

  it("different config returns different Agent", () => {
    clearPool();
    const c1 = cfg();
    const c2: MtlsConfig = { ...cfg(), cert_path: join(TMP, "ca.crt") };
    const a1 = getAgent(c1);
    const a2 = getAgent(c2);
    assert.notStrictEqual(a1, a2);
    assert.equal(_getPoolSize(), 2);
  });

  it("missing cert file throws Error mentioning path (not content)", () => {
    clearPool();
    const bad: MtlsConfig = {
      cert_path: "/nonexistent/cert.pem",
      key_path: join(TMP, "client.key"),
      ca_path: join(TMP, "ca.crt"),
    };
    assert.throws(
      () => getAgent(bad),
      (err: Error) => {
        assert.ok(
          err.message.includes("/nonexistent/cert.pem"),
          "error must mention path",
        );
        assert.ok(
          err.message.includes("cert"),
          "error must indicate which file kind failed",
        );
        return true;
      },
    );
  });

  it("clearPool() destroys all agents and resets size", () => {
    clearPool();
    getAgent(cfg());
    assert.ok(_getPoolSize() > 0, "pool populated");
    clearPool();
    assert.equal(_getPoolSize(), 0, "pool cleared");
  });

  it("missing key file throws Error mentioning key path", () => {
    clearPool();
    const bad: MtlsConfig = {
      cert_path: join(TMP, "client.crt"),
      key_path: "/nonexistent/key.pem",
      ca_path: join(TMP, "ca.crt"),
    };
    assert.throws(
      () => getAgent(bad),
      (err: Error) => {
        assert.ok(err.message.includes("/nonexistent/key.pem"));
        assert.ok(err.message.includes("key"));
        return true;
      },
    );
  });

  it("missing CA file throws Error mentioning CA path", () => {
    clearPool();
    const bad: MtlsConfig = {
      cert_path: join(TMP, "client.crt"),
      key_path: join(TMP, "client.key"),
      ca_path: "/nonexistent/ca.pem",
    };
    assert.throws(
      () => getAgent(bad),
      (err: Error) => {
        assert.ok(err.message.includes("/nonexistent/ca.pem"));
        assert.ok(err.message.includes("CA"));
        return true;
      },
    );
  });
});
