import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildChatMentionUsers,
  CHAT_MENTION_MARKUP,
  CHAT_MENTION_PATTERN,
  CHAT_MENTION_TRIGGER,
} from "./chatMentions.mjs";
import { containsFacilitatorMention } from "../../../server/src/CheckpointManager.mjs";
import { reviewHumanMessageRequest } from "../../../server/src/ExperimentPolicies.mjs";

const customChatSource = await readFile(new URL("./CustomChat.jsx", import.meta.url), "utf8");
const discussionSource = await readFile(new URL("../stages/Discussion.jsx", import.meta.url), "utf8");

function participant(id, name) {
  return {
    id,
    get(key) {
      return key === "name" ? name : undefined;
    },
  };
}

const players = [
  participant("p-green", "Green"),
  participant("p-blue", "Blue"),
  participant("p-pink", "Pink"),
];

function adaptiveSuggestions() {
  return buildChatMentionUsers(players, "p-green", {
    isPractice: false,
    facilitation: "adaptive",
  });
}

function practiceSuggestions() {
  return buildChatMentionUsers(players, "p-green", {
    isPractice: true,
    facilitation: undefined,
  });
}

test("@ opens suggestions containing the other Adaptive Discussion participants", () => {
  assert.equal(CHAT_MENTION_TRIGGER, "@");
  assert.deepEqual(adaptiveSuggestions().slice(0, 2), [
    { id: "p-blue", display: "Blue" },
    { id: "p-pink", display: "Pink" },
  ]);
  assert.match(customChatSource, /<Mention[\s\S]*?trigger=\{CHAT_MENTION_TRIGGER\}[\s\S]*?data=\{mentionUsers\}/);
});

test("selecting a participant inserts the nickname in canonical mention markup", () => {
  const selected = adaptiveSuggestions()[0];
  assert.equal(CHAT_MENTION_MARKUP.replace("__display__", selected.display), "@[Blue]");
  assert.match(customChatSource, /markup=\{CHAT_MENTION_MARKUP\}/);
});

test("participant mention is accepted unchanged and uses the chat mention renderer", () => {
  const content = "Thanks @[Blue], I agree.";
  const reviewed = reviewHumanMessageRequest({
    request: { requestId: "request-1", roundId: "round-1", stageId: "stage-1", content },
    playerId: "p-green",
    currentRoundId: "round-1",
    currentRoundIndex: 0,
    currentStageId: "stage-1",
    currentStageName: "Task",
    deadline: 2_000,
    now: 1_000,
  });

  assert.equal(reviewed.accepted, true);
  assert.equal(reviewed.content, content);
  assert.deepEqual([...content.matchAll(CHAT_MENTION_PATTERN)].map((match) => match[1]), ["Blue"]);
  assert.match(customChatSource, /onNewMessage\(txt\)/);
  assert.match(customChatSource, /reactStringReplace\(text, CHAT_MENTION_PATTERN/);
});

test("participant mention does not trigger Facilitator handling", () => {
  assert.equal(containsFacilitatorMention("Thanks @[Blue], I agree."), false);
  assert.equal(containsFacilitatorMention("@[Pink] what do you think?"), false);
});

test("explicit @[Facilitator] mention still triggers Facilitator handling", () => {
  assert.equal(containsFacilitatorMention("Could you help, @[Facilitator]?"), true);
});

test("multiple participants remain distinguishable and the sender is excluded", () => {
  const suggestions = adaptiveSuggestions();
  assert.deepEqual(suggestions.map(({ id }) => id), ["p-blue", "p-pink", "ai"]);
  assert.deepEqual(suggestions.map(({ display }) => display), ["Blue", "Pink", "Facilitator"]);
  assert.equal(suggestions.some(({ id }) => id === "p-green"), false);
});

test("Adaptive Discussion uses the shared chat tagging path", () => {
  assert.match(discussionSource, /<Chat scope=\{game\} attribute=\{`chat_round_\$\{roundIndex \?\? 0\}`\} \/>/);
  assert.deepEqual(adaptiveSuggestions(), [
    { id: "p-blue", display: "Blue" },
    { id: "p-pink", display: "Pink" },
    { id: "ai", display: "Facilitator" },
  ]);
});

test("Practice offers the same participants plus an explicitly selectable Facilitator", () => {
  assert.deepEqual(practiceSuggestions(), [
    { id: "p-blue", display: "Blue" },
    { id: "p-pink", display: "Pink" },
    { id: "ai", display: "Facilitator" },
  ]);
});
