import { z } from "zod";

// Browser only (imported by a root-layout client component): Zod 4 probes `new Function`
// to decide whether to compile object schemas, and the strict CSP (decision 87) reports
// that probe as a violation even though Zod catches it. Without JIT the parsing is the
// same, just not compiled; the server keeps JIT.
z.config({ jitless: true });
