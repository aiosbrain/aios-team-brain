import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { SignOutButton } from "@/components/account/sign-out-button";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Account</h1>
        <p className="mt-1 text-sm text-ink-secondary">Manage your sign-in password.</p>
      </div>
      <ChangePasswordForm />
      <div className="border-t border-border-subtle pt-4">
        <SignOutButton />
      </div>
    </div>
  );
}
