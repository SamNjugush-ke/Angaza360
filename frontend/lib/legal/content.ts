// The final, reviewed public legal copy for Angaza360, authored verbatim from the approved legal
// package. Operator details, dates and figures are already final in the text (no tokens required).
// Bodies use "## "/"### " headings, "- " bullets, **bold**, *italic*, `code`, [text](href) links
// and (if ever reintroduced) [[TOKENS]]. Rendered by components/legal/legal-text.tsx.
//
// Five documents are linked from the footer (Privacy, Terms, Cookie, Acceptable Use, Contact).
// Four more (Billing, Data Processing Agreement, Service Providers, Security) are reachable ONLY
// through in-text cross-links and are never placed in the footer nav or the sitemap.

export interface LegalDocument {
  readonly title: string;
  /** The document's body as written: headings, paragraphs, "- " bullets, **bold**, *italic*, `code`, [text](href) links. */
  readonly body: string;
}

export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  body: `**Effective date: 1 January 2027**

Angaza360 is operated by **Angaza Future International** ("we", "us" or "our"). This policy explains how personal information is handled when you visit our website, apply for an account or use the Angaza360 business management platform.

## Information we collect

Depending on your use of Angaza360, we process:

- **Account and application details:** names, contact information, business details, identification or verification documents where requested, assigned user roles and application decisions.
- **Business records:** information entered by authorised users, such as sales, customers, suppliers, inventory, payments, expenses, employees, payroll and financial reports.
- **Security and usage information:** sign-in activity, device and browser information, necessary cookies and records of important actions taken in the platform.
- **Communications:** enquiries, support requests, account notifications and related correspondence.

Some information is required to register, verify or operate an account; other information is optional. If required information is not provided, we may be unable to provide the relevant service or feature.

## How we use information

We use personal information to provide the service, assess account applications, verify and protect accounts, support business operations, deliver essential notifications, investigate misuse and meet legal obligations. Where applicable, we may rely on performance of a contract, legal obligations, legitimate interests or consent, as permitted by Kenyan law.

We do not sell personal information to advertisers. We do not use business records for unrelated advertising.

## Business information and access

Businesses generally control the personal information they enter about their customers, employees and suppliers. Each business is responsible for collecting and using that information lawfully and informing the people concerned. Angaza Future International processes such information to provide the service under the [Data Processing Agreement](/data-processing-agreement).

Access to a business workspace is limited according to assigned permissions. Authorised Angaza360 personnel may access business information and perform supported actions where reasonably necessary for service administration, assistance, security or compliance. Important activities are recorded in the platform's audit history.

Where business information is shared with an authorised mentor or programme representative, access is subject to the permissions and consent applicable to that engagement.

## When information is shared

Information may be shared with authorised users of the relevant business, service providers needed for hosting, security, communications and payments, and other parties where authorised by the business or required by law. Service providers are subject to appropriate confidentiality and data-protection obligations. More information is provided in our [Service Providers and Data Transfers Notice](/subprocessors).

Some information may be processed outside Kenya. Where this occurs, we apply safeguards required by applicable data-protection law.

## Security and retention

We use appropriate access controls, protected communications, safeguards for sensitive information and activity records to help protect data.

We retain information only for as long as needed to provide the service, protect legitimate interests and comply with applicable legal or record-keeping obligations. When information is no longer required, it is deleted or de-identified in accordance with applicable retention and backup processes. Certain financial and audit records may need to be retained even after an account closes.

## Your privacy rights

Under Kenyan law, you may have the right to access, correct or request deletion of your personal information, object to certain uses, withdraw consent where processing relies on consent, and exercise other applicable data-protection rights.

To make a request, use our [Contact page](/contact). We may verify your identity before acting. If your request concerns information entered by a business, we may refer it to that business as the party responsible for the information.

You may also lodge a complaint with Kenya's [Office of the Data Protection Commissioner](https://www.odpc.go.ke/).

## Updates

We may update this policy to reflect changes in our services or legal requirements. The current version will be published on this page, with notice of material changes where required.`,
};

export const TERMS_OF_SERVICE: LegalDocument = {
  title: "Terms of Service",
  body: `**Effective date: 1 January 2027**

These Terms govern the use of **Angaza360**, a business management platform operated by **Angaza Future International** ("Angaza", "we", "us" or "our"). By creating or using an account, you agree to these Terms. If you accept them on behalf of a business, you confirm that you are authorised to do so.

## 1. Our service

Angaza360 provides tools for business operations, including sales, inventory, purchasing, expenses, accounting, payroll, reporting and authorised business support activities. Available functions depend on the account, permissions and service plan.

We may maintain, improve or change the service from time to time. We will communicate material changes where required by law or an applicable service agreement.

## 2. Accounts and authorised users

You must provide accurate information and keep it reasonably up to date. We may verify applications before approving access. Each user must protect their sign-in details and use only the permissions granted to them.

A business is responsible for its authorised users, including assigning appropriate access and removing access when a person no longer needs it. Accounts must not be shared or used to impersonate another person.

## 3. Business records and responsibilities

The business retains ownership of the information it lawfully enters into Angaza360. You authorise us to process that information as reasonably required to deliver and protect the service, subject to our [Privacy Policy](/privacy) and [Data Processing Agreement](/data-processing-agreement).

The business remains responsible for the accuracy of its records, the legality of information it enters, its customers and employees, and its accounting, tax, payroll and other statutory obligations. Reports and calculations depend on the data supplied and settings selected. You should review them before making important decisions or statutory submissions.

Completed financial entries may require corrections through authorised adjustments or reversals so that transaction histories remain reliable.

## 4. Payments and external services

Where payment or messaging features are used, they may depend on third-party providers and the business's own arrangements with those providers. Provider charges, delays and terms may apply separately. Angaza360 is not a bank and does not hold a merchant's funds merely by recording or facilitating a payment.

The business is responsible for issuing any legally required tax invoices and making required filings using an authorised process.

## 5. Service access and support

We take reasonable steps to operate and secure Angaza360, but access may occasionally be affected by maintenance, connectivity issues or circumstances beyond our reasonable control. Unless expressly agreed otherwise, no particular uptime level or uninterrupted service is guaranteed.

Authorised Angaza personnel may access a business workspace and perform supported activities when reasonably necessary to administer, protect or assist with the service. Such activity is subject to access controls and audit records.

## 6. Fees and subscriptions

Applicable plans, features and prices are published on our [Pricing page](https://www.angaza360.co.ke/#pricing). The applicable billing period, charges, taxes and any renewal conditions will be stated in the plan or agreement accepted by the business.

Our [Billing, Cancellation and Refund Policy](/billing-policy) applies to payments, renewals, cancellations and refund requests.

## 7. Acceptable use

You must use Angaza360 only for lawful and authorised purposes, and comply with our [Acceptable Use Policy](/acceptable-use). We may restrict or suspend access where reasonably necessary to address misuse, serious security risks, unlawful activity, material breach of these Terms or payment default under an applicable agreement.

Where appropriate, we will provide notice and an opportunity to resolve the issue. We may act immediately where necessary to protect users, information or the service.

## 8. Cancellation and account closure

An authorised business representative may request cancellation through our [Contact page](/contact), subject to the applicable subscription terms. Where reasonably practicable, we will provide access to available data-export functions before closure. Information will be handled after closure in accordance with the Privacy Policy, Data Processing Agreement and applicable law.

## 9. Ownership of the platform

Angaza Future International or its licensors retain ownership of the platform, software, branding and related materials. You receive a limited right to use the service for your authorised business purposes during your service agreement. You may not copy, resell or interfere with the platform except as permitted by law or our written agreement.

## 10. Liability and disputes

We provide the service with reasonable care and skill. To the extent permitted by law, we are not liable for indirect or consequential losses arising from use of the service. Our aggregate liability for ordinary contractual claims will not exceed the service fees paid to us for the affected service during the preceding 12 months, or **KES 50,000** where no fees were paid. These limits do not apply where liability cannot lawfully be excluded or limited, including fraud or other non-excludable statutory rights.

These Terms are governed by the laws of Kenya. The parties will first try to resolve disputes in good faith. Subject to any mandatory legal rights, disputes may be brought before the competent courts in Nairobi, Kenya.

## 11. Other terms

Our [Privacy Policy](/privacy), [Cookie Policy](/cookies), [Acceptable Use Policy](/acceptable-use), [Billing Policy](/billing-policy) and, where applicable, [Data Processing Agreement](/data-processing-agreement) form part of the service terms. If a separately accepted service agreement addresses a particular commercial matter, it takes precedence for that matter.

We may update these Terms with appropriate notice of material changes. Continued use after a change takes effect constitutes acceptance where permitted by law.`,
};

export const COOKIE_POLICY: LegalDocument = {
  title: "Cookie Policy",
  body: `**Effective date: 1 January 2027**

Angaza360 uses cookies and similar browser settings to make the website and business platform work securely. Cookies are small files or values saved by your browser.

## Cookies we use

- **Essential cookies** keep you signed in, protect your account, support account applications and remember necessary working preferences, such as your selected business location.
- **Preference cookies** remember choices you make on the website, including your cookie preference.

Essential cookies are needed for the service to function. Blocking them may prevent sign-in or some business functions from working correctly.

## Your choices

Angaza360 allows you to choose whether to permit optional analytics. Optional analytics is not enabled without your permission. You can change your choice at any time through **Cookie settings** on the website.

You may also manage or delete cookies through your browser. Deleting cookies may sign you out or reset saved preferences.

For more information about personal information, see our [Privacy Policy](/privacy).`,
};

export const ACCEPTABLE_USE_POLICY: LegalDocument = {
  title: "Acceptable Use Policy",
  body: `**Effective date: 1 January 2027**

This policy applies to everyone using Angaza360 and forms part of our [Terms of Service](/terms).

## Use the service lawfully

Use Angaza360 only for legitimate business activities and within the permissions given to you. Do not use it for fraud, false financial records, identity theft, unlawful transactions, harassment or infringement of another person's rights.

## Protect accounts and information

You must not:

- Access or attempt to access another person's or business's account without permission.
- Share passwords, misuse verification codes, impersonate users or bypass security and approval controls.
- Upload malware, disrupt the service, attempt unauthorised security testing or interfere with activity records.
- Upload, share or disclose personal information without lawful authority.
- Misuse payment or communication services for scams, phishing, spam or unauthorised messages.
- Copy or resell the platform, or misuse its intellectual property, without permission.

Businesses must take reasonable steps to control employee access, keep records accurate and safeguard sensitive information. Corrections to completed transactions must use the appropriate platform procedures.

## Breaches of this policy

We may remove harmful content, restrict an action, suspend access or take other proportionate steps to protect the service and its users. Serious unlawful conduct may be referred to the relevant authorities where appropriate. Affected users may raise concerns through our [Contact page](/contact).`,
};

export const BILLING_POLICY: LegalDocument = {
  title: "Billing, Cancellation and Refund Policy",
  body: `**Effective date: 1 January 2027**

This policy applies to Angaza360 subscription charges and other fees payable directly to Angaza Future International.

## Pricing and payment

Current service plans, included features and prices are shown on the [Angaza360 Pricing page](https://www.angaza360.co.ke/#pricing). The selected plan or accepted service agreement sets out the billing period, payment terms, applicable taxes and any renewal conditions.

Charges from banks, mobile money networks, internet providers or other third parties are separate unless expressly included in the selected plan.

## Cancellation

An authorised business representative may request cancellation through our [Contact page](/contact). Cancellation takes effect according to the terms of the applicable subscription or service agreement. Any charges already due remain payable, subject to applicable law.

Before an account is closed, businesses should use the available export functions to retain the records they need. We handle remaining information in accordance with our [Privacy Policy](/privacy) and [Data Processing Agreement](/data-processing-agreement).

## Refunds and billing errors

Refund eligibility depends on the accepted service terms, the reason for the request and applicable Kenyan law. We will review reported duplicate charges, payment errors and charges made without proper authorisation, and make appropriate refunds or corrections where required.

To raise a billing concern, use our [Contact page](/contact) and include the business name, payment date, amount and transaction reference. Never send your password or mobile money PIN.

## Changes to charges

Changes to subscription pricing will be communicated as required by the applicable agreement and law. A new charge or renewal condition will not be imposed contrary to a customer's accepted agreement or mandatory legal rights.`,
};

export const DATA_PROCESSING_AGREEMENT: LegalDocument = {
  title: "Data Processing Agreement",
  body: `**Effective date: 1 January 2027**

This Data Processing Agreement ("Agreement") forms part of the Angaza360 [Terms of Service](/terms) when a business uses Angaza360 to manage personal information about its employees, customers, suppliers or other individuals.

The business using Angaza360 (the **Customer**) is generally responsible for deciding why that information is collected and used. **Angaza Future International** processes it on the Customer's behalf to provide Angaza360. Where Angaza independently handles information for account administration, security or its own legal obligations, our [Privacy Policy](/privacy) applies.

## 1. What information is processed

The service processes information entered or authorised by the Customer, including business contacts, customer and supplier details, employee and payroll records, payment references, transaction histories, uploaded documents and related account activity.

Processing includes receiving, storing, organising, calculating, displaying, sharing with authorised users, exporting, securing, backing up and deleting information. It takes place for the duration of the Customer's service agreement and any lawful retention period.

The individuals concerned may include customers, employees, business owners, supplier representatives and other people whose information the Customer lawfully records.

## 2. Customer responsibilities

The Customer is responsible for ensuring it has a lawful basis for handling the information it enters, giving required privacy notices, keeping information accurate, selecting authorised users and responding to applicable requests from individuals. The Customer retains control of the business information it provides.

The Customer's instructions consist of this Agreement, its authorised use and settings within the platform, and any other lawful written instructions agreed with Angaza. Angaza may decline instructions that would be unlawful, insecure or incompatible with the service.

## 3. Angaza's responsibilities

Angaza will:

- Process Customer personal information only to provide the service, follow documented instructions or comply with applicable law.
- Limit access to authorised people who are subject to confidentiality obligations.
- Apply appropriate measures to protect the confidentiality, integrity and availability of information, including access controls, protected communications and activity records.
- Assist the Customer reasonably with requests relating to personal information, security incidents and applicable data-protection duties.
- Inform the Customer if an instruction appears to breach applicable data-protection law, where permitted.

Authorised platform personnel may access a Customer's workspace and perform supported actions where reasonably necessary for service administration, security, assistance or compliance. Such activity is subject to internal controls and audit records.

## 4. Service providers and data transfers

The Customer authorises Angaza to use service providers necessary to deliver and secure the platform, including hosting, communication and payment-related services, under appropriate contractual protections. Our [Service Providers and Data Transfers Notice](/subprocessors) describes these arrangements.

We will provide reasonable notice of material changes to providers that process Customer personal information where required, and consider any reasonable data-protection objection. We remain responsible for the providers we appoint to the extent required by law.

Where information is processed outside Kenya, Angaza will apply the safeguards required by applicable law.

## 5. Security incidents

Where Angaza becomes aware of a personal-data breach affecting information it processes for the Customer, we will notify the Customer without undue delay and, where reasonably practicable, within **48 hours**. We will provide information reasonably available to assist the Customer in assessing the incident and meeting its legal obligations.

## 6. Requests, audits and assistance

Angaza will reasonably assist the Customer with lawful access, correction, deletion and other data-protection requests, taking into account the nature of the service and information available. The Customer remains responsible for deciding how to respond to requests concerning its own business records.

On reasonable notice, Angaza will provide information needed to demonstrate compliance with this Agreement and allow an appropriate audit or inspection as required by law. Audits must be conducted in a manner that protects the confidentiality of other customers, staff, platform security and proprietary information.

## 7. End of service

Following termination, Angaza will, at the Customer's choice and subject to the available service procedures, return or securely delete Customer personal information, unless retention is required by law. Information retained for a lawful purpose will be protected and used only as permitted. Protected backup copies are removed through the applicable backup retention cycle.

The Customer should obtain any available exports needed for its own record-keeping before access ends.

## 8. General provisions

This Agreement applies for as long as Angaza processes Customer personal information on the Customer's behalf. If it conflicts with the Terms of Service concerning that processing, this Agreement prevails. It is governed by Kenyan law. Acceptance of the Angaza360 Terms by an authorised representative incorporates this Agreement into the Customer's service contract.

For enquiries or instructions, use our [Contact page](/contact).`,
};

export const SUBPROCESSORS: LegalDocument = {
  title: "Service Providers and Data Transfers",
  body: `**Effective date: 1 January 2027**

To operate Angaza360, Angaza Future International uses trusted service providers for cloud hosting, website security, business email, SMS communications and payment-related services. These providers receive or process only information reasonably needed to perform their functions and are subject to applicable confidentiality, security and data-protection requirements. Some providers may process or access information outside Kenya; where this happens, we apply safeguards required by Kenyan data-protection law. A payment provider may also process transaction information under its own terms and legal responsibilities. We may update service-provider arrangements as needed to operate the service, with appropriate notice where required.`,
};

export const SECURITY: LegalDocument = {
  title: "Security and Responsible Disclosure",
  body: `**Effective date: 1 January 2027**

Protecting business and personal information is important to Angaza360. We use measures appropriate to the service, including account authentication, user permissions, protected communications, controlled access to business records and activity logging.

## Protecting your account

Use a strong, unique password, keep verification codes private, assign staff only the access they need and remove access when it is no longer appropriate. Review financial and account activity regularly, and report anything suspicious.

## Reporting a security concern

If you identify a possible vulnerability or suspect unauthorised access, report it using our [Contact page](/contact) with the subject **Security Report**. Include a clear description and enough information to help us investigate, but do not send passwords, payment PINs or other people's sensitive information.

Please do not access data without authorisation, disrupt services, or publicly disclose information that could put users at risk. Security testing requires our prior written permission.

We investigate credible reports and take appropriate action, including notices to affected parties where required by law.`,
};

export const CONTACT: LegalDocument = {
  title: "Contact and Complaints",
  body: `**Effective date: 1 January 2027**

**Angaza360** is operated by **Angaza Future International**, Nairobi, Kenya.

**Email:** [info@angazafuture.org](mailto:info@angazafuture.org)

**Website:** [www.angaza360.co.ke](https://www.angaza360.co.ke/)

You may use this contact for account support, billing enquiries, privacy requests, security reports and service complaints.

Please provide your business or account name, a brief description of the issue, any relevant dates or references, and the outcome you are seeking. Do not include passwords, verification codes or payment PINs. We may request reasonable verification before discussing an account or changing information.

We will review enquiries and complaints and respond as reasonably practicable. Your rights and remedies under applicable law remain unaffected.`,
};
