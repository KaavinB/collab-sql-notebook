"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

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

const button =
  "rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800";
const select =
  "rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700";

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/** The page a share link opens. The token is in the path, never sent anywhere else. */
export function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

/**
 * Who has access to the notebook. The owner also creates and revokes share
 * links and changes or removes members; everyone else can see the members
 * and leave. Closed by default, so opening a notebook doesn't load any of it.
 */
export function SharePanel({ api, notebook }: { api: ApiClient; notebook: Notebook }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const isOwner = notebook.role === "owner";
  return (
    <div className="space-y-2">
      <button
        className={button}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {isOwner ? "Share" : "Members"}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Sharing"
          className="space-y-4 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
        >
          <SharingDetails api={api} notebook={notebook} />
        </section>
      )}
    </div>
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

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
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
    <div className="space-y-2">
      <h2 className="font-medium">Share links</h2>
      <p className="text-xs text-zinc-500">
        Anyone who opens a link and signs in joins with its role. Revoke a link to stop it working.
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs">
          Role
          <select
            aria-label="Role for the new link"
            className={select}
            value={role}
            onChange={(e) => setRole(e.target.value as SharedRole)}
          >
            {SHARED_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button className={button} onClick={() => void create()} disabled={creating}>
          Create link
        </button>
      </div>
      {created && (
        <div className="space-y-1 rounded-md bg-zinc-50 p-2 dark:bg-zinc-900">
          <p className="text-xs">
            New {created.role} link. Copy it now: it won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <input
              aria-label="New share link"
              readOnly
              value={created.url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded border border-zinc-300 bg-transparent px-2 py-0.5 font-mono text-xs dark:border-zinc-700"
            />
            <button className={button} onClick={() => void copy(created.url)}>
              Copy
            </button>
          </div>
          {copied === "yes" && (
            <p role="status" className="text-xs text-emerald-700">
              Copied.
            </p>
          )}
          {copied === "failed" && (
            <p role="status" className="text-xs text-amber-700">
              Couldn&apos;t copy. Select the link and copy it yourself.
            </p>
          )}
        </div>
      )}
      {links.length === 0 ? (
        <p className="text-xs text-zinc-500">No active links.</p>
      ) : (
        <ul className="space-y-1" aria-label="Active share links">
          {links.map((link) => {
            const label = `${link.role} link created ${new Date(link.created_at).toLocaleString()}`;
            return (
              <li key={link.id} className="flex items-center gap-2 text-xs">
                <span className="flex-1">{label}</span>
                <button
                  className={button}
                  onClick={() => void revoke(link)}
                  aria-label={`Revoke ${label}`}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
      <h2 className="font-medium">Members</h2>
      <ul className="space-y-1" aria-label="Members">
        {members.map((member) => {
          const you = member.user_id === me.id;
          const name = you ? `${member.name} (you)` : member.name;
          const manageable = isOwner && member.role !== "owner";
          return (
            <li key={member.user_id} className="flex items-center gap-2 text-xs">
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
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    className={button}
                    onClick={() => void remove(member)}
                    aria-label={`Remove ${member.name}`}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="text-zinc-500" data-testid="member-role">
                  {member.role}
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
            <button
              className={`${button} border-red-500 text-red-600`}
              onClick={() => void leave()}
            >
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
