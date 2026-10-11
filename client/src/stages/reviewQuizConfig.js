export const REVIEW_QUIZZES = Object.freeze({
  A: {
    title: "Task A: Choose a host city",
    scenario: "This quiz concerns the International Youth Games host-city task with Talwick, Rovenna, and Meridia.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided, without outside knowledge or assumptions.",
      },
      taskOverview: {
        title: "Task A scenario",
        content: "Your group will choose a city to host the International Youth Games. The three options are Talwick, Rovenna and Meridia. The International Youth Sports Council holds the Games every four years. All three cities meet the essential requirements for venues, public safety, finance and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "The group discussion can last up to 15 minutes.",
      },
      objective: {
        title: "Task objective",
        content: "Choose the best city to host the International Youth Games. Give equal weight to each listed strength and drawback. A drawback does not automatically rule out a city.",
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
          { value: "option1", label: "Choose the city with the fewest drawbacks and ignore its strengths." },
          { value: "option2", label: "Choose the best city to host the International Youth Games, giving equal weight to each listed strength and drawback." },
          { value: "option3", label: "Choose the city with the best sports facilities, without comparing the other information." },
          { value: "option4", label: "Rule out any city that has a listed drawback." },
        ],
        correctAnswer: "option2",
      },
    ],
  },
  B: {
    title: "Task B: Choose a host campus",
    scenario: "This quiz concerns the Global Innovation Summit host-campus task with Halden University, Fenwick University, and Norvale University.",
    remediation: {
      evidenceRule: {
        title: "Information to use",
        content: "Use only the facts provided, without outside knowledge or assumptions.",
      },
      taskOverview: {
        title: "Task B scenario",
        content: "Your group will choose a university campus to host the Global Innovation Summit. The three options are Halden University, Fenwick University and Norvale University. The International Innovation Council holds the Summit every four years. All three campuses meet the essential requirements for facilities, public safety, finance and legal compliance.",
      },
      discussionDuration: {
        title: "Discussion period",
        content: "The group discussion can last up to 15 minutes.",
      },
      objective: {
        title: "Task objective",
        content: "Choose the best university campus to host the Global Innovation Summit. Give equal weight to each listed strength and drawback. A drawback does not automatically rule out a campus.",
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
          { value: "option1", label: "Choose the campus with the most strengths and ignore all drawbacks." },
          { value: "option2", label: "Choose the university that most deserves funding for future improvements." },
          { value: "option3", label: "Rule out any campus that has a listed drawback." },
          { value: "option4", label: "Choose the best university campus to host the Global Innovation Summit, giving equal weight to each listed strength and drawback." },
        ],
        correctAnswer: "option4",
      },
    ],
  },
});

export function getReviewQuiz(taskVersion, decisionOptions) {
  const quiz = REVIEW_QUIZZES[taskVersion] ?? null;
  if (!quiz || !decisionOptions?.length) return quiz;
  const names = decisionOptions.map((option) => option.label);
  const list = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return { ...quiz,
    scenario: quiz.scenario.replace(/with [^.]+\./, `with ${list}.`),
    remediation: { ...quiz.remediation,
      taskOverview: { ...quiz.remediation.taskOverview,
        content: quiz.remediation.taskOverview.content.replace(/The three options are [^.]+\./, `The three options are ${list}.`) },
    },
  };
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

export function getReviewQuizRemediation(taskVersion, incorrectQuestionIds, decisionOptions) {
  const quiz = getReviewQuiz(taskVersion, decisionOptions);
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
