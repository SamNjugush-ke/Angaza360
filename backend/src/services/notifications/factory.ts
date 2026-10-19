// ===========================================================================
// Notification provider factory (Task T-A3).
//
// The ONLY place a concrete notification provider is named, and the ONLY consumer
// of a decrypted notification credential. Everything else depends on the
// SmsProvider / EmailProvider interfaces in ./provider.ts.
//
// Two levers, both config:
//   NOTIFICATION_SMS_PROVIDER / NOTIFICATION_EMAIL_PROVIDER (deployment, in env)
//       -> which implementation each channel uses; default "simulated".
//   the platform's ACTIVE credential row (public.platform_integration_credentials)
//       -> the live provider's secrets, decrypted by the credential store (the
//          system's single decryptor) and handed to the constructor here.
//
// Construction is PER SEND, never a singleton, exactly as the M-Pesa factory builds
// per request: rotating Angaza's SMS key is activating a new credential row, with no
// restart. A live provider without an ACTIVE credential fails the send with
// NoActivePlatformCredentialError — there is no fallback to the simulator, because
// "the code was never sent" must never look like "the code was sent".
// ===========================================================================

import { env } from "../../config/env";
import {
  getActiveAfricasTalkingCredentialFields,
  getActiveSendgridCredentialFields,
} from "../credentials/credential-store";
import { AfricasTalkingSmsProvider } from "./africastalking-provider";
import type { EmailProvider, SmsProvider } from "./provider";
import { SendgridEmailProvider } from "./sendgrid-provider";
import { SimulatedNotificationProvider } from "./simulated-provider";

export async function getSmsProvider(): Promise<SmsProvider> {
  const providerName = env.notifications.smsProvider;
  switch (providerName) {
    case "simulated":
      return new SimulatedNotificationProvider();
    case "africastalking":
      return new AfricasTalkingSmsProvider(await getActiveAfricasTalkingCredentialFields());
    default: {
      const exhaustive: never = providerName;
      throw new Error(`Unknown NOTIFICATION_SMS_PROVIDER "${String(exhaustive)}".`);
    }
  }
}

export async function getEmailProvider(): Promise<EmailProvider> {
  const providerName = env.notifications.emailProvider;
  switch (providerName) {
    case "simulated":
      return new SimulatedNotificationProvider();
    case "sendgrid":
      return new SendgridEmailProvider(await getActiveSendgridCredentialFields());
    default: {
      const exhaustive: never = providerName;
      throw new Error(`Unknown NOTIFICATION_EMAIL_PROVIDER "${String(exhaustive)}".`);
    }
  }
}
