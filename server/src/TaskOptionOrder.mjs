import { randomInt } from "node:crypto";

function shuffleOptions(options) {
  const result = [...options];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function orderTaskSections(markdown, options) {
  const chunks = markdown.split(/\n(?=## )/);
  let introduction = chunks[0].startsWith("## ") ? "" : chunks.shift().trim();
  const sections = new Map(chunks.map((chunk) => [chunk.split("\n")[0].slice(3).trim(), chunk.trim()]));
  const names = options.map((option) => option.label);
  introduction = introduction.replace(/The three options are [^.]+\./,
    `The three options are ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`);
  const ordered = names.map((name) => {
    if (!sections.has(name)) throw new Error(`Task report missing option section: ${name}`);
    return sections.get(name);
  });
  return [introduction, ...ordered].filter(Boolean).join("\n\n");
}

// One persisted permutation per group and formal task; stable IDs retain their meaning.
export function initialiseTaskOptionOrder(round, task, shuffle = shuffleOptions) {
  if (round.get("isPractice")) return null;
  let ids = round.get("taskOptionOrder");
  if (!ids) {
    ids = shuffle(task.decisionOptions).map((option) => option.id);
    round.set("taskOptionOrder", ids);
  }
  if (ids.length !== 3 || new Set(ids).size !== 3 || ids.some((id) => !task.decisionOptions.some((option) => option.id === id))) {
    throw new Error("Invalid persisted formal task option order");
  }
  const options = ids.map((id) => task.decisionOptions.find((option) => option.id === id));
  round.set("decisionOptions", options);
  round.set("generalInfo", orderTaskSections(task.generalInfo, options));
  return options;
}
