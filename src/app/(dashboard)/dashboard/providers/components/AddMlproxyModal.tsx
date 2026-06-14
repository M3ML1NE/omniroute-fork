"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Modal, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

type MlproxyConnectionNode = { id: string } & Record<string, unknown>;

interface AddMlproxyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: MlproxyConnectionNode) => void;
}

interface MlproxyFormState {
  login: string;
  password: string;
  baseHost: string;
  proxyId: string;
  refreshIntervalMinutes: number;
  caPath: string;
  tlsInsecure: boolean;
}

const MLPROXY_DEFAULT_BASE_HOST = "https://ml.local";
const MLPROXY_DEFAULT_REFRESH_MINUTES = 15;

function createInitialForm(): MlproxyFormState {
  return {
    login: "",
    password: "",
    baseHost: "",
    proxyId: "",
    refreshIntervalMinutes: MLPROXY_DEFAULT_REFRESH_MINUTES,
    caPath: "",
    tlsInsecure: false,
  };
}

export default function AddMlproxyModal({ isOpen, onClose, onCreated }: AddMlproxyModalProps) {
  const t = useTranslations("providers");
  const notify = useNotificationStore();
  const [formData, setFormData] = useState<MlproxyFormState>(() => createInitialForm());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setFormData(createInitialForm());
  }, [isOpen]);

  const baseHostValid = formData.baseHost.trim().startsWith("https://");
  const hasRequiredFields = Boolean(
    formData.login.trim() &&
      formData.password.trim() &&
      formData.proxyId.trim() &&
      baseHostValid
  );

  const handleSubmit = async () => {
    if (!hasRequiredFields) return;
    setSubmitting(true);
    try {
      const body = {
        provider: "mlproxy",
        name: `${t("mlproxy")} - ${formData.proxyId.trim()}`,
        providerSpecificData: {
          login: formData.login.trim(),
          password: formData.password,
          baseHost: formData.baseHost.trim(),
          proxyId: formData.proxyId.trim(),
          refreshIntervalMinutes: formData.refreshIntervalMinutes,
          ...(formData.caPath.trim() ? { caPath: formData.caPath.trim() } : {}),
          tlsInsecure: formData.tlsInsecure,
        },
      };

      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { connection?: MlproxyConnectionNode };
      if (res.ok && data.connection) {
        notify.success(t("mlproxySavedToast"));
        onCreated(data.connection);
        setFormData(createInitialForm());
      } else {
        notify.error(t("mlproxyErrorToast"));
      }
    } catch {
      notify.error(t("mlproxyErrorToast"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t("mlproxy")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label={t("mlproxyLoginLabel")}
          value={formData.login}
          onChange={(e) => setFormData({ ...formData, login: e.target.value })}
          required
        />
        <Input
          label={t("mlproxyPasswordLabel")}
          type="password"
          value={formData.password}
          onChange={(e) => setFormData({ ...formData, password: e.target.value })}
          required
        />
        <Input
          label={t("mlproxyBaseHostLabel")}
          value={formData.baseHost}
          onChange={(e) => setFormData({ ...formData, baseHost: e.target.value })}
          placeholder={MLPROXY_DEFAULT_BASE_HOST}
          error={
            formData.baseHost.trim() && !baseHostValid ? t("mlproxyBaseHostLabel") : undefined
          }
          required
        />
        <Input
          label={t("mlproxyProxyIdLabel")}
          value={formData.proxyId}
          onChange={(e) => setFormData({ ...formData, proxyId: e.target.value })}
          required
        />
        <Input
          label={t("mlproxyRefreshIntervalLabel")}
          type="number"
          value={String(formData.refreshIntervalMinutes)}
          onChange={(e) =>
            setFormData({
              ...formData,
              refreshIntervalMinutes: Number(e.target.value) || MLPROXY_DEFAULT_REFRESH_MINUTES,
            })
          }
        />
        <Input
          label={t("mlproxyCaPathLabel")}
          value={formData.caPath}
          onChange={(e) => setFormData({ ...formData, caPath: e.target.value })}
          placeholder="/etc/omniroute/certs/ca.pem"
        />
        <Toggle
          label={t("mlproxyTlsInsecureLabel")}
          checked={formData.tlsInsecure}
          onChange={(checked) => setFormData({ ...formData, tlsInsecure: checked })}
        />

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!hasRequiredFields || submitting}>
            {submitting ? t("creating") : t("mlproxySaveButton")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            {t("cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
