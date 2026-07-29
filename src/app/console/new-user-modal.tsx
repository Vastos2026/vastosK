"use client";

import { useActionState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { createUser, type CreateUserState } from "./actions";

const initialState: CreateUserState = {};

export function NewUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, action, pending] = useActionState(createUser, initialState);

  // Close automatically once the account is created; the console page's data
  // refreshes via the action's own revalidatePath("/console").
  useEffect(() => {
    if (state.success) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.success]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user"
      description="Create a client account directly. They sign in with the password you set here."
    >
      <form action={action} className="space-y-4 px-6 py-5">
        <div>
          <label htmlFor="displayName" className="mb-1.5 block text-sm font-medium text-foreground">
            Display name
          </label>
          <input
            id="displayName"
            name="displayName"
            placeholder="e.g. Aditi Sharma"
            className="input w-full"
          />
        </div>
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="client@example.com"
            className="input w-full"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
            Initial password
          </label>
          <input
            id="password"
            name="password"
            type="text"
            required
            minLength={8}
            placeholder="At least 8 characters"
            className="input w-full"
          />
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-foreground">Role</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="radio" name="role" value="user" defaultChecked />
              User
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="radio" name="role" value="master" />
              Master
            </label>
          </div>
        </div>

        {state.error && <ErrorBanner>{state.error}</ErrorBanner>}
        {state.success && <p className="text-sm text-success">{state.success}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Create user
          </Button>
        </div>
      </form>
    </Modal>
  );
}
