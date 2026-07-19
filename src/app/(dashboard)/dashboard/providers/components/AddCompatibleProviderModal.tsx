"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { Badge, Button, Input, Modal, Select } from "@/shared/components";

type CompatibleProviderNode = { id: string } & Record<string, unknown>;

interface AddCompatibleProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: CompatibleProviderNode) => void;
}

interface CompatibleFormState {
  name: string;
  prefix: string;
  apiType: string;
  baseUrl: string;
  chatPath: string;
}

const MODE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  type: "openai-compatible" as const,
  chatPath: "",
  hasApiType: true,
};

function createInitialForm(): CompatibleFormState {
  return {
    name: "",
    prefix: "",
    apiType: "chat",
    baseUrl: MODE_DEFAULTS.baseUrl,
    chatPath: MODE_DEFAULTS.chatPath,
  };
}

export default function AddCompatibleProviderModal({
  isOpen,
  onClose,
  onCreated,
}: AddCompatibleProviderModalProps) {
  const t = useTranslations("providers");
  const [formData, setFormData] = useState<CompatibleFormState>(() => createInitialForm());
  const [submitting, setSubmitting] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<"success" | "failed" | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const apiTypeOptions = useMemo(
    () => [
      { value: "chat", label: t("chatCompletions") },
      { value: "responses", label: t("responsesApi") },
      { value: "embeddings", label: t("embeddings") },
      { value: "audio-transcriptions", label: t("audioTranscriptions") },
      { value: "audio-speech", label: t("audioSpeech") },
      { value: "images-generations", label: t("imagesGenerations") },
    ],
    [t]
  );

  useEffect(() => {
    if (!isOpen) return;
    setFormData(createInitialForm());
    setValidationResult(null);
    setCheckKey("");
    setShowAdvanced(false);
  }, [isOpen]);

  const hasRequiredFields = Boolean(
    formData.name.trim() && formData.prefix.trim() && formData.baseUrl.trim()
  );
  const canValidate = Boolean(checkKey.trim() && formData.baseUrl.trim());

  const resetAfterCreate = () => {
    setFormData(createInitialForm());
    setCheckKey("");
    setValidationResult(null);
    setShowAdvanced(false);
  };

  const handleSubmit = async () => {
    if (!hasRequiredFields) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        type: MODE_DEFAULTS.type,
        chatPath: formData.chatPath || "",
      };
      if (MODE_DEFAULTS.hasApiType) body.apiType = formData.apiType;

      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { node: CompatibleProviderNode };
      if (res.ok) {
        onCreated(data.node);
        resetAfterCreate();
      }
    } catch (error) {
      console.log("Error creating compatible node:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const body: Record<string, unknown> = {
        baseUrl: formData.baseUrl,
        apiKey: checkKey,
        type: MODE_DEFAULTS.type,
      };

      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t("addOpenAICompatible")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label={t("nameLabel")}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={t("compatibleProdPlaceholder", { type: t("openai") })}
          hint={t("nameHint")}
        />
        <Input
          label={t("prefixLabel")}
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={t("openaiPrefixPlaceholder")}
          hint={t("prefixHint")}
        />
        {MODE_DEFAULTS.hasApiType && (
          <Select
            label={t("apiTypeLabel")}
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label={t("baseUrlLabel")}
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={t("openaiBaseUrlPlaceholder")}
          hint={t("compatibleBaseUrlHint", { type: t("openai") })}
        />

        <button
          type="button"
          className="text-sm text-text-muted hover:text-text-primary flex items-center gap-1"
          onClick={() => setShowAdvanced(!showAdvanced)}
          aria-expanded={showAdvanced}
          aria-controls="advanced-settings"
        >
          <span
            className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
            aria-hidden="true"
          >
            {">"}
          </span>
          {t("advancedSettings")}
        </button>
        {showAdvanced && (
          <div id="advanced-settings" className="flex flex-col gap-3 pl-2 border-l-2 border-border">
            <Input
              label={t("chatPathLabel")}
              value={formData.chatPath}
              onChange={(e) => setFormData({ ...formData, chatPath: e.target.value })}
              placeholder="/v1/chat/completions"
              hint={t("chatPathHint")}
            />
          </div>
        )}

        <div className="flex gap-2">
          <Input
            label={t("apiKeyForCheck")}
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button
              onClick={handleValidate}
              disabled={!canValidate || validating}
              variant="secondary"
            >
              {validating ? t("checking") : t("check")}
            </Button>
          </div>
        </div>
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? t("valid") : t("invalid")}
          </Badge>
        )}

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
