"use client";

import { useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";

export interface Person {
  id: string;
  name: string;
  color: string;
  /** This browser tab. */
  self: boolean;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

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
    byId.set(id, {
      id,
      name: name.slice(0, 200),
      color: typeof color === "string" && COLOR.test(color) ? color : "#71717a",
      self: self || (existing?.self ?? false),
    });
  });
  return [...byId.values()].sort(
    (a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name),
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
      {list.map((person) => (
        <li
          key={person.id}
          title={person.self ? `${person.name} (you)` : person.name}
          aria-label={person.self ? `${person.name} (you)` : person.name}
          className="flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white"
          style={{ backgroundColor: person.color }}
        >
          {initials(person.name)}
        </li>
      ))}
    </ul>
  );
}

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
