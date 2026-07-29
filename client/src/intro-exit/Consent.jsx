import React from "react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";

// Bump this when the consent text below is replaced with real IRB-approved copy.
export const CONSENT_VERSION = "placeholder-v1";
export const CONSENT_METADATA_KEY = "grail:consentMeta";

export function Consent({ onConsent }) {
  const handleConsent = () => {
    // Empirica's own consent flag (useConsent()) only lives in localStorage and is
    // never synced to the player record. We record the actual click time/version
    // here so RecruitmentBootstrap can persist it onto the player once it exists.
    window.localStorage.setItem(
      CONSENT_METADATA_KEY,
      JSON.stringify({ consentedAt: Date.now(), consentVersion: CONSENT_VERSION })
    );
    onConsent();
  };

  return (
    <div className="flex-col justify-center mx-10% mt-5%">
      <RenderMarkdown markdownText={consentMarkdown} />
      <div className="text-center pb-10px">
        <Button handleClick={handleConsent}>
          <p>I agree to this consent form</p>
        </Button>
      </div>
    </div>
  );
}


const consentMarkdown = `# Participant Consent Form

**[RESEARCHERS: Replace this placeholder with your own IRB-approved consent form before deploying your study.]**

Consider including the following information in your consent form:

- **Project title** and principal investigator(s)
- **Purpose** of the study
- **Procedures** — what participants will be asked to do
- **Compensation** — payment details, if applicable
- **Risks and benefits** of participation
- **Privacy and confidentiality** — how data will be stored, used, and shared
- **Voluntary participation** — the right to withdraw at any time
- **Contact information** — for questions or concerns about the study

If you agree to participate, please click the button below. If you do not agree, please close this page.`;
