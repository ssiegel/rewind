"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * A button that copies text to the clipboard with visual feedback.
 * Shows a checkmark for 2 seconds after a successful copy.
 */
export function CopyButton({
  getText,
  label,
  className,
  size = "sm",
}: {
  /** Function that returns the text to copy. Called on click. */
  getText: () => string;
  /** Button label text. */
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [getText]);

  const Icon = copied ? Check : Copy;
  const iconSize = size === "sm" ? 11 : 13;

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border font-mono transition-colors duration-100",
        size === "sm" ? "px-2 py-1 text-[10px]" : "px-2.5 py-1 text-[11px]",
        copied
          ? "border-semantic-success/30 bg-semantic-success/8 text-semantic-success"
          : "border-border-dim bg-surface-2 text-text-secondary hover:border-border-bright hover:text-text-primary",
        className,
      )}
      title={copied ? "Copied!" : label ?? "Copy to clipboard"}
    >
      <Icon size={iconSize} className="flex-shrink-0" />
      {label && <span>{copied ? "Copied!" : label}</span>}
    </button>
  );
}
