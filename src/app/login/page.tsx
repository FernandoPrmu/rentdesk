import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata: Metadata = { title: "Sign in" };

// Placeholder: the real login (Supabase Auth, rate limiting, forced password change)
// is built with AUTH-01..12. The form stays disabled until then.
export default function LoginPage() {
  return (
    <AppShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Use the username and password your owner gave you.</CardDescription>
        </CardHeader>
        <CardContent>
          <form aria-describedby="login-status">
            <fieldset disabled className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  className="h-12 text-base"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  className="h-12 text-base"
                />
              </div>
              <Button type="submit" size="lg" className="h-12 w-full text-base">
                Sign in
              </Button>
            </fieldset>
            <p id="login-status" className="mt-4 text-center text-sm text-muted-foreground">
              Sign-in is not available yet.
            </p>
          </form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
