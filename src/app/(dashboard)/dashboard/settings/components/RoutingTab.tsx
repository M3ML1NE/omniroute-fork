"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import FallbackChainsEditor from "./FallbackChainsEditor";

export default function RoutingTab() {
  const [settings, setSettings] = useState<any>({
    alwaysPreserveClientCache: "auto",
  });
  const [loading, setLoading] = useState(true);
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

      <FallbackChainsEditor />

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
    </div>
  );
}
