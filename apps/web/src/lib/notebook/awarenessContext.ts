"use client";

import { createContext } from "react";
import type { Awareness } from "y-protocols/awareness";

/**
 * The notebook's awareness (who is here, and where their cursors are), for
 * every editor in the notebook. Null when not connected to the sync server:
 * editors then work without showing collaborators' cursors.
 */
export const AwarenessContext = createContext<Awareness | null>(null);
