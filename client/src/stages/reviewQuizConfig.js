export const REVIEW_QUIZZES = Object.freeze({
  A: {
    title: "Task A: Choose a host city",
    scenario: "This quiz concerns the International Youth Games host-city task with Rovenna, Talwick, and Meridia.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided, without outside knowledge or assumptions.",
      },
      taskOverview: {
        title: "Task A scenario",
        content: "Your group will choose a city to host the International Youth Games. The three options are Rovenna, Talwick and Meridia. The International Youth Sports Council holds the Games every four years. All three cities have passed the initial checks and meet the requirements for sports venues, public safety, finances and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "The group discussion can last up to 15 minutes.",
      },
      objective: {
        title: "Task objective",
        content: "None of the listed drawbacks would rule out an option as a host. Treat each strength and drawback as equally important, then choose the best host overall.",
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
        prompt: "Do all alternatives meet the requirements stated in their task?",
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
        correctAnswer: "15",
      },
      {
        id: "objective",
        remediationKey: "objective",
        type: "radio",
        prompt: "The objective of the committee's discussion is to:",
        options: [
          { value: "option1", label: "Rate sports facilities in each city." },
          { value: "option2", label: "Compare cities to determine which is most deserving of an infrastructure grant." },
          { value: "option3", label: "Treat each strength and drawback as equally important, then choose the best host overall." },
          { value: "option4", label: "Select an objective that is not included in any of the options listed above." },
        ],
        correctAnswer: "option3",
      },
    ],
  },
  B: {
    title: "Task B: Choose a host campus",
    scenario: "This quiz concerns the Global Innovation Summit host-campus task with Fenwick University, Halden University, and Norvale University.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided, without outside knowledge or assumptions.",
      },
      taskOverview: {
        title: "Task B scenario",
        content: "Your group will choose a university campus to host the Global Innovation Summit. The three options are Fenwick University, Halden University and Norvale University. The International Innovation Council holds the summit every four years. All three campuses have passed the initial checks and meet the requirements for conference facilities, public safety, finances and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "The group discussion can last up to 15 minutes.",
      },
      objective: {
        title: "Task objective",
        content: "None of the listed drawbacks would rule out an option as a host. Treat each strength and drawback as equally important, then choose the best host overall.",
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
        prompt: "Do all alternatives meet the requirements stated in their task?",
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
        correctAnswer: "15",
      },
      {
        id: "objective",
        remediationKey: "objective",
        type: "radio",
        prompt: "The objective of the committee's discussion is to:",
        options: [
          { value: "option1", label: "Rate the overall suitability of each university using the background information provided." },
          { value: "option2", label: "Select the university most deserving of funding for future infrastructure improvement projects." },
          { value: "option3", label: "Treat each strength and drawback as equally important, then choose the best host overall." },
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
