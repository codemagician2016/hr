'use strict';

/**
 * serializers.js — ESS-safe shaping for LMS payloads (Feature 37). Mirror of
 * performance/serializers.js. THE chokepoint that guarantees the quiz answer key
 * (`correctOptionIds`) NEVER reaches the learner runtime (§9 edge case 1). Every ESS
 * quiz/question read MUST pass through here; the raw QuizQuestion is never returned.
 */

/**
 * Strip the answer key from a quiz question for the learner. Returns options WITHOUT
 * any `correct` flag and WITHOUT `correctOptionIds`. `optionsJson` is expected to be
 * [{ id, text }] (the builder never stores correctness inside optionsJson — the key is
 * the separate `correctOptionIds` column).
 */
function publicQuestion(q) {
  if (!q) return null;
  const options = Array.isArray(q.optionsJson)
    ? q.optionsJson.map((o) => ({ id: String(o.id), text: String(o.text == null ? '' : o.text) }))
    : [];
  return {
    id: q.id,
    orderIndex: q.orderIndex,
    prompt: q.prompt,
    kind: q.kind,
    points: q.points,
    options,
    // NOTE: correctOptionIds intentionally OMITTED — answer-key leak guard.
  };
}

/** Strip the answer key from a whole quiz (questions[] → public questions). */
function publicQuiz(quiz) {
  if (!quiz) return null;
  return {
    id: quiz.id,
    lessonId: quiz.lessonId,
    passThreshold: quiz.passThreshold,
    maxAttempts: quiz.maxAttempts,
    shuffle: quiz.shuffle,
    questions: Array.isArray(quiz.questions) ? quiz.questions.map(publicQuestion) : [],
  };
}

/**
 * Learner view of a lesson — strips the embedded quiz answer key. For QUIZ lessons,
 * `quiz` carries only public questions.
 */
function publicLesson(lesson) {
  if (!lesson) return null;
  return {
    id: lesson.id,
    moduleId: lesson.moduleId,
    title: lesson.title,
    kind: lesson.kind,
    orderIndex: lesson.orderIndex,
    isRequired: lesson.isRequired,
    contentUrl: lesson.contentUrl || null,
    contentText: lesson.contentText || null,
    durationSec: lesson.durationSec || null,
    minWatchPct: lesson.minWatchPct == null ? 90 : lesson.minWatchPct,
    estMinutes: lesson.estMinutes || null,
    quiz: lesson.quiz ? publicQuiz(lesson.quiz) : null,
  };
}

module.exports = { publicQuestion, publicQuiz, publicLesson };
