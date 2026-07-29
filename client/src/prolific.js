// Recruitment mode is an explicit, documented flag (VITE_RECRUITMENT_MODE) rather
// than inferred from NODE_ENV or the mere presence of URL params, so a researcher
// testing the Prolific code path locally (with fabricated params) doesn't
// accidentally get treated as a production deployment, and vice versa.
export function getRecruitmentMode() {
  const mode = import.meta.env.VITE_RECRUITMENT_MODE;
  return mode === "prolific" ? "prolific" : "local";
}

export function getProlificParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const prolificPID = urlParams.get("PROLIFIC_PID") || "";
  const studyID = urlParams.get("STUDY_ID") || "";
  const sessionID = urlParams.get("SESSION_ID") || "";

  return {
    prolificPID,
    studyID,
    sessionID,
    isComplete: Boolean(prolificPID && studyID && sessionID),
  };
}
