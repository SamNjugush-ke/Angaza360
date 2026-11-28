// Seeds ANGAZA'S OWN notification credentials into the encrypted platform store
// (public.platform_integration_credentials) from the git-ignored `.env.integrations.local`
// (M4.5 W4). The live email and SMS providers read ONLY that store, never env — this script is
// the operator's way of putting the values there.
//
// Usage: npm run seed:platform-credentials [-- --environment sandbox|production] [--file <path>]
//
//   SMTP           from SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM
//                  (SMTP_FROM may be "Name <address>" or a bare address)
//   AFRICASTALKING from AFRICASTALKING_USERNAME, AFRICASTALKING_API_KEY (and AFRICASTALKING_SENDER_ID)
//
// A provider is seeded only when its variables are all present. Each row is validated against
// the provider's shape before it is stored, encrypted (AES-256-GCM), and made ACTIVE. The file is
// read with dotenv.parse, so nothing enters process.env. NOTHING IS PRINTED BUT THE SAFE VIEW
// (provider, environment, status) — never a value. The environment defaults to the one this
// deployment reads (production when NODE_ENV=production, otherwise sandbox).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { closePool } from "../db/pool";
import { platformDb } from "../db/platform";
import { platformCredentialEnvironment, putActivePlatformCredential, type PlatformCredentialEnvironment } from "../services/credentials/credential-store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** "Angaza360 <hello@example.com>" -> name + address; a bare address -> address only. */
export function splitFrom(raw: string): { fromEmail: string; fromName?: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(raw);
  if (match) {
    const name = (match[1] ?? "").trim();
    return name === "" ? { fromEmail: match[2] ?? "" } : { fromEmail: match[2] ?? "", fromName: name };
  }
  return { fromEmail: raw.trim() };
}

async function main(): Promise<void> {
  const file = resolve(arg("--file") ?? ".env.integrations.local");
  const requested = arg("--environment");
  if (requested !== undefined && requested !== "sandbox" && requested !== "production") {
    throw new Error('--environment must be "sandbox" or "production".');
  }
  const environment: PlatformCredentialEnvironment = requested ?? platformCredentialEnvironment();
  const values = parse(readFileSync(file));
  const present = (...names: string[]) => names.every((name) => (values[name] ?? "").trim() !== "");

  const seeded: string[] = [];
  if (present("SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM")) {
    const from = splitFrom(values.SMTP_FROM ?? "");
    const row = await putActivePlatformCredential(
      "SMTP",
      environment,
      {
        host: (values.SMTP_HOST ?? "").trim(),
        port: (values.SMTP_PORT ?? "").trim(),
        ...((values.SMTP_SECURE ?? "").trim() !== "" ? { secure: (values.SMTP_SECURE ?? "").trim().toLowerCase() } : {}),
        username: (values.SMTP_USERNAME ?? "").trim(),
        password: values.SMTP_PASSWORD ?? "",
        fromEmail: from.fromEmail,
        ...(from.fromName !== undefined ? { fromName: from.fromName } : {}),
      },
      "seeded from .env.integrations.local",
    );
    seeded.push(`${row.provider} (${row.environment}) ${row.status}`);
  }
  if (present("AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY")) {
    const row = await putActivePlatformCredential(
      "AFRICASTALKING",
      environment,
      {
        username: (values.AFRICASTALKING_USERNAME ?? "").trim(),
        apiKey: (values.AFRICASTALKING_API_KEY ?? "").trim(),
        ...((values.AFRICASTALKING_SENDER_ID ?? "").trim() !== "" ? { senderId: (values.AFRICASTALKING_SENDER_ID ?? "").trim() } : {}),
      },
      "seeded from .env.integrations.local",
    );
    seeded.push(`${row.provider} (${row.environment}) ${row.status}`);
  }
  console.log(seeded.length === 0 ? "Nothing to seed: no complete SMTP_* or AFRICASTALKING_* set in the file." : `Seeded: ${seeded.join("; ")}.`);
}

// Run only as a script: importing splitFrom (the tests do) must not seed anything.
if (require.main === module) {
  void run();
}

async function run(): Promise<void> {
  await main()
  .catch((error: unknown) => {
    // The error's NAME only: a validation message names a field, never a value, but a driver
    // error is not vetted.
    console.error(`seed:platform-credentials failed: ${error instanceof Error ? `${error.name}: ${error.name === "CredentialValidationError" ? error.message : "see the database logs"}` : "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await platformDb.$disconnect();
    await closePool();
  });
}
