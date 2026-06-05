"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Toggle } from "@/shared/components";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import FallbackChainsEditor from "./FallbackChainsEditor";
import {
  CLI_COMPAT_PROVIDER_DISPLAY,
  CLI_COMPAT_TOGGLE_IDS,
  normalizeCliCompatProviderId,
} from "@/shared/constants/cliCompatProviders";

export default function RoutingTab() {
  const [settings, setSettings] = useState<any>({
    alwaysPreserveClientCache: "auto",
    antigravitySignatureCacheMode: "enabled",
    cliCompatProviders: [],
    autoRoutingEnabled: true,
    autoRoutingDefaultVariant: "lkgp",
  });
  const [loading, setLoading] = useState(true);
  const [lkgpCacheLoading, setLkgpCacheLoading] = useState(false);
  const [lkgpCacheStatus, setLkgpCacheStatus] = useState({ type: "", message: "" });
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const notify = useNotificationStore();

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Optimistic update: apply the patch to local state FIRST so the UI never
  // appears to drop the user's edit, then PATCH the server. If the server
  // rejects (e.g. blank required field on a freshly-added op), surface the
  // error to the caller via onError so the editor can render it inline. Local
  // state is intentionally NOT rolled back — the user keeps editing and
  // re-saves once the validation passes.
  const updateSetting = async (patch: Record<string, unknown>, onError?: (msg: string) => void) => {
    setSettings((prev: any) => ({ ...prev, ...patch }));
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        let serverMsg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          const details = Array.isArray(body?.error?.details)
            ? body.error.details
                .map((d: { field?: string; message?: string }) =>
                  d.field ? `${d.field}: ${d.message ?? "invalid"}` : d.message
                )
                .filter(Boolean)
                .join("; ")
            : null;
          serverMsg = details || body?.error?.message || serverMsg;
        } catch {
          // body wasn't JSON — keep the HTTP status fallback
        }
        notify.error(t("saveFailed"), serverMsg);
        if (onError) onError(serverMsg);
        else console.error("Failed to update settings:", serverMsg);
      } else {
        notify.success(t("savedSuccessfully"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(t("saveFailed"), msg);
      if (onError) onError(msg);
      else console.error("Failed to update settings:", msg);
    }
  };

  const cliCompatProviders = useMemo(
    () =>
      Array.isArray(settings.cliCompatProviders)
        ? settings.cliCompatProviders.map((providerId: string) =>
            normalizeCliCompatProviderId(providerId)
          )
        : [],
    [settings.cliCompatProviders]
  );
  const cliCompatProviderSet = useMemo(() => new Set(cliCompatProviders), [cliCompatProviders]);

  const toggleCliCompatProvider = (providerId: string, enabled: boolean) => {
    const normalizedProviderId = normalizeCliCompatProviderId(providerId);
    const nextProviders = new Set(cliCompatProviders);
    if (enabled) {
      nextProviders.add(normalizedProviderId);
    } else {
      nextProviders.delete(normalizedProviderId);
    }
    updateSetting({ cliCompatProviders: Array.from(nextProviders) });
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 h-fit">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                network_ping
              </span>
            </div>
            <div>
              <h3 className="text-lg font-semibold">
                {t("adaptiveVolumeRouting") || "Adaptive Volume Routing"}
              </h3>
              <p className="text-sm text-text-muted mt-1">
                {t("adaptiveVolumeRoutingDesc") ||
                  "Automatically adjusts traffic volume between providers based on real-time latency and error rates."}
              </p>
            </div>
          </div>
          <div className="pt-1">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={!!settings.adaptiveVolumeRouting}
                onChange={(e) => updateSetting({ adaptiveVolumeRouting: e.target.checked })}
                disabled={loading}
              />
              <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 h-fit">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                verified
              </span>
            </div>
            <div>
              <h3 className="text-lg font-semibold">
                {t("lkgpToggleTitle") || "Last Known Good Provider (LKGP)"}
              </h3>
              <p className="text-sm text-text-muted mt-1">
                {t("lkgpToggleDesc") ||
                  "When enabled, the router remembers which provider last served a successful response and tries it first on subsequent requests."}
              </p>
            </div>
          </div>
          <div className="pt-1">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.lkgpEnabled !== false}
                onChange={(e) => updateSetting({ lkgpEnabled: e.target.checked })}
                disabled={loading}
              />
              <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-border/30 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            loading={lkgpCacheLoading}
            onClick={async () => {
              setLkgpCacheLoading(true);
              setLkgpCacheStatus({ type: "", message: "" });
              try {
                const res = await fetch("/api/settings/lkgp-cache", { method: "DELETE" });
                const data = await res.json();
                if (res.ok) {
                  setLkgpCacheStatus({
                    type: "success",
                    message: t("lkgpCacheCleared") || "LKGP cache cleared successfully",
                  });
                } else {
                  setLkgpCacheStatus({
                    type: "error",
                    message:
                      data.error || t("lkgpCacheClearFailed") || "Failed to clear LKGP cache",
                  });
                }
              } catch {
                setLkgpCacheStatus({
                  type: "error",
                  message: t("errorOccurred") || "An error occurred",
                });
              } finally {
                setLkgpCacheLoading(false);
              }
            }}
          >
            <span className="material-symbols-outlined text-[14px] mr-1" aria-hidden="true">
              delete_sweep
            </span>
            {t("clearLkgpCache") || "Clear LKGP Cache"}
          </Button>
          {lkgpCacheStatus.message && (
            <span
              className={`text-xs ${lkgpCacheStatus.type === "success" ? "text-green-500" : "text-red-500"}`}
            >
              {lkgpCacheStatus.message}
            </span>
          )}
        </div>
      </Card>

      <FallbackChainsEditor />

      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              fingerprint
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("routingAntigravitySignatureTitle")}</h3>
            <p className="text-sm text-text-muted">{t("routingAntigravitySignatureDesc")}</p>
          </div>
        </div>

        <div className="space-y-3">
          {[
            {
              value: "enabled",
              label: t("routingAntigravitySignatureEnabledLabel"),
              desc: t("routingAntigravitySignatureEnabledDesc"),
            },
            {
              value: "bypass",
              label: t("routingAntigravitySignatureBypassLabel"),
              desc: t("routingAntigravitySignatureBypassDesc"),
            },
            {
              value: "bypass-strict",
              label: t("routingAntigravitySignatureBypassStrictLabel"),
              desc: t("routingAntigravitySignatureBypassStrictDesc"),
            },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => updateSetting({ antigravitySignatureCacheMode: option.value })}
              disabled={loading}
              className={`w-full flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                settings.antigravitySignatureCacheMode === option.value
                  ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
                  : "border-border/50 hover:border-border hover:bg-surface/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    settings.antigravitySignatureCacheMode === option.value
                      ? "text-sky-400"
                      : "text-text-muted"
                  }`}
                >
                  {settings.antigravitySignatureCacheMode === option.value
                    ? "check_circle"
                    : "radio_button_unchecked"}
                </span>
                <span
                  className={`text-sm font-medium ${settings.antigravitySignatureCacheMode === option.value ? "text-sky-400" : ""}`}
                >
                  {option.label}
                </span>
              </div>
              <p className="text-xs text-text-muted ml-7">{option.desc}</p>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500 h-fit">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              security
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("cliFingerprint")}</h3>
            <p className="text-sm text-text-muted mt-1">{t("cliFingerprintDesc")}</p>
          </div>
        </div>

        <div className="mb-5">
          <h4 className="text-sm font-semibold mb-2">{t("routingHeaderFingerprintTitle")}</h4>
          <p className="text-xs text-text-muted mb-2">
            {t("cliFingerprintEnabled", { count: cliCompatProviderSet.size })}
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {CLI_COMPAT_TOGGLE_IDS.map((providerId) => {
              const normalizedProviderId = normalizeCliCompatProviderId(providerId);
              const providerDisplay = CLI_COMPAT_PROVIDER_DISPLAY[providerId];
              const checked = cliCompatProviderSet.has(normalizedProviderId);
              const label = providerDisplay?.name || providerId;
              const description = providerDisplay?.description || providerId;
              const titleText = checked
                ? t("disableFingerprintTitle", { provider: label })
                : t("enableFingerprintTitle", { provider: label });

              return (
                <button
                  key={providerId}
                  type="button"
                  onClick={() => toggleCliCompatProvider(providerId, !checked)}
                  disabled={loading}
                  aria-pressed={checked}
                  title={titleText}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${
                    checked
                      ? "border-indigo-500/50 bg-indigo-500/5 ring-1 ring-indigo-500/20"
                      : "border-border/50 hover:border-border hover:bg-surface/30"
                  } ${loading ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <span
                    className={`material-symbols-outlined mt-0.5 text-[18px] ${checked ? "text-indigo-400" : "text-text-muted"}`}
                    aria-hidden="true"
                  >
                    {checked ? "check_circle" : "radio_button_unchecked"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-sm font-medium ${checked ? "text-indigo-400" : ""}`}
                    >
                      {label}
                    </span>
                    <span className="mt-1 block text-xs text-text-muted">{description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-green-500/10 text-green-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              cached
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("routingClientCacheControlTitle")}</h3>
            <p className="text-sm text-text-muted">{t("routingClientCacheControlDesc")}</p>
          </div>
        </div>

        <div className="space-y-3">
          {[
            {
              value: "auto",
              label: tCommon("auto") + " (" + tCommon("recommended") + ")",
              desc: t("routingClientCacheControlAutoDesc"),
            },
            {
              value: "always",
              label: t("routingClientCacheControlAlwaysLabel"),
              desc: t("routingClientCacheControlAlwaysDesc"),
            },
            {
              value: "never",
              label: t("routingClientCacheControlNeverLabel"),
              desc: t("routingClientCacheControlNeverDesc"),
            },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => updateSetting({ alwaysPreserveClientCache: option.value })}
              disabled={loading}
              className={`w-full flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all ${
                settings.alwaysPreserveClientCache === option.value
                  ? "border-green-500/50 bg-green-500/5 ring-1 ring-green-500/20"
                  : "border-border/50 hover:border-border hover:bg-surface/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    settings.alwaysPreserveClientCache === option.value
                      ? "text-green-400"
                      : "text-text-muted"
                  }`}
                >
                  {settings.alwaysPreserveClientCache === option.value
                    ? "check_circle"
                    : "radio_button_unchecked"}
                </span>
                <span
                  className={`text-sm font-medium ${settings.alwaysPreserveClientCache === option.value ? "text-green-400" : ""}`}
                >
                  {option.label}
                </span>
              </div>
              <p className="text-xs text-text-muted ml-7">{option.desc}</p>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500 h-fit">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                auto_awesome
              </span>
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("routingZeroConfigTitle")}</h3>
              <p className="text-sm text-text-muted mt-1">{t("routingZeroConfigDesc")}</p>
            </div>
          </div>
          <div className="pt-1">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.autoRoutingEnabled !== false}
                onChange={(e) => updateSetting({ autoRoutingEnabled: e.target.checked })}
                disabled={loading}
              />
              <div className="w-11 h-6 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-border/30">
          <label className="block text-sm font-medium mb-2">{t("routingDefaultAutoVariant")}</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[
              {
                value: "lkgp",
                label: t("routingDefaultAutoVariantLKGP"),
                desc: t("routingDefaultAutoVariantLKGPDesc"),
              },
              {
                value: "coding",
                label: t("routingDefaultAutoVariantCoding"),
                desc: t("routingDefaultAutoVariantCodingDesc"),
              },
              {
                value: "fast",
                label: t("routingDefaultAutoVariantFast"),
                desc: t("routingDefaultAutoVariantFastDesc"),
              },
              {
                value: "cheap",
                label: t("routingDefaultAutoVariantCheap"),
                desc: t("routingDefaultAutoVariantCheapDesc"),
              },
              {
                value: "offline",
                label: t("routingDefaultAutoVariantOffline"),
                desc: t("routingDefaultAutoVariantOfflineDesc"),
              },
              {
                value: "smart",
                label: t("routingDefaultAutoVariantSmart"),
                desc: t("routingDefaultAutoVariantSmartDesc"),
              },
            ].map((option) => (
              <button
                key={option.value}
                onClick={() => updateSetting({ autoRoutingDefaultVariant: option.value })}
                disabled={loading}
                className={`p-2 rounded-lg border text-left transition-all ${
                  settings.autoRoutingDefaultVariant === option.value
                    ? "border-indigo-500/50 bg-indigo-500/5 ring-1 ring-indigo-500/20"
                    : "border-border/50 hover:border-border hover:bg-surface/30"
                }`}
              >
                <div className="flex items-center gap-1">
                  <span
                    className={`material-symbols-outlined text-[14px] ${
                      settings.autoRoutingDefaultVariant === option.value
                        ? "text-indigo-400"
                        : "text-text-muted"
                    }`}
                  >
                    {settings.autoRoutingDefaultVariant === option.value
                      ? "check_circle"
                      : "radio_button_unchecked"}
                  </span>
                  <span
                    className={`text-xs font-medium ${settings.autoRoutingDefaultVariant === option.value ? "text-indigo-400" : ""}`}
                  >
                    {option.label}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
