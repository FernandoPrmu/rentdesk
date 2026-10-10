import { e2eConfig } from "./playwright.config";

// `npm run test:e2e:dev`: the same suite against `next dev` (port 3000, reused if already running).
export default e2eConfig(true);
