# RentDesk

Photocopy machine rental management platform by Ciigus Software.

- Requirements: [`docs/spec.md`](docs/spec.md)
- Progress per requirement ID: [`docs/progress.md`](docs/progress.md)
- Conventions, stack and rules: [`CLAUDE.md`](CLAUDE.md)

## Getting started

Requires Node.js 24 (`nvm use`).

```bash
npm install
cp .env.example .env.local   # then fill in the values
npx supabase login
npx supabase link --project-ref <your-project-ref>
npm run db:push              # apply migrations to the cloud project
npm run dev
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server (service worker disabled) |
| `npm run build` | Production build, then bundles the service worker (`public/sw.js`) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` / `npm run test:e2e` | Vitest unit tests / Playwright on a mobile viewport |
| `npm run db:push` / `npm run db:types` | Push migrations / regenerate `src/types/db.ts` |
