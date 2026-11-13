"use client";

import { useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface Person {
  id: string;
  name: string;
  color: string;
  /** This browser tab. */
  self: boolean;
  /** The AI assistant, and what it's doing ("thinking" or "suggestion"); null for people. */
  ai: { status: string } | null;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
/**
 * The AI assistant's user ID in awareness. The sync server announces the AI
 * itself and stamps every person's entry with their real user ID (a UUID)
 * from their ticket, so nobody else can show up under this one.
 */
export const AI_USER_ID = "ai-assistant";

/**
 * Everyone connected to the notebook, one entry per person even if they have
 * several tabs open, from the awareness states. The sync server writes each
 * state's `user` from the person's ticket, so names and colors can't be faked.
 */
export function people(awareness: Awareness): Person[] {
  const byId = new Map<string, Person>();
  awareness.getStates().forEach((state, clientId) => {
    const user = (state as { user?: unknown }).user;
    if (typeof user !== "object" || user === null) return;
    const { id, name, color } = user as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return;
    const self = clientId === awareness.clientID;
    const existing = byId.get(id);
    const ai = (state as { ai?: { status?: unknown } }).ai;
    byId.set(id, {
      id,
      name: name.slice(0, 200),
      color: typeof color === "string" && COLOR.test(color) ? color : "#71717a",
      self: self || (existing?.self ?? false),
      ai:
        id === AI_USER_ID && !self
          ? { status: typeof ai?.status === "string" ? ai.status : "" }
          : null,
    });
  });
  // You first, then people by name, then the AI assistant.
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.self) - Number(a.self) ||
      Number(a.ai !== null) - Number(b.ai !== null) ||
      a.name.localeCompare(b.name),
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((part) => [...part][0]?.toUpperCase() ?? "").join("") || "?";
}

/** Who is in the notebook right now, as colored initials. */
export function Presence({ awareness }: { awareness: Awareness | null }) {
  const list = useSyncExternalStore(
    (onChange) => {
      if (!awareness) return () => {};
      awareness.on("change", onChange);
      return () => awareness.off("change", onChange);
    },
    () => (awareness ? cachedPeople(awareness) : EMPTY),
    () => EMPTY,
  );
  if (list.length === 0) return null;
  return (
    <ul aria-label="People in this notebook" className="flex flex-wrap items-center gap-1.5">
      {list.map((person) => {
        const label = person.self
          ? `${person.name} (you)`
          : person.ai
            ? `${person.name}${AI_ACTIVITY[person.ai.status] ?? ""}`
            : person.name;
        return (
          <li
            key={person.id}
            title={label}
            aria-label={label}
            data-ai={person.ai ? "true" : undefined}
            // The AI is a rounded square, not a circle, so it never reads as a person.
            className={`flex h-7 min-w-7 items-center justify-center px-1.5 text-xs font-medium text-white ${person.ai ? "rounded-md" : "rounded-full"}`}
            style={{ backgroundColor: person.color }}
          >
            {person.ai ? "AI" : initials(person.name)}
          </li>
        );
      })}
    </ul>
  );
}

const AI_ACTIVITY: Record<string, string> = {
  thinking: " (thinking)",
  suggestion: " (waiting for a decision on its suggestion)",
};

const EMPTY: Person[] = [];
// useSyncExternalStore needs the same array back until something changes.
const cache = new WeakMap<Awareness, { key: string; list: Person[] }>();
function cachedPeople(awareness: Awareness): Person[] {
  const list = people(awareness);
  const key = JSON.stringify(list);
  const previous = cache.get(awareness);
  if (previous && previous.key === key) return previous.list;
  cache.set(awareness, { key, list });
  return list;
}
