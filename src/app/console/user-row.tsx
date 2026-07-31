"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { UserStatusBadge } from "@/components/ui/badge";
import {
  setUserStatus,
  deleteUserAccount,
  updateBilling,
  updateDisplayName,
  updateUsageLimit,
  updateScheduledStop,
} from "./actions";
import type { ConsoleUserRow } from "./types";
import { BILLING_CYCLES, computeCurrentBillingDate, isBillingCycle } from "@/lib/billing";
import { istDateInputToIso, isoToISTDateInput } from "@/lib/ist-date";

function toUsageLimitInputValue(limit: number | null): string {
  return limit === null || limit === undefined ? "" : String(limit);
}

// Explicit locale + options, not the runtime default: `toLocaleDateString()`
// with no arguments formats differently between Node (SSR) and the browser
// (CSR) even when both "are" the same locale — Node's bundled ICU data and a
// browser's full ICU implementation don't always agree on things like
// leading zeros, which is a real hydration mismatch (found live: server
// rendered "31/7/2026", client rendered "31/07/2026" for the same instant).
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function UserRow({ user, isSelf }: { user: ConsoleUserRow; isSelf: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [billingCycle, setBillingCycle] = useState(user.billingCycle ?? "");
  const [nextBillingDate, setNextBillingDate] = useState(isoToISTDateInput(user.nextBillingDate));
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [usageLimit, setUsageLimit] = useState(toUsageLimitInputValue(user.usageLimitUsd));
  const [scheduledStop, setScheduledStop] = useState(isoToISTDateInput(user.scheduledStopAt));
  // Transient "Saved" confirmations, keyed by field — item 1's real fix: the
  // save mechanism itself already worked, but nothing told the admin their
  // change actually landed, which reads as "did this even save?" every time.
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const billingDirty =
    billingCycle !== (user.billingCycle ?? "") ||
    nextBillingDate !== isoToISTDateInput(user.nextBillingDate);
  const displayNameDirty = displayName.trim() !== (user.displayName ?? "").trim() && displayName.trim() !== "";
  const usageLimitDirty = usageLimit.trim() !== toUsageLimitInputValue(user.usageLimitUsd);
  const scheduledStopDirty = scheduledStop !== isoToISTDateInput(user.scheduledStopAt);

  // The billing input holds the ANCHOR date; this is the currently-active
  // "next billing date" rolled forward from it — shown read-only next to the
  // input so an admin can see the auto-advance working without needing to
  // re-enter anything every renewal.
  const liveBillingDate =
    user.nextBillingDate && user.billingCycle && isBillingCycle(user.billingCycle)
      ? computeCurrentBillingDate(user.nextBillingDate, user.billingCycle)
      : null;

  function run(task: () => Promise<void>, savedKey?: string) {
    setError(null);
    startTransition(async () => {
      try {
        await task();
        router.refresh();
        if (savedKey) {
          setSaved((s) => ({ ...s, [savedKey]: true }));
          setTimeout(() => setSaved((s) => ({ ...s, [savedKey]: false })), 2000);
        }
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

      {formatDate(user.scheduledStopAt) && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
          <Icon name="CircleAlert" className="size-3.5 shrink-0" />
          Scheduled to stop on {formatDate(user.scheduledStopAt)}
        </p>
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
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            icon="Check"
            disabled={pending || !displayNameDirty}
            onClick={() => run(() => updateDisplayName(user.id, displayName), "name")}
          >
            Save name
          </Button>
          {saved.name && <span className="text-xs text-success">Saved</span>}
        </div>

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
          <label className="text-xs text-muted">Billing anchor date</label>
          <input
            type="date"
            value={nextBillingDate}
            onChange={(e) => setNextBillingDate(e.target.value)}
            className="input w-40"
          />
        </div>
        <div className="flex items-center gap-1.5">
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
                  nextBillingDate ? istDateInputToIso(nextBillingDate) : null,
                ),
              "billing")
            }
          >
            Save billing
          </Button>
          {saved.billing && <span className="text-xs text-success">Saved</span>}
        </div>

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
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            icon="Check"
            disabled={pending || !usageLimitDirty}
            onClick={() =>
              run(() =>
                updateUsageLimit(user.id, usageLimit.trim() === "" ? null : Number(usageLimit)),
              "limit")
            }
          >
            Save limit
          </Button>
          {saved.limit && <span className="text-xs text-success">Saved</span>}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">Scheduled stop</label>
          <input
            type="date"
            value={scheduledStop}
            onChange={(e) => setScheduledStop(e.target.value)}
            className="input w-40"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            icon="Check"
            disabled={pending || !scheduledStopDirty || isSelf}
            title={isSelf ? "You can't schedule a stop on your own account" : undefined}
            onClick={() =>
              run(() =>
                updateScheduledStop(
                  user.id,
                  scheduledStop ? istDateInputToIso(scheduledStop) : null,
                ),
              "stop")
            }
          >
            {scheduledStop ? "Save stop date" : "Clear stop"}
          </Button>
          {saved.stop && <span className="text-xs text-success">Saved</span>}
        </div>
      </div>

      {liveBillingDate && (
        <p className="mt-2 text-[11px] text-faint">
          Currently active next billing date: {liveBillingDate.toISOString().slice(0, 10)} — advances on its own each cycle.
        </p>
      )}

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
