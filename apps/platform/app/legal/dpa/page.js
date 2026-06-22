export const metadata = {
  title: 'Data Processing Agreement · DriftHR',
  description: 'GDPR Article 28 Data Processing Agreement for DriftHR business customers.',
};

// IMPORTANT: This is a template DPA covering GDPR Article 28 + UK GDPR
// + NZ Privacy Act 2020 obligations. It is NOT a substitute for advice
// from a qualified privacy lawyer. For paying B2B customers in the EU/UK
// who require a counter-signed agreement, contact support@sitepresso.com.

export const DPA_VERSION = '1.0.0-2026-04-28';

export default function DPAPage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Data Processing Agreement</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">
        Effective date: 28 April 2026 · Version 1.0
      </p>

      <p>
        This Data Processing Agreement (&ldquo;<strong>DPA</strong>&rdquo;) forms part of the
        {' '}<a href="/legal/terms">Terms of Service</a> between you (the &ldquo;<strong>Business</strong>&rdquo;
        or &ldquo;<strong>Controller</strong>&rdquo;) and <strong>Loominfo Limited</strong>
        (NZBN 9429052682902, 17A Prictor Street, Papakura, Auckland, New Zealand —
        the &ldquo;<strong>Processor</strong>&rdquo;) for use of the DriftHR platform
        (the &ldquo;<strong>Service</strong>&rdquo;). It governs the processing of personal
        data carried out by the Processor on behalf of the Controller.
      </p>

      <p>
        This DPA is required where the Controller is subject to the EU General Data Protection
        Regulation, the UK GDPR, the New Zealand Privacy Act 2020, or equivalent privacy laws.
        It applies automatically the moment you accept the Terms of Service and process personal
        data of EU/UK/NZ residents through the Service.
      </p>

      <p>
        For paying customers who require a separately signed and counter-signed copy, email
        {' '}<a href="mailto:support@sitepresso.com">support@sitepresso.com</a> with your business
        details and we will return an executed copy within 5 business days.
      </p>

      <h2>1. Definitions</h2>
      <p>
        Terms used here have the meanings given in Article 4 GDPR / equivalent. In particular:
      </p>
      <ul>
        <li><strong>Personal Data</strong> means any information relating to an identified or identifiable natural person processed by the Processor on behalf of the Controller through the Service.</li>
        <li><strong>Sub-processor</strong> means any third party engaged by the Processor to assist in providing the Service. The current list is at <a href="/legal/sub-processors">/legal/sub-processors</a>.</li>
        <li><strong>Personal Data Breach</strong> has the meaning given in Article 4(12) GDPR.</li>
      </ul>

      <h2>2. Subject matter, duration, nature and purpose</h2>
      <ul>
        <li><strong>Subject matter:</strong> the provision of the DriftHR platform to the Controller.</li>
        <li><strong>Duration:</strong> for as long as the Controller&rsquo;s account remains active, plus the retention periods set out in our <a href="/legal/privacy">Privacy Policy</a>.</li>
        <li><strong>Nature and purpose:</strong> hosting, storing, displaying, and otherwise processing personal data the Controller uploads or generates through the Service in order to provide the agreed Service to the Controller and its end users.</li>
        <li><strong>Categories of data subjects:</strong> the Controller&rsquo;s end customers, staff members invited to the Controller&rsquo;s account, and visitors to the Controller&rsquo;s storefront.</li>
        <li><strong>Categories of personal data:</strong> contact details (name, email, phone), booking details, order details, shipping addresses, account credentials, business content, and technical data (IP, device, session). The Controller is responsible for not uploading special-category data unless required by their use case and lawful under applicable law.</li>
      </ul>

      <h2>3. Processor obligations (Article 28(3) GDPR)</h2>
      <p>The Processor will:</p>
      <ol>
        <li>
          <strong>Process only on documented instructions.</strong> The Processor will process Personal Data only on the Controller&rsquo;s documented instructions, including with regard to transfers of Personal Data to a third country, unless required to do so by Union, Member State, or New Zealand law to which the Processor is subject; in that case, the Processor will inform the Controller of that legal requirement before processing, unless the law prohibits such information on important grounds of public interest.
        </li>
        <li>
          <strong>Ensure confidentiality.</strong> The Processor ensures that personnel authorised to process Personal Data have committed themselves to confidentiality or are under an appropriate statutory obligation of confidentiality.
        </li>
        <li>
          <strong>Implement appropriate security measures</strong> taking into account the state of the art, costs of implementation, and the nature, scope, context, and purposes of processing as well as the risk of varying likelihood and severity for the rights and freedoms of natural persons. Current measures are described in <a href="/legal/privacy#section-8">Privacy Policy §8</a> and the publicly available SECURITY.md.
        </li>
        <li>
          <strong>Engage Sub-processors only with the Controller&rsquo;s prior authorisation.</strong> The Controller authorises the Processor to engage the Sub-processors listed at <a href="/legal/sub-processors">/legal/sub-processors</a>. The Processor will inform the Controller of any intended changes to that list at least 30 days in advance, giving the Controller the opportunity to object on reasonable grounds. Where the Controller objects, the Processor will use reasonable efforts to make available an alternative; if no alternative is feasible, the Controller may terminate the affected portion of the Service with pro-rata refund of pre-paid fees.
        </li>
        <li>
          <strong>Assist the Controller</strong> by appropriate technical and organisational measures, insofar as possible, in fulfilling its obligation to respond to requests from data subjects exercising their rights under Chapter III GDPR (access, rectification, erasure, restriction, portability, objection).
        </li>
        <li>
          <strong>Assist the Controller</strong> in ensuring compliance with the obligations under Articles 32 to 36 GDPR (security, breach notification, DPIA, prior consultation), taking into account the nature of processing and the information available to the Processor.
        </li>
        <li>
          <strong>At the choice of the Controller, delete or return all Personal Data</strong> to the Controller after the end of the provision of services and delete existing copies, unless Union, Member State, or New Zealand law requires storage of the Personal Data. Deletion proceeds within 30 days of account closure (longer for items required by tax or accounting law).
        </li>
        <li>
          <strong>Make available to the Controller all information necessary to demonstrate compliance</strong> with the obligations laid down in this DPA and allow for and contribute to audits, including inspections, conducted by the Controller or another auditor mandated by the Controller. Audits may be conducted no more than once per year except where there is reasonable suspicion of breach; reasonable cost reimbursement applies.
        </li>
      </ol>

      <h2>4. Security measures</h2>
      <p>
        Taking into account the state of the art, costs, and the nature of processing, the
        Processor implements appropriate technical and organisational measures including:
      </p>
      <ul>
        <li>Encryption in transit (TLS 1.2+) for all connections.</li>
        <li>Encryption at rest for credentials (bcrypt) and OAuth tokens (AES-256-GCM).</li>
        <li>Encrypted database backups (AES-256 GPG symmetric).</li>
        <li>Network-layer protection (AWS Shield Standard, AWS Global Accelerator).</li>
        <li>Application-layer protection (nginx rate limits, fail2ban, CrowdSec).</li>
        <li>Bot protection on public forms (Cloudflare Turnstile when configured).</li>
        <li>Restricted SSH access to production (allowlisted IP, key-only auth).</li>
        <li>Audit logging of pricing and subscription changes; operational logs retained at least 14 days.</li>
        <li>Pinned dependencies with regular <code>npm audit</code> review.</li>
      </ul>
      <p>
        Additional hardening is on the Processor&rsquo;s pre-launch list and listed publicly in
        SECURITY.md. The Processor will update this DPA as new controls land.
      </p>

      <h2>5. Personal Data Breach notification</h2>
      <p>
        Where the Processor becomes aware of a Personal Data Breach affecting the Controller&rsquo;s
        data, it will notify the Controller without undue delay and in any event within 72 hours
        of becoming aware. Notification will include, to the extent known:
      </p>
      <ul>
        <li>The nature of the Personal Data Breach including, where possible, the categories and approximate number of data subjects and personal-data records concerned.</li>
        <li>The likely consequences of the Personal Data Breach.</li>
        <li>The measures taken or proposed to address the Personal Data Breach.</li>
        <li>A point of contact (the Privacy Officer) for further information.</li>
      </ul>
      <p>
        Notifying the Processor of a Breach does not relieve the Controller of its own
        notification obligations to supervisory authorities under Article 33 GDPR or to
        affected data subjects under Article 34 GDPR.
      </p>

      <h2>6. International transfers</h2>
      <p>
        The Service is hosted in AWS Asia Pacific (Mumbai). Where Personal Data is transferred
        outside the EU/EEA or UK, transfer is safeguarded by the European Commission&rsquo;s
        Standard Contractual Clauses (Module 2: controller-to-processor) and the UK
        International Data Transfer Agreement, which are incorporated by reference into this DPA.
        Where required, supplementary measures (encryption in transit and at rest, restricted
        access) apply.
      </p>
      <p>
        For data subjects in New Zealand, the Processor complies with Information Privacy
        Principle 12 of the Privacy Act 2020 by ensuring that overseas recipients are subject
        to comparable safeguards.
      </p>

      <h2>7. Sub-processors</h2>
      <p>
        The Controller authorises engagement of the Sub-processors at
        {' '}<a href="/legal/sub-processors">/legal/sub-processors</a>. The Processor remains
        liable to the Controller for the performance of any Sub-processor.
      </p>

      <h2>8. Liability</h2>
      <p>
        The liability of each party under or in connection with this DPA is governed by the
        limitation of liability section in the Terms of Service. Nothing in this DPA limits
        liability for breach of mandatory data-protection law where such limitation is not
        permitted by that law.
      </p>

      <h2>9. Term and termination</h2>
      <p>
        This DPA takes effect on acceptance of the Terms of Service and continues for the term
        of the underlying agreement. On termination, the Processor will delete or return Personal
        Data per clause 3(g). Sections of this DPA which by their nature should survive
        termination will do so.
      </p>

      <h2>10. Order of precedence</h2>
      <p>
        In the event of any conflict between this DPA and the Terms of Service, this DPA prevails
        with respect to the processing of Personal Data. In the event of a conflict between this
        DPA and the EU Standard Contractual Clauses (where they apply), the SCCs prevail.
      </p>

      <h2>11. Governing law</h2>
      <p>
        This DPA is governed by New Zealand law and subject to the exclusive jurisdiction of the
        courts of New Zealand sitting in Auckland, except that nothing in this clause limits the
        rights of EU/UK data subjects or supervisory authorities under their respective laws.
      </p>

      <h2>12. Contact</h2>
      <p>
        <strong>Privacy Officer:</strong> Kiran Pal Singh, <a href="mailto:support@sitepresso.com">support@sitepresso.com</a><br />
        Loominfo Limited, 17A Prictor Street, Papakura, Auckland, New Zealand<br />
        Company number: 9429052682902
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        Version 1.0.0-2026-04-28. To request a counter-signed PDF copy, email the Privacy
        Officer with your business legal name and registered address.
      </p>
    </>
  );
}
