// app/routes/truara-flow.tsx

/**
 * Truara Flow – TanStack Start route + conversational UI component
 *
 * Design philosophy
 * ──────────────────
 * • One question at a time with buttery-smooth vertical slide animations.
 * • Calm mode: no progress pressure, soft colours, gentle transitions.
 * • Edge-first: data is fetched via TanStack Start server functions
 *   so the initial render is instant and subsequent questions arrive
 *   with sub-100 ms perceived latency.
 * • Privacy-first: no tracking pixels, no external fonts, no third-party
 *   scripts.  Respondent fingerprint is HMAC-hashed server-side.
 * • Proactive intelligence: the graph anticipates follow-ups and prefetches
 *   them silently so navigation feels instant.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getFlowWithQuestions,
  startSubmission,
  getNextQuestion,
  submitAnswer,
  completeSubmission,
} from "@/app/server-functions/truara-flow";

// ─────────────────────────────────────────────────────────────
// Route definition
// ─────────────────────────────────────────────────────────────

export const Route = createFileRoute("/truara-flow/$flowId")({
  loader: async ({ params }) => {
    return getFlowWithQuestions({ data: { flowId: params.flowId } });
  },
  component: TruraFlowRoute,
});

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

type Question = {
  id: string;
  position: number;
  title: string;
  description?: string | null;
  placeholder?: string | null;
  question_type: string;
  required: boolean;
  config: Record<string, unknown>;
  tone_hint?: string | null;
};

type Flow = {
  id: string;
  title: string;
  description?: string | null;
  calm_mode: boolean;
  branding: {
    primaryColor?: string;
    fontFamily?: string;
    logoUrl?: string;
  };
};

type AnimationDirection = "up" | "down" | "none";
type SubmissionPhase =
  | "intro"
  | "question"
  | "transitioning"
  | "complete"
  | "error";

// ─────────────────────────────────────────────────────────────
// Utility: browser fingerprint (privacy-safe)
// ─────────────────────────────────────────────────────────────

function getBrowserFingerprint(): string {
  // Minimal, non-tracking fingerprint: timezone + screen dimensions
  return [
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen.width,
    screen.height,
    navigator.language,
  ].join("|");
}

// ─────────────────────────────────────────────────────────────
// Hook: submission session manager
// ─────────────────────────────────────────────────────────────

function useSubmissionSession(flowId: string) {
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fingerprint = getBrowserFingerprint();
      const result = await startSubmission({
        data: { flowId, respondentFingerprint: fingerprint },
      });
      setSubmissionId(result.submissionId);
      return result.submissionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start session";
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  return { submissionId, start, loading, error };
}

// ─────────────────────────────────────────────────────────────
// Hook: question flow manager (LangGraph-backed)
// ─────────────────────────────────────────────────────────────

function useQuestionFlow(flowId: string) {
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [anticipatedFollowUps, setAnticipatedFollowUps] = useState<Question[]>(
    []
  );
  const [isComplete, setIsComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const lastAnsweredRef = useRef<string | undefined>(undefined);

  const fetchNext = useCallback(
    async (submissionId: string, lastQuestionId?: string) => {
      setIsLoading(true);
      try {
        const result = await getNextQuestion({
          data: {
            submissionId,
            lastAnsweredQuestionId: lastQuestionId,
          },
        });

        if (result.isComplete) {
          setIsComplete(true);
          setCurrentQuestion(null);
        } else {
          setCurrentQuestion(result.nextQuestion as Question | null);
          setAnticipatedFollowUps(
            (result.anticipatedFollowUps as Question[]) ?? []
          );
        }
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return {
    currentQuestion,
    anticipatedFollowUps,
    isComplete,
    isLoading,
    fetchNext,
    lastAnsweredRef,
  };
}

// ─────────────────────────────────────────────────────────────
// Sub-component: ProgressDots (calm, no-pressure indicator)
// ─────────────────────────────────────────────────────────────

function ProgressDots({
  answered,
  total,
  color,
}: {
  answered: number;
  total: number;
  color: string;
}) {
  const dots = Math.min(total, 8); // max 8 dots to avoid overwhelm
  return (
    <div style={styles.progressDots}>
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          style={{
            ...styles.dot,
            backgroundColor: i < answered ? color : "rgba(0,0,0,0.12)",
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sub-component: QuestionCard
// ─────────────────────────────────────────────────────────────

function QuestionCard({
  question,
  calmMode,
  primaryColor,
  onAnswer,
  isSubmitting,
}: {
  question: Question;
  calmMode: boolean;
  primaryColor: string;
  onAnswer: (value: string, score?: number) => void;
  isSubmitting: boolean;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValue("");
    setTouched(false);
    // Auto-focus for keyboard-first UX
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [question.id]);

  const handleSubmit = () => {
    if (question.required && !value.trim()) {
      setTouched(true);
      return;
    }
    onAnswer(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const showError = touched && question.required && !value.trim();

  const renderInput = () => {
    const baseInputStyle = {
      ...styles.input,
      borderColor: showError ? "#e74c3c" : primaryColor,
      outline: "none",
    };

    switch (question.question_type) {
      case "long_text":
        return (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            style={{ ...baseInputStyle, ...styles.textarea } as React.CSSProperties}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={question.placeholder ?? (calmMode ? "Share your thoughts…" : "Type here")}
            rows={4}
          />
        );

      case "single_choice":
      case "multi_choice": {
        const choices = (question.config.choices as string[]) ?? [];
        return (
          <div style={styles.choicesContainer}>
            {choices.map((choice) => {
              const selected =
                question.question_type === "multi_choice"
                  ? value.split(",").includes(choice)
                  : value === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  onClick={() => {
                    if (question.question_type === "multi_choice") {
                      const parts = value ? value.split(",") : [];
                      const idx = parts.indexOf(choice);
                      if (idx === -1) parts.push(choice);
                      else parts.splice(idx, 1);
                      setValue(parts.join(","));
                    } else {
                      setValue(choice);
                      // Auto-advance on single choice
                      setTimeout(() => onAnswer(choice), 200);
                    }
                  }}
                  style={{
                    ...styles.choiceButton,
                    backgroundColor: selected ? primaryColor : "white",
                    color: selected ? "white" : "#1a1a2e",
                    borderColor: selected ? primaryColor : "rgba(0,0,0,0.15)",
                  }}
                >
                  {choice}
                </button>
              );
            })}
          </div>
        );
      }

      case "rating":
      case "nps": {
        const max = question.question_type === "nps" ? 10 : 5;
        return (
          <div style={styles.ratingContainer}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setValue(String(n));
                  setTimeout(() => onAnswer(String(n), n), 200);
                }}
                style={{
                  ...styles.ratingButton,
                  backgroundColor:
                    Number(value) >= n ? primaryColor : "white",
                  borderColor:
                    Number(value) >= n ? primaryColor : "rgba(0,0,0,0.15)",
                  color: Number(value) >= n ? "white" : "#1a1a2e",
                }}
              >
                {n}
              </button>
            ))}
          </div>
        );
      }

      case "yes_no":
        return (
          <div style={styles.choicesContainer}>
            {["Yes", "No"].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  setValue(opt);
                  setTimeout(() => onAnswer(opt), 200);
                }}
                style={{
                  ...styles.choiceButton,
                  backgroundColor: value === opt ? primaryColor : "white",
                  color: value === opt ? "white" : "#1a1a2e",
                  borderColor:
                    value === opt ? primaryColor : "rgba(0,0,0,0.15)",
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        );

      case "email":
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="email"
            style={baseInputStyle as React.CSSProperties}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={question.placeholder ?? "your@email.com"}
          />
        );

      case "number":
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="number"
            style={baseInputStyle as React.CSSProperties}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={question.placeholder ?? "0"}
          />
        );

      case "statement":
        return null; // Statements just show text, OK button advances

      default:
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            style={baseInputStyle as React.CSSProperties}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={question.placeholder ?? (calmMode ? "Your answer…" : "Type here")}
          />
        );
    }
  };

  const showOkButton = !["single_choice", "yes_no", "rating", "nps"].includes(
    question.question_type
  );

  return (
    <div style={styles.questionCard}>
      <p style={styles.questionTitle}>{question.title}</p>

      {question.description && (
        <p style={styles.questionDescription}>{question.description}</p>
      )}

      {question.tone_hint && calmMode && (
        <p style={styles.toneHint}>{question.tone_hint}</p>
      )}

      <div style={styles.inputWrapper}>{renderInput()}</div>

      {showError && (
        <p style={styles.errorText}>Please answer this question to continue.</p>
      )}

      {showOkButton && (
        <button
          type="button"
          disabled={isSubmitting}
          onClick={handleSubmit}
          style={{
            ...styles.okButton,
            backgroundColor: primaryColor,
            opacity: isSubmitting ? 0.6 : 1,
          }}
        >
          {isSubmitting
            ? "…"
            : question.question_type === "statement"
            ? "Continue"
            : "OK"}
          {!isSubmitting && <span style={styles.enterHint}> ↵</span>}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sub-component: AnimatedSlide
// ─────────────────────────────────────────────────────────────

function AnimatedSlide({
  children,
  direction,
  visible,
}: {
  children: React.ReactNode;
  direction: AnimationDirection;
  visible: boolean;
}) {
  const translateMap: Record<AnimationDirection, string> = {
    up: "translateY(-60px)",
    down: "translateY(60px)",
    none: "translateY(0)",
  };

  return (
    <div
      style={{
        ...styles.animatedSlide,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : translateMap[direction],
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main route component
// ─────────────────────────────────────────────────────────────

function TruraFlowRoute() {
  const loaderData = Route.useLoaderData();
  const navigate = useNavigate();
  const flow = loaderData.flow as Flow;
  const initialQuestions = loaderData.questions as Question[];

  const primaryColor = flow.branding?.primaryColor ?? "#6C63FF";
  const fontFamily =
    flow.branding?.fontFamily ??
    "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

  const session = useSubmissionSession(flow.id);
  const questionFlow = useQuestionFlow(flow.id);

  const [phase, setPhase] = useState<SubmissionPhase>("intro");
  const [slideDirection, setSlideDirection] =
    useState<AnimationDirection>("none");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [answeredCount, setAnsweredCount] = useState(0);

  const totalQuestions = initialQuestions.length;

  // ── Start the form ──────────────────────────────────────────
  const handleStart = useCallback(async () => {
    setPhase("transitioning");
    setSlideDirection("up");

    const submissionId = await session.start();
    if (!submissionId) {
      setPhase("error");
      return;
    }

    await questionFlow.fetchNext(submissionId);
    setPhase("question");
    setSlideDirection("none");
  }, [session, questionFlow]);

  // ── Handle an answer ────────────────────────────────────────
  const handleAnswer = useCallback(
    async (value: string, score?: number) => {
      if (!session.submissionId || !questionFlow.currentQuestion) return;

      setIsSubmitting(true);
      setSlideDirection("up");

      try {
        // Persist answer
        await submitAnswer({
          data: {
            submissionId: session.submissionId,
            questionId: questionFlow.currentQuestion.id,
            value,
            score,
          },
        });

        setAnsweredCount((c) => c + 1);
        // Capture question id before state may change
        const answeredQuestionId = questionFlow.currentQuestion.id;
        questionFlow.lastAnsweredRef.current = answeredQuestionId;

        setPhase("transitioning");

        // Fetch next question via LangGraph
        const result = await questionFlow.fetchNext(
          session.submissionId,
          answeredQuestionId
        );

        if (result?.isComplete) {
          await completeSubmission({
            data: { submissionId: session.submissionId },
          });
          setPhase("complete");
        } else {
          setPhase("question");
          setSlideDirection("down");
        }
      } catch (err) {
        console.error("Answer submission error:", err);
        setPhase("error");
      } finally {
        setIsSubmitting(false);
      }
    },
    [session.submissionId, questionFlow]
  );

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        ...styles.container,
        fontFamily,
        "--primary": primaryColor,
      } as React.CSSProperties}
    >
      {/* Header */}
      <header style={styles.header}>
        {flow.branding?.logoUrl && (
          <img
            src={flow.branding.logoUrl}
            alt="Logo"
            style={styles.logo}
          />
        )}
        {phase === "question" && totalQuestions > 0 && (
          <ProgressDots
            answered={answeredCount}
            total={totalQuestions}
            color={primaryColor}
          />
        )}
      </header>

      {/* Main content area */}
      <main style={styles.main}>
        {/* ── Intro screen ── */}
        <AnimatedSlide
          direction="none"
          visible={phase === "intro"}
        >
          <div style={styles.introCard}>
            <h1 style={{ ...styles.introTitle, color: primaryColor }}>
              {flow.title}
            </h1>
            {flow.description && (
              <p style={styles.introDescription}>{flow.description}</p>
            )}
            {flow.calm_mode && (
              <p style={styles.calmBadge}>🌿 Calm mode on · Take your time</p>
            )}
            <button
              type="button"
              onClick={handleStart}
              disabled={session.loading}
              style={{
                ...styles.startButton,
                backgroundColor: primaryColor,
              }}
            >
              {session.loading ? "Starting…" : "Begin →"}
            </button>
            {session.error && (
              <p style={styles.errorText}>{session.error}</p>
            )}
          </div>
        </AnimatedSlide>

        {/* ── Active question ── */}
        <AnimatedSlide
          direction={slideDirection}
          visible={phase === "question" && !!questionFlow.currentQuestion}
        >
          {questionFlow.currentQuestion && (
            <QuestionCard
              question={questionFlow.currentQuestion}
              calmMode={flow.calm_mode}
              primaryColor={primaryColor}
              onAnswer={handleAnswer}
              isSubmitting={isSubmitting}
            />
          )}
        </AnimatedSlide>

        {/* ── Transitioning spinner ── */}
        {phase === "transitioning" && (
          <div style={styles.spinnerContainer}>
            <div
              style={{
                ...styles.spinner,
                borderTopColor: primaryColor,
              }}
            />
          </div>
        )}

        {/* ── Completion screen ── */}
        <AnimatedSlide direction="up" visible={phase === "complete"}>
          <div style={styles.completeCard}>
            <span style={styles.completeEmoji}>🌿</span>
            <h2 style={{ ...styles.completeTitle, color: primaryColor }}>
              All done!
            </h2>
            <p style={styles.completeMessage}>
              {flow.calm_mode
                ? "Thank you for sharing. Your responses are private and safe."
                : "Thank you for completing this form."}
            </p>
          </div>
        </AnimatedSlide>

        {/* ── Error screen ── */}
        {phase === "error" && (
          <div style={styles.errorCard}>
            <p style={styles.errorText}>
              Something went wrong. Please refresh and try again.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                ...styles.okButton,
                backgroundColor: primaryColor,
              }}
            >
              Refresh
            </button>
          </div>
        )}
      </main>

      {/* Keyboard hint */}
      {phase === "question" && (
        <footer style={styles.footer}>
          <span style={styles.keyboardHint}>
            Press <kbd style={styles.kbd}>Enter ↵</kbd> to continue
          </span>
        </footer>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Inline styles (no external CSS dependency for portability)
// ─────────────────────────────────────────────────────────────

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
    backgroundColor: "#fafaf8",
    color: "#1a1a2e",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
    backgroundColor: "rgba(255,255,255,0.8)",
    backdropFilter: "blur(8px)",
    position: "sticky" as const,
    top: 0,
    zIndex: 10,
  },
  logo: {
    height: 32,
    objectFit: "contain" as const,
  },
  progressDots: {
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    transition: "background-color 0.4s ease",
  },
  main: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    position: "relative" as const,
    overflow: "hidden",
  },
  animatedSlide: {
    position: "absolute" as const,
    width: "100%",
    maxWidth: 600,
    transition: "opacity 0.35s ease, transform 0.35s ease",
  },
  introCard: {
    textAlign: "center" as const,
    padding: "48px 32px",
    backgroundColor: "white",
    borderRadius: 16,
    boxShadow: "0 4px 32px rgba(0,0,0,0.06)",
  },
  introTitle: {
    fontSize: 32,
    fontWeight: 700,
    marginBottom: 12,
    lineHeight: 1.2,
  },
  introDescription: {
    fontSize: 16,
    color: "#555",
    lineHeight: 1.6,
    marginBottom: 24,
  },
  calmBadge: {
    display: "inline-block",
    fontSize: 13,
    color: "#2d7a4f",
    backgroundColor: "#e8f5ee",
    padding: "6px 14px",
    borderRadius: 20,
    marginBottom: 28,
  },
  startButton: {
    display: "inline-block",
    padding: "14px 32px",
    borderRadius: 8,
    border: "none",
    color: "white",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  questionCard: {
    padding: "40px 32px",
    backgroundColor: "white",
    borderRadius: 16,
    boxShadow: "0 4px 32px rgba(0,0,0,0.06)",
  },
  questionTitle: {
    fontSize: 22,
    fontWeight: 600,
    lineHeight: 1.4,
    marginBottom: 8,
  },
  questionDescription: {
    fontSize: 14,
    color: "#666",
    lineHeight: 1.6,
    marginBottom: 20,
  },
  toneHint: {
    fontSize: 12,
    color: "#888",
    fontStyle: "italic",
    marginBottom: 16,
  },
  inputWrapper: {
    marginBottom: 16,
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    fontSize: 16,
    border: "2px solid",
    borderRadius: 8,
    backgroundColor: "#fafaf8",
    transition: "border-color 0.2s",
    boxSizing: "border-box" as const,
  },
  textarea: {
    resize: "vertical" as const,
    minHeight: 100,
  },
  choicesContainer: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  choiceButton: {
    padding: "12px 16px",
    border: "2px solid",
    borderRadius: 8,
    fontSize: 15,
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "all 0.2s",
    backgroundColor: "white",
  },
  ratingContainer: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  ratingButton: {
    width: 44,
    height: 44,
    border: "2px solid",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  okButton: {
    padding: "12px 28px",
    borderRadius: 8,
    border: "none",
    color: "white",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  enterHint: {
    fontSize: 12,
    opacity: 0.8,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 13,
    marginTop: 6,
  },
  spinnerContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: 32,
    height: 32,
    border: "3px solid rgba(0,0,0,0.08)",
    borderTop: "3px solid",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  completeCard: {
    textAlign: "center" as const,
    padding: "48px 32px",
    backgroundColor: "white",
    borderRadius: 16,
    boxShadow: "0 4px 32px rgba(0,0,0,0.06)",
  },
  completeEmoji: {
    fontSize: 48,
    display: "block",
    marginBottom: 16,
  },
  completeTitle: {
    fontSize: 28,
    fontWeight: 700,
    marginBottom: 12,
  },
  completeMessage: {
    fontSize: 16,
    color: "#555",
    lineHeight: 1.6,
  },
  errorCard: {
    textAlign: "center" as const,
    padding: "40px 32px",
    backgroundColor: "white",
    borderRadius: 16,
    boxShadow: "0 4px 32px rgba(0,0,0,0.06)",
  },
  footer: {
    padding: "12px 24px",
    textAlign: "center" as const,
    borderTop: "1px solid rgba(0,0,0,0.06)",
  },
  keyboardHint: {
    fontSize: 12,
    color: "#999",
  },
  kbd: {
    backgroundColor: "#f0f0f0",
    border: "1px solid #ccc",
    borderRadius: 4,
    padding: "2px 6px",
    fontSize: 11,
    fontFamily: "monospace",
  },
} as const;
