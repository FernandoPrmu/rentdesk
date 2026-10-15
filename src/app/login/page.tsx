import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { ClearOnLogin } from "@/components/pwa/clear-on-login";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AppShell>
      <ClearOnLogin />
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Sign in</h1>
          </CardTitle>
          <CardDescription>Use the username and password you were given.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Static: ?next= is read when the form is sent, ?reason= by its own Suspense inside. */}
          <LoginForm />
        </CardContent>
      </Card>
    </AppShell>
  );
}
