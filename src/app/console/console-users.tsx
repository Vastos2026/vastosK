"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { UserRow } from "./user-row";
import { NewUserModal } from "./new-user-modal";
import type { ConsoleUserRow } from "./types";

export function ConsoleUsers({ users, currentUserId }: { users: ConsoleUserRow[]; currentUserId: string }) {
  const [query, setQuery] = useState("");
  const [newUserOpen, setNewUserOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.displayName ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email"
            className="input w-full pl-9"
          />
        </div>
        <Button icon="Plus" onClick={() => setNewUserOpen(true)}>
          New user
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-center">
          <div>
            <Icon name="UserRound" className="mx-auto size-8 text-faint" />
            <p className="mt-3 text-sm text-muted">
              {users.length === 0 ? "No users yet." : "No users match your search."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((u) => (
            <UserRow key={u.id} user={u} isSelf={u.id === currentUserId} />
          ))}
        </div>
      )}

      {/* Remounted fresh each open, so a prior submission's success/error
          state (held in useActionState) never leaks into the next open. */}
      {newUserOpen && <NewUserModal open={newUserOpen} onClose={() => setNewUserOpen(false)} />}
    </div>
  );
}
