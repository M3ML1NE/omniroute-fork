"use client";

import PayloadRulesTab from "../components/PayloadRulesTab";
import RequestLimitsTab from "../components/RequestLimitsTab";

export default function SettingsAdvancedPage() {
  return (
    <div className="space-y-6">
      <PayloadRulesTab />
      <RequestLimitsTab />
    </div>
  );
}
