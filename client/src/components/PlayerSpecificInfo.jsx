import React, { useRef } from "react";
import { usePlayer, useRound } from "@empirica/core/player/classic/react";
import { RenderMarkdown } from "./RenderMarkdown.jsx";

function parseReportMarkdown(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return { introduction: "", sections: [] };
  const chunks = markdown.trim().split(/\n(?=## )/);
  const introduction = chunks[0].startsWith("## ") ? "" : chunks.shift();
  const sections = chunks.map((chunk) => {
    const [headingLine, ...bodyLines] = chunk.split("\n");
    return {
      heading: headingLine.replace(/^##\s+/, "").trim(),
      body: bodyLines.join("\n").trim(),
    };
  });
  return { introduction, sections };
}

function withoutLeadingTitle(markdown) {
  return markdown.replace(/^#\s+[^\n]+\n*/, "").trim();
}

function buildPersonalReport({ generalInfo, participantContent, playerName }) {
  if (!playerName) return "";
  const shared = parseReportMarkdown(generalInfo);
  const personal = parseReportMarkdown(participantContent);
  if (!shared.introduction || shared.sections.length === 0 || personal.sections.length === 0) return "";

  const personalByHeading = new Map(personal.sections.map((section) => [section.heading, section.body]));
  const mergedSections = shared.sections.map((section) => {
    const additionalFacts = personalByHeading.get(section.heading);
    const combinedBody = [section.body, additionalFacts].filter(Boolean).join("\n");
    personalByHeading.delete(section.heading);
    return `## ${section.heading}\n\n${combinedBody}`;
  });

  for (const [heading, body] of personalByHeading) {
    mergedSections.push(`## ${heading}\n\n${body}`);
  }

  const reportIntroduction = `As a decision maker named "${playerName}", you have received a report with information about the three options. Although this report is personal, you may discuss the information in it with others. Your goal is to select the option that is most suitable overall. Be sure to scroll to the bottom of the report to review all details.`;

  return `# General Information\n\n${withoutLeadingTitle(shared.introduction)}\n\n# Personal report delivered to ${playerName}:\n\n${reportIntroduction}\n\n${mergedSections.join("\n\n")}`;
}

export function PlayerSpecificInfo({ className = "", mode = "full" }) {
  const player = usePlayer();
  const round = useRound();
  const generalInfo = round?.get("generalInfo");
  const playerName = player.get("name");
  const reportMarkdown = buildPersonalReport({
    generalInfo,
    participantContent: player.round?.get("playerContent"),
    playerName,
  });
  const compact = mode === "compact";
  const lastCountedScroll = useRef(0);

  const recordScroll = () => {
    const now = Date.now();
    if (now - lastCountedScroll.current < 1000) return;
    lastCountedScroll.current = now;
    player.round.set("taskReportScrollCount", (player.round.get("taskReportScrollCount") ?? 0) + 1);
  };

  if (!reportMarkdown) {
    return <div className="text-sm text-gray-500">The Task Report is not available. Please contact the research team.</div>;
  }

  return (
    <section className={`flex min-h-0 w-full flex-col overflow-hidden rounded-lg bg-white ${className}`} aria-labelledby="task-report-title">
      <header className={`flex-none rounded-t-lg border-2 border-blue-700 bg-gray-100 text-center ${compact ? "px-4 py-3" : "px-5 py-4"}`}>
        <h2 id="task-report-title" className={`${compact ? "text-base" : "text-lg"} font-bold uppercase tracking-wide text-blue-700`}>Personal report for {playerName}</h2>
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto rounded-b-lg border-x-2 border-b-2 border-gray-300 text-left leading-relaxed ${compact ? "px-6 py-5 text-base" : "px-8 py-6 text-base"}`} data-testid="task-report-scroll-panel" onScroll={recordScroll}>
        <p className="mb-4 text-sm font-bold text-gray-700">Scroll down within the report to review all information.</p>
        <RenderMarkdown markdownText={reportMarkdown} />
      </div>
    </section>
  );
}
