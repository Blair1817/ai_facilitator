export const REVIEW_QUIZZES = Object.freeze({
  A: {
    title: "Task A: International Youth Games host city",
    scenario: "The International Youth Sports Council organises the International Youth Games every four years. Three cities, Rovenna, Talwick, and Meridia, have submitted bids. All three meet the mandatory requirements for sporting venues, public safety, finance, and legal compliance. Use only the facts provided in the experiment when evaluating the cities. Do not use outside knowledge or assumptions about the cities. Your task is to judge how the provided non-critical facts affect each city's suitability and then select the city most suitable to host the International Youth Games.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided in the experiment when evaluating the cities. Do not use outside knowledge or assumptions about the cities.",
      },
      taskOverview: {
        title: "Task A scenario",
        content: "The International Youth Sports Council organises the International Youth Games every four years. Three cities, Rovenna, Talwick, and Meridia, have submitted bids. All three meet the mandatory requirements for sporting venues, public safety, finance, and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "You will have a total of 10 minutes to discuss the decision as a group.",
      },
      objective: {
        title: "Task objective",
        content: "Your task is to judge how the provided non-critical facts affect each city's suitability and then select the city most suitable to host the International Youth Games.",
      },
    },
    questions: [
      {
        id: "outsideKnowledge",
        remediationKey: "evidenceRule",
        type: "radio",
        prompt: "May you use outside knowledge about cities?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        correctAnswer: "no",
      },
      {
        id: "alternativeCount",
        remediationKey: "taskOverview",
        type: "number",
        prompt: "How many candidate alternatives must the group compare?",
        correctAnswer: "3",
      },
      {
        id: "mandatoryRequirements",
        remediationKey: "taskOverview",
        type: "radio",
        prompt: "Do all alternatives meet the mandatory requirements stated in their task?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        correctAnswer: "yes",
      },
      {
        id: "discussionMinutes",
        remediationKey: "discussionDuration",
        type: "number",
        prompt: "How long is the discussion period?",
        correctAnswer: "10",
      },
      {
        id: "objective",
        remediationKey: "objective",
        type: "radio",
        prompt: "The objective of the committee's discussion is to:",
        options: [
          { value: "option1", label: "Rate sports facilities in each city." },
          { value: "option2", label: "Compare cities to determine which is most deserving of an infrastructure grant." },
          { value: "option3", label: "Judge how the provided non-critical facts affect each city's suitability and then select the city most suitable to host the International Youth Games." },
          { value: "option4", label: "Select an objective that is not included in any of the options listed above." },
        ],
        correctAnswer: "option3",
      },
    ],
  },
  B: {
    title: "Task B: Global Innovation Summit host campus",
    scenario: "The International Innovation Council organises the Global Innovation Summit every four years. Three university campuses, Fenwick University, Halden University, and Norvale University, have submitted bids. All three meet the mandatory requirements for conference facilities, public safety, finance, and legal compliance. Use only the facts provided in the experiment when evaluating the university campuses. Do not use outside knowledge or assumptions about the universities. Your task is to judge how the provided non-critical facts affect each campus's suitability and then select the campus most suitable to host the Global Innovation Summit.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided in the experiment when evaluating the university campuses. Do not use outside knowledge or assumptions about the universities.",
      },
      taskOverview: {
        title: "Task B scenario",
        content: "The International Innovation Council organises the Global Innovation Summit every four years. Three university campuses, Fenwick University, Halden University, and Norvale University, have submitted bids. All three meet the mandatory requirements for conference facilities, public safety, finance, and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "You will have a total of 10 minutes to discuss the decision as a group.",
      },
      objective: {
        title: "Task objective",
        content: "Your task is to judge how the provided non-critical facts affect each campus's suitability and then select the campus most suitable to host the Global Innovation Summit.",
      },
    },
    questions: [
      {
        id: "outsideKnowledge",
        remediationKey: "evidenceRule",
        type: "radio",
        prompt: "May you use outside knowledge about universities?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        correctAnswer: "no",
      },
      {
        id: "alternativeCount",
        remediationKey: "taskOverview",
        type: "number",
        prompt: "How many candidate alternatives must the group compare?",
        correctAnswer: "3",
      },
      {
        id: "mandatoryRequirements",
        remediationKey: "taskOverview",
        type: "radio",
        prompt: "Do all alternatives meet the mandatory requirements stated in their task?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        correctAnswer: "yes",
      },
      {
        id: "discussionMinutes",
        remediationKey: "discussionDuration",
        type: "number",
        prompt: "How long is the discussion period?",
        correctAnswer: "10",
      },
      {
        id: "objective",
        remediationKey: "objective",
        type: "radio",
        prompt: "The objective of the committee's discussion is to:",
        options: [
          { value: "option1", label: "Rate the overall suitability of each university using the background information provided." },
          { value: "option2", label: "Select the university most deserving of funding for future infrastructure improvement projects." },
          { value: "option3", label: "Judge how the provided non-critical facts affect each campus's suitability and then select the campus most suitable to host the Global Innovation Summit." },
          { value: "option4", label: "Select an objective that is not included in any of the options listed above." },
        ],
        correctAnswer: "option3",
      },
    ],
  },
});

export function getReviewQuiz(taskVersion) {
  return REVIEW_QUIZZES[taskVersion] ?? null;
}

function normalizeAnswer(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function evaluateReviewQuiz(taskVersion, answers) {
  const quiz = getReviewQuiz(taskVersion);
  if (!quiz) {
    throw new Error(`Unsupported ReviewQuiz taskVersion: ${JSON.stringify(taskVersion)}`);
  }

  const questionCorrectness = {};
  for (const question of quiz.questions) {
    const answer = normalizeAnswer(answers[question.id]);
    questionCorrectness[question.id] = answer === normalizeAnswer(question.correctAnswer);
  }

  const incorrectQuestionIds = quiz.questions
    .filter((question) => !questionCorrectness[question.id])
    .map((question) => question.id);

  return {
    questionCorrectness,
    incorrectQuestionIds,
    allCorrect: incorrectQuestionIds.length === 0,
  };
}

export function clearIncorrectReviewQuizAnswers(answers, incorrectQuestionIds) {
  const clearedAnswers = { ...answers };
  for (const questionId of incorrectQuestionIds) {
    delete clearedAnswers[questionId];
  }
  return clearedAnswers;
}

export function getReviewQuizRemediation(taskVersion, incorrectQuestionIds) {
  const quiz = getReviewQuiz(taskVersion);
  if (!quiz) {
    throw new Error(`Unsupported ReviewQuiz taskVersion: ${JSON.stringify(taskVersion)}`);
  }

  const incorrectIds = new Set(incorrectQuestionIds);
  const seenKeys = new Set();
  const sections = [];
  for (const question of quiz.questions) {
    if (!incorrectIds.has(question.id) || seenKeys.has(question.remediationKey)) {
      continue;
    }
    const remediation = quiz.remediation[question.remediationKey];
    if (!remediation) {
      throw new Error(`Missing ReviewQuiz remediation for ${taskVersion}.${question.id}`);
    }
    seenKeys.add(question.remediationKey);
    sections.push({ key: question.remediationKey, ...remediation });
  }
  return sections;
}
