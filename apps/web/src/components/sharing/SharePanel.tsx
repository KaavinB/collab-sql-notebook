"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Dialog } from "@/components/Dialog";
import {
  dangerButton,
  primaryButton,
  secondaryButton,
  smallButton,
  smallField,
} from "@/components/ui";

import {
  ApiError,
  SHARED_ROLES,
  type ApiClient,
  type Member,
  type Notebook,
  type ShareLink,
  type SharedRole,
  type User,
} from "@/lib/api";

const button = smallButton;
const select = smallField;

/** Roles in words: what the person can do. */
export const ROLE_LABELS: Record<Member["role"], string> = {
  owner: "Owner",
  editor: "Can edit",
  viewer: "Can view",
};
const LINK_ROLE_LABELS: Record<SharedRole, string> = {
  editor: "edit",
  viewer: "view",
};
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/** The page a share link opens. The token is in the path, never sent anywhere else. */
export function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

/**
 * Who has access to the notebook, in a dialog opened from the notebook's
 * header. The owner also creates and revokes share links and changes or
 * removes members; everyone else can see the members and leave. Nothing is
 * loaded until the dialog opens.
 */
export function SharePanel({ api, notebook }: { api: ApiClient; notebook: Notebook }) {
  const [open, setOpen] = useState(false);
  const isOwner = notebook.role === "owner";
  return (
    <>
      <button
        className={isOwner ? primaryButton : secondaryButton}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        title={isOwner ? "Invite people with a link" : "See who has access"}
      >
        {isOwner && <ShareIcon />}
        {isOwner ? "Share" : "Members"}
      </button>
      {open && (
        <Dialog
          title={isOwner ? `Share “${notebook.title}”` : "People with access"}
          description={
            isOwner
              ? "Invite people with a link. They sign in, then see the notebook live, with you."
              : undefined
          }
          onClose={() => setOpen(false)}
        >
          <section aria-label="Sharing" className="space-y-6 text-sm">
            <SharingDetails api={api} notebook={notebook} />
          </section>
        </Dialog>
      )}
    </>
  );
}

function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4 fill-none stroke-current stroke-[1.5]"
    >
      <path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SharingDetails({ api, notebook }: { api: ApiClient; notebook: Notebook }) {
  const isOwner = notebook.role === "owner";
  const [me, setMe] = useState<User | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.me(),
      api.listMembers(notebook.id),
      isOwner ? api.listShareLinks(notebook.id) : Promise.resolve(null),
    ]).then(
      ([user, memberList, linkList]) => {
        if (cancelled) return;
        setMe(user);
        setMembers(memberList);
        setLinks(linkList);
      },
      (e: unknown) => !cancelled && setError(message(e, "Could not load the members.")),
    );
    return () => {
      cancelled = true;
    };
  }, [api, notebook.id, isOwner]);

  if (!members || !me) {
    return error ? (
      <p role="alert" className="text-red-600">
        {error}
      </p>
    ) : (
      <p className="text-zinc-500">Loading…</p>
    );
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {isOwner && links && (
        <ShareLinks
          api={api}
          notebookId={notebook.id}
          links={links}
          setLinks={setLinks}
          setError={setError}
        />
      )}
      <Members
        api={api}
        notebookId={notebook.id}
        me={me}
        isOwner={isOwner}
        members={members}
        setMembers={setMembers}
        setError={setError}
      />
    </>
  );
}

function ShareLinks({
  api,
  notebookId,
  links,
  setLinks,
  setError,
}: {
  api: ApiClient;
  notebookId: string;
  links: ShareLink[];
  setLinks: (update: (links: ShareLink[] | null) => ShareLink[] | null) => void;
  setError: (error: string | null) => void;
}) {
  const [role, setRole] = useState<SharedRole>("viewer");
  const [creating, setCreating] = useState(false);
  // The full URL of the link just created. The token is only ever returned
  // once, so this is the only chance to copy it.
  const [created, setCreated] = useState<{ url: string; role: SharedRole } | null>(null);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const link = await api.createShareLink(notebookId, role);
      setCreated({ url: shareUrl(link.token), role: link.role });
      setCopied(null);
      setLinks((prev) => [
        ...(prev ?? []),
        { id: link.id, role: link.role, created_at: link.created_at },
      ]);
      setError(null);
    } catch (e) {
      setError(message(e, "Could not create the link."));
    } finally {
      setCreating(false);
    }
  };

  // The button says "Copied" for a moment, then goes back to "Copy link",
  // so copying again gives fresh feedback.
  const resetCopied = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetCopied.current), []);
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
      clearTimeout(resetCopied.current);
      resetCopied.current = setTimeout(() => setCopied(null), 2500);
    } catch {
      setCopied("failed");
    }
  };

  const revoke = async (link: ShareLink) => {
    try {
      await api.revokeShareLink(notebookId, link.id);
      setLinks((prev) => prev?.filter((l) => l.id !== link.id) ?? null);
      setError(null);
    } catch (e) {
      setError(message(e, "Could not revoke the link."));
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Invite with a link</h3>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          Anyone with the link can
          <select
            aria-label="Role for the new link"
            className={select}
            value={role}
            onChange={(e) => setRole(e.target.value as SharedRole)}
          >
            {SHARED_ROLES.map((r) => (
              <option key={r} value={r}>
                {LINK_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button className={primaryButton} onClick={() => void create()} disabled={creating}>
          Create link
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        {role === "editor"
          ? "Editors can change cells, run queries and ask the AI."
          : "Viewers see everything live but can't change anything or run queries."}{" "}
        People sign in before they join.
      </p>
      {created && (
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
          <p>
            Link ready: anyone with it can <strong>{LINK_ROLE_LABELS[created.role]}</strong>. Copy
            it now: it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <input
              aria-label="New share link"
              readOnly
              value={created.url}
              onFocus={(e) => e.currentTarget.select()}
              className={`${select} flex-1 font-mono`}
            />
            <button className={primaryButton} onClick={() => void copy(created.url)}>
              {copied === "yes" ? "Copied" : "Copy link"}
            </button>
          </div>
          {copied === "yes" && (
            <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
              Link copied. Paste it in a message to invite someone.
            </p>
          )}
          {copied === "failed" && (
            <p role="status" className="text-xs text-amber-700">
              Couldn&apos;t copy. Select the link and copy it yourself.
            </p>
          )}
        </div>
      )}
      <div className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Active links</h4>
        {links.length === 0 ? (
          <p className="text-xs text-zinc-500">No active links.</p>
        ) : (
          <ul
            className="divide-y divide-zinc-100 dark:divide-zinc-800"
            aria-label="Active share links"
          >
            {links.map((link) => {
              const label = `Anyone with this link can ${LINK_ROLE_LABELS[link.role]}, created ${dateFormat.format(new Date(link.created_at))}`;
              return (
                <li key={link.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="flex-1">{label}</span>
                  <button
                    className={dangerButton}
                    onClick={() => void revoke(link)}
                    aria-label={`Revoke link: ${label}`}
                    title="Stop this link working. People who already joined keep their access."
                  >
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Members({
  api,
  notebookId,
  me,
  isOwner,
  members,
  setMembers,
  setError,
}: {
  api: ApiClient;
  notebookId: string;
  me: User;
  isOwner: boolean;
  members: Member[];
  setMembers: (update: (members: Member[] | null) => Member[] | null) => void;
  setError: (error: string | null) => void;
}) {
  const router = useRouter();
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const changeRole = async (member: Member, role: SharedRole) => {
    try {
      const updated = await api.updateMember(notebookId, member.user_id, role);
      setMembers(
        (prev) =>
          prev?.map((m) => (m.user_id === member.user_id ? { ...m, role: updated.role } : m)) ??
          null,
      );
      setError(null);
    } catch (e) {
      setError(message(e, "Could not change the role."));
    }
  };

  const remove = async (member: Member) => {
    try {
      await api.removeMember(notebookId, member.user_id);
      setMembers((prev) => prev?.filter((m) => m.user_id !== member.user_id) ?? null);
      setError(null);
    } catch (e) {
      setError(message(e, "Could not remove the member."));
    }
  };

  const leave = async () => {
    try {
      await api.removeMember(notebookId, me.id);
      router.replace("/");
    } catch (e) {
      setConfirmingLeave(false);
      setError(message(e, "Could not leave the notebook."));
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="font-semibold">People with access</h3>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" aria-label="Members">
        {members.map((member) => {
          const you = member.user_id === me.id;
          const name = you ? `${member.name} (you)` : member.name;
          const manageable = isOwner && member.role !== "owner";
          return (
            <li key={member.user_id} className="flex items-center gap-2 py-1.5">
              <span className="flex-1">{name}</span>
              {manageable ? (
                <>
                  <select
                    aria-label={`Role for ${member.name}`}
                    className={select}
                    value={member.role}
                    onChange={(e) => void changeRole(member, e.target.value as SharedRole)}
                  >
                    {SHARED_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    className={dangerButton}
                    onClick={() => void remove(member)}
                    aria-label={`Remove ${member.name}`}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="text-xs text-zinc-500" data-testid="member-role">
                  {ROLE_LABELS[member.role]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {isOwner && members.some((member) => member.role !== "owner") && (
        <p className="text-xs text-zinc-500" data-testid="remove-note">
          Removing someone doesn&apos;t revoke the links they used. Revoke those too, or they can
          join again.
        </p>
      )}
      {!isOwner &&
        (confirmingLeave ? (
          <div className="flex items-center gap-2 text-xs">
            <span>You&apos;ll lose access unless someone shares it with you again.</span>
            <button className={dangerButton} onClick={() => void leave()}>
              Confirm leave
            </button>
            <button className={button} onClick={() => setConfirmingLeave(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className={button} onClick={() => setConfirmingLeave(true)}>
            Leave notebook
          </button>
        ))}
    </div>
  );
}
