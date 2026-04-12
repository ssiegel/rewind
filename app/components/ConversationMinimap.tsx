"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../src/types";
import { cn } from "../lib/cn";

const MIN_BUCKETS = 72;
const MAX_BUCKETS = 280;
const PIXELS_PER_BUCKET = 2;

type MessageType = "user" | "assistant" | "tool" | "subagent" | "thinking" | "error";
type BucketType = MessageType | "mixed";

interface MinimapSegment {
  topRatio: number;
  bottomRatio: number;
  type: BucketType;
  startIndex: number;
  endIndex: number;
}

interface MinimapLayout {
  segments: MinimapSegment[];
  compactionRatios: number[];
}

interface BucketAccumulator {
  weights: Record<MessageType, number>;
  startIndex: number | null;
  endIndex: number | null;
}

const EMPTY_WEIGHTS: Record<MessageType, number> = {
  user: 0,
  assistant: 0,
  tool: 0,
  subagent: 0,
  thinking: 0,
  error: 0,
};

const SEGMENT_COLORS: Record<BucketType, string> = {
  user: "bg-semantic-success/65",
  assistant: "bg-accent-opencode/60",
  tool: "bg-semantic-tool/55",
  subagent: "bg-accent-opencode/40",
  thinking: "bg-semantic-thinking/55",
  error: "bg-semantic-error/70",
  mixed: "bg-border-bright/70",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function classifyMessage(message: Message): MessageType {
  if (message.error) return "error";
  if (message.content.some((block) => block.type === "tool_use" && block.subagentSessionId)) {
    return "subagent";
  }
  if (message.content.some((block) => block.type === "thinking")) return "thinking";
  if (message.content.some((block) => block.type === "tool_use" || block.type === "tool_result")) {
    return "tool";
  }
  if (message.role === "user") return "user";
  return "assistant";
}

function hasCompaction(message: Message): boolean {
  return message.content.some((block) => block.type === "compaction");
}

function getDominantBucketType(weights: Record<MessageType, number>): BucketType | null {
  const entries = (Object.entries(weights) as Array<[MessageType, number]>).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[1][1] / entries[0][1] > 0.72) return "mixed";
  return entries[0][0];
}

function buildMinimapLayout(
  container: HTMLDivElement,
  track: HTMLDivElement,
  messages: Message[],
): MinimapLayout {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-msg-idx]"));
  const trackHeight = track.clientHeight;
  const scrollHeight = container.scrollHeight;

  if (rows.length === 0 || trackHeight <= 0 || scrollHeight <= 0) {
    return { segments: [], compactionRatios: [] };
  }

  const bucketCount = clamp(
    Math.round(trackHeight / PIXELS_PER_BUCKET),
    MIN_BUCKETS,
    MAX_BUCKETS,
  );
  const bucketHeight = scrollHeight / bucketCount;
  const containerRect = container.getBoundingClientRect();
  const buckets: BucketAccumulator[] = Array.from({ length: bucketCount }, () => ({
    weights: { ...EMPTY_WEIGHTS },
    startIndex: null,
    endIndex: null,
  }));
  const compactionRatios: number[] = [];

  for (const row of rows) {
    const index = Number.parseInt(row.dataset.msgIdx ?? "", 10);
    if (!Number.isFinite(index)) continue;

    const message = messages[index];
    if (!message) continue;

    const rowRect = row.getBoundingClientRect();
    const top = rowRect.top - containerRect.top + container.scrollTop;
    const height = Math.max(rowRect.height, 1);
    const bottom = top + height;
    const type = classifyMessage(message);

    if (hasCompaction(message)) {
      compactionRatios.push(clamp((top + height / 2) / scrollHeight, 0, 1));
    }

    const startBucket = clamp(Math.floor(top / bucketHeight), 0, bucketCount - 1);
    const endBucket = clamp(Math.ceil(bottom / bucketHeight) - 1, 0, bucketCount - 1);

    for (let bucketIndex = startBucket; bucketIndex <= endBucket; bucketIndex++) {
      const bucketTop = bucketIndex * bucketHeight;
      const bucketBottom = bucketTop + bucketHeight;
      const overlap = Math.max(0, Math.min(bottom, bucketBottom) - Math.max(top, bucketTop));
      if (overlap <= 0) continue;

      const bucket = buckets[bucketIndex];
      bucket.weights[type] += overlap;
      bucket.startIndex = bucket.startIndex == null ? index : Math.min(bucket.startIndex, index);
      bucket.endIndex = bucket.endIndex == null ? index : Math.max(bucket.endIndex, index);
    }
  }

  const segments: MinimapSegment[] = [];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
    const bucket = buckets[bucketIndex];
    const type = getDominantBucketType(bucket.weights);
    if (!type || bucket.startIndex == null || bucket.endIndex == null) continue;

    const topRatio = bucketIndex / bucketCount;
    const bottomRatio = (bucketIndex + 1) / bucketCount;
    const previous = segments[segments.length - 1];

    if (
      previous &&
      previous.type === type &&
      previous.endIndex + 1 >= bucket.startIndex
    ) {
      previous.bottomRatio = bottomRatio;
      previous.endIndex = Math.max(previous.endIndex, bucket.endIndex);
      continue;
    }

    segments.push({
      topRatio,
      bottomRatio,
      type,
      startIndex: bucket.startIndex,
      endIndex: bucket.endIndex,
    });
  }

  return { segments, compactionRatios };
}

export function ConversationMinimap({
  messages,
  scrollContainerRef,
}: {
  messages: Message[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const measureFrameRef = useRef<number | null>(null);
  const scrubFrameRef = useRef<number | null>(null);
  const pendingScrubYRef = useRef<number | null>(null);
  const trackBoundsRef = useRef<{ top: number; height: number } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [layout, setLayout] = useState<MinimapLayout>({ segments: [], compactionRatios: [] });

  const measureLayout = useCallback(() => {
    const container = scrollContainerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;

    setLayout(buildMinimapLayout(container, track, messages));
  }, [messages, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;

    const content = container.firstElementChild;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
        if (measureFrameRef.current != null) return;
        measureFrameRef.current = window.requestAnimationFrame(() => {
          measureFrameRef.current = null;
          measureLayout();
        });
      })
      : null;

    resizeObserver?.observe(track);
    resizeObserver?.observe(container);
    if (content instanceof HTMLElement) resizeObserver?.observe(content);

    if (measureFrameRef.current != null) {
      window.cancelAnimationFrame(measureFrameRef.current);
    }
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measureLayout();
    });

    return () => {
      resizeObserver?.disconnect();
      if (measureFrameRef.current != null) {
        window.cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [measureLayout, scrollContainerRef]);

  const scrollToTrackRatio = useCallback(
    (ratio: number, behavior: ScrollBehavior = "auto") => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const clampedRatio = clamp(ratio, 0, 1);
      const nextTop = clampedRatio * Math.max(container.scrollHeight - container.clientHeight, 0);

      if (behavior === "smooth") {
        container.scrollTo({ top: nextTop, behavior });
        return;
      }

      container.scrollTop = nextTop;
    },
    [scrollContainerRef],
  );

  const updateTrackBounds = useCallback(() => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    trackBoundsRef.current = { top: rect.top, height: rect.height };
  }, []);

  const scrubToPosition = useCallback(
    (clientY: number) => {
      const bounds = trackBoundsRef.current;
      if (!bounds || bounds.height <= 0) return;

      const ratio = clamp((clientY - bounds.top) / bounds.height, 0, 1);
      scrollToTrackRatio(ratio);
    },
    [scrollToTrackRatio],
  );

  const scheduleScrub = useCallback(
    (clientY: number) => {
      pendingScrubYRef.current = clientY;
      if (scrubFrameRef.current != null) return;

      scrubFrameRef.current = window.requestAnimationFrame(() => {
        scrubFrameRef.current = null;
        if (pendingScrubYRef.current != null) scrubToPosition(pendingScrubYRef.current);
      });
    },
    [scrubToPosition],
  );

  const handleTrackPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      updateTrackBounds();
      setIsDragging(true);
      scheduleScrub(event.clientY);
    },
    [scheduleScrub, updateTrackBounds],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (event: PointerEvent) => scheduleScrub(event.clientY);
    const handleStop = () => {
      trackBoundsRef.current = null;
      pendingScrubYRef.current = null;
      setIsDragging(false);
    };
    const handleResize = () => updateTrackBounds();

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleStop);
    window.addEventListener("pointercancel", handleStop);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleStop);
      window.removeEventListener("pointercancel", handleStop);
      window.removeEventListener("resize", handleResize);
    };
  }, [isDragging, scheduleScrub, updateTrackBounds]);

  useEffect(() => {
    return () => {
      if (measureFrameRef.current != null) {
        window.cancelAnimationFrame(measureFrameRef.current);
      }
      if (scrubFrameRef.current != null) {
        window.cancelAnimationFrame(scrubFrameRef.current);
      }
    };
  }, []);

  if (messages.length < 8) return null;

  return (
    <div className="flex h-full w-20 flex-shrink-0 flex-col border-l border-border-dim bg-surface-0 px-2 py-2 select-none">
      <div
        ref={trackRef}
        aria-label="Conversation minimap"
        className={cn(
          "relative flex-1 overflow-hidden rounded-sm border border-border-dim bg-surface-1 touch-none",
          isDragging ? "cursor-grabbing" : "cursor-ns-resize",
        )}
        onPointerDown={handleTrackPointerDown}
      >
        {layout.segments.length === 0 && (
          <div className="absolute inset-0 bg-surface-1" />
        )}

        {layout.segments.map((segment) => (
          <div
            key={`${segment.startIndex}-${segment.endIndex}-${segment.type}`}
            className={cn(
              "pointer-events-none absolute inset-x-1 rounded-[2px] opacity-100",
              SEGMENT_COLORS[segment.type],
            )}
            style={{
              top: `${segment.topRatio * 100}%`,
              height: `${Math.max((segment.bottomRatio - segment.topRatio) * 100, 0.5)}%`,
            }}
            title={`Messages ${segment.startIndex}-${segment.endIndex}`}
          />
        ))}

        {layout.compactionRatios.map((ratio, index) => (
          <div
            key={`compaction-${index}-${ratio}`}
            className="pointer-events-none absolute inset-x-0 h-px bg-semantic-error/70"
            style={{ top: `${ratio * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
