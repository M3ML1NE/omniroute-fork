"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Modal, Select } from "@/shared/components";

type CompatibleProviderNode = { id: string } & Record<string, unknown>;

interface AddGigachatCompatibleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: CompatibleProviderNode) => void;
}

type GigachatApiVersion = "v1" | "v2";

interface GigachatFormState {
  name: string;
  prefix: string;
  baseUrl: string;
  apiVersion: GigachatApiVersion;
  certPath: string;
  keyPath: string;
  caPath: string;
}

const GIGACHAT_DEFAULT_BASE_URL = "https://gigachat.devices.sberbank.ru/api/v1";

function createInitialForm(): GigachatFormState {
  return {
    name: "",
    prefix: "",
    baseUrl: GIGACHAT_DEFAULT_BASE_URL,
    apiVersion: "v1",
    certPath: "",
    keyPath: "",
    caPath: "",
  };
}

export default function AddGigachatCompatibleModal({
  isOpen,
  onClose,
  onCreated,
}: AddGigachatCompatibleModalProps) {
  const t = useTranslations("providers");
  const [formData, setFormData] = useState<GigachatFormState>(() => createInitialForm());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setFormData(createInitialForm());
  }, [isOpen]);

  const hasRequiredFields = Boolean(
    formData.name.trim() &&
    formData.prefix.trim() &&
    formData.certPath.trim() &&
    formData.keyPath.trim() &&
    formData.caPath.trim()
  );

  const handleSubmit = async () => {
    if (!hasRequiredFields) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        type: "gigachat-compatible",
        apiVersion: formData.apiVersion,
        mtls: {
          cert_path: formData.certPath.trim(),
          key_path: formData.keyPath.trim(),
          ca_path: formData.caPath.trim(),
        },
      };

      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { node: CompatibleProviderNode };
      if (res.ok) {
        onCreated(data.node);
        setFormData(createInitialForm());
      }
    } catch (error) {
      console.log("Error creating gigachat-compatible node:", error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t("addGigachatCompatible")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label={t("nameLabel")}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={t("compatibleProdPlaceholder", { type: t("gigachat") })}
          hint={t("nameHint")}
        />
        <Input
          label={t("prefixLabel")}
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={t("gigachatPrefixPlaceholder")}
          hint={t("prefixHint")}
        />
        <Input
          label={t("baseUrlLabel")}
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={GIGACHAT_DEFAULT_BASE_URL}
          hint={t("compatibleBaseUrlHint", { type: t("gigachat") })}
        />
        <Select
          label={t("gigachatApiVersionLabel")}
          value={formData.apiVersion}
          onChange={(e) =>
            setFormData({ ...formData, apiVersion: e.target.value as GigachatApiVersion })
          }
          hint={t("gigachatApiVersionHint")}
          options={[
            { value: "v1", label: t("gigachatApiVersionV1") },
            { value: "v2", label: t("gigachatApiVersionV2") },
          ]}
        />
        <Input
          label={t("mtlsCertLabel")}
          value={formData.certPath}
          onChange={(e) => setFormData({ ...formData, certPath: e.target.value })}
          placeholder="/tmp/secrets/crt.cert"
          hint={t("mtlsCertHint")}
        />
        <Input
          label={t("mtlsKeyLabel")}
          value={formData.keyPath}
          onChange={(e) => setFormData({ ...formData, keyPath: e.target.value })}
          placeholder="/tmp/secrets/crt.key"
          hint={t("mtlsKeyHint")}
        />
        <Input
          label={t("mtlsCaLabel")}
          value={formData.caPath}
          onChange={(e) => setFormData({ ...formData, caPath: e.target.value })}
          placeholder="/tmp/secrets/ca.pem"
          hint={t("mtlsCaHint")}
        />

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!hasRequiredFields || submitting}>
            {submitting ? t("creating") : t("add")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            {t("cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
