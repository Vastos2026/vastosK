"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { UserStatusBadge } from "@/components/ui/badge";
import {
  setUserStatus,
  extendTrial,
  deleteUserAccount,
  updateBilling,
  updateDisplayName,
  updateUsageLimit,
} from "./actions";
import type { ConsoleUserRow } from "./types";
import { BILLING_CYCLES } from "@/lib/billing";

const DEFAULT_TRIAL_DAYS = 14;

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function toUsageLimitInputValue(limit: number | null): string {
  return limit === null || limit === undefined ? "" : String(limit);
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

export function UserRow({ user, isSelf }: { user: ConsoleUserRow; isSelf: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [billingCycle, setBillingCycle] = useState(user.billingCycle ?? "");
  const [nextBillingDate, setNextBillingDate] = useState(toDateInputValue(user.nextBillingDate));
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [trialDays, setTrialDays] = useState(String(DEFAULT_TRIAL_DAYS));
  const [usageLimit, setUsageLimit] = useState(toUsageLimitInputValue(user.usageLimitUsd));

  const billingDirty =
    billingCycle !== (user.billingCycle ?? "") ||
    nextBillingDate !== toDateInputValue(user.nextBillingDate);
  const displayNameDirty = displayName.trim() !== (user.displayName ?? "").trim() && displayName.trim() !== "";
  const usageLimitDirty = usageLimit.trim() !== toUsageLimitInputValue(user.usageLimitUsd);
  const trialDaysValue = Number(trialDays);
  const trialDaysValid = Number.isFinite(trialDaysValue) && trialDaysValue > 0;

  function run(task: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await task();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  }

  return (
    <div className="animate-fade-up rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">
            {user.displayName || "Unnamed user"}
          </p>
          {user.email && <p className="truncate text-xs text-muted">{user.email}</p>}
        </div>

        <UserStatusBadge status={user.status} />

        <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted">
          {user.role === "master" ? "Master" : "User"}
        </span>

        <div className="flex items-center gap-1.5">
          {user.status === "suspended" ? (
            <Button
              size="sm"
              variant="secondary"
              icon="CircleCheck"
              disabled={pending}
              onClick={() => run(() => setUserStatus(user.id, "active"))}
            >
              Activate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon="CircleAlert"
              disabled={pending || isSelf}
              title={isSelf ? "You can't suspend your own account" : undefined}
              onClick={() => setConfirmingSuspend(true)}
            >
              Suspend
            </Button>
          )}
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              aria-label="Trial extension in days"
              className="input h-8 w-14 px-2 text-center text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              icon="Clock"
              disabled={pending || !trialDaysValid}
              onClick={() => run(() => extendTrial(user.id, trialDaysValue))}
            >
              Extend trial
            </Button>
          </div>
          <Button
            size="icon"
            variant="ghost"
            icon="Trash2"
            aria-label="Delete user"
            disabled={pending || isSelf}
            title={isSelf ? "You can't delete your own account" : undefined}
            onClick={() => setConfirmingDelete(true)}
          />
        </div>
      </div>

      {formatDate(user.trialEndsAt) && (
        <p className="mt-2 pl-0 text-xs text-faint">Trial ends {formatDate(user.trialEndsAt)}</p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2.5 border-t border-border pt-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Aditi Sharma"
            className="input w-48"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          icon="Check"
          disabled={pending || !displayNameDirty}
          onClick={() => run(() => updateDisplayName(user.id, displayName))}
        >
          Save name
        </Button>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Billing cycle</label>
          <select
            value={billingCycle}
            onChange={(e) => setBillingCycle(e.target.value)}
            className="input w-36 cursor-pointer"
          >
            <option value="">Unset</option>
            {BILLING_CYCLES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Next billing date</label>
          <input
            type="date"
            value={nextBillingDate}
            onChange={(e) => setNextBillingDate(e.target.value)}
            className="input w-40"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          icon="Check"
          disabled={pending || !billingDirty}
          onClick={() =>
            run(() =>
              updateBilling(
                user.id,
                billingCycle || null,
                nextBillingDate ? new Date(nextBillingDate).toISOString() : null,
              ),
            )
          }
        >
          Save billing
        </Button>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Usage limit ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={usageLimit}
            onChange={(e) => setUsageLimit(e.target.value)}
            placeholder="Unlimited"
            className="input w-28"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          icon="Check"
          disabled={pending || !usageLimitDirty}
          onClick={() =>
            run(() =>
              updateUsageLimit(user.id, usageLimit.trim() === "" ? null : Number(usageLimit)),
            )
          }
        >
          Save limit
        </Button>
      </div>

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {confirmingSuspend && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          <span className="flex-1">
            Suspend {user.email || "this user"}? They&apos;ll be signed out and blocked from signing
            back in immediately — as complete a lockout as deleting their account, though nothing is
            actually deleted and you can undo it anytime with Activate.
          </span>
          <button
            onClick={() => {
              setConfirmingSuspend(false);
              run(() => setUserStatus(user.id, "suspended"));
            }}
            className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
          >
            Suspend
          </button>
          <button
            onClick={() => setConfirmingSuspend(false)}
            className="cursor-pointer text-faint hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}

      {confirmingDelete && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          <span className="flex-1">
            Delete {user.email || "this user"}&apos;s account permanently? This can&apos;t be undone.
          </span>
          <button
            onClick={() => {
              setConfirmingDelete(false);
              run(() => deleteUserAccount(user.id));
            }}
            className="cursor-pointer font-semibold underline underline-offset-2 hover:opacity-80"
          >
            Delete
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="cursor-pointer text-faint hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
