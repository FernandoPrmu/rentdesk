import { Card, CardContent } from "@/components/ui/card";

/** Placeholder for portal sections that later tasks fill in. */
export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <Card>
        <CardContent className="py-2 text-muted-foreground">{text}</CardContent>
      </Card>
    </div>
  );
}
