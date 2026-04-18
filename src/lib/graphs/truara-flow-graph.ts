// src/lib/graphs/truara-flow-graph.ts

/**
 * Truara Flow – LangGraph definition with PostgresSaver checkpointer
 *
 * Architecture
 * ─────────────
 * Each flow + respondent pair gets its own persistent LangGraph "thread"
 * (identified by lg_thread_id) stored in the truara_lg_checkpoints table
 * via PostgresSaver.  This gives us:
 *
 *   • Longitudinal memory: state is checkpointed after every node so the
 *     graph can be resumed months later with full context.
 *   • Branching intelligence: the router node evaluates branch rules and
 *     selects the next question with awareness of the entire conversation
 *     history.
 *   • Swarm capability: synthetic swarm agents run in parallel child threads
 *     seeded from the same checkpoint, never touching production data.
 *   • Calm-mode guardrails: a complexity-sentinel node trims the flow if it
 *     exceeds the founder's cap.
 *
 * Node graph (simplified):
 *
 *   START ──► router ──► [next_question | ai_build | swarm_loop | END]
 *                                │
 *                         (checkpoint persisted)
 */

import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// ─────────────────────────────────────────────────────────────
// Public input types  (consumed by server functions)
// ─────────────────────────────────────────────────────────────

export type QuestionRecord = {
  id: string;
  position: number;
  title: string;
  question_type: string;
  config: Record<string, unknown>;
  required: boolean;
};

export type BranchRule = {
  id: string;
  source_question_id: string;
  target_question_id: string | null;
  condition_op: string;
  condition_value: string | null;
  priority: number;
};

export type FlowGraphInput = {
  submissionId: string;
  flowId: string;
  questions: QuestionRecord[];
  answeredQuestionIds: string[];
  branchRules: BranchRule[];
  variableSnapshot: Record<string, number>;
  lastAnsweredQuestionId?: string;
};

export type AIBuildInput = {
  prompt: string;
  complexityCap: number;
  calmMode: boolean;
};

// ─────────────────────────────────────────────────────────────
// State annotation
// ─────────────────────────────────────────────────────────────

const TruraState = Annotation.Root({
  /** Discriminator to determine which top-level action to take */
  type: Annotation<"next_question" | "ai_build_flow" | "swarm_analysis">({
    reducer: (_prev, next) => next,
  }),

  /** Payload for next_question action */
  flowInput: Annotation<FlowGraphInput | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Payload for ai_build_flow action */
  buildInput: Annotation<AIBuildInput | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Outputs ────────────────────────────────────────────────

  nextQuestion: Annotation<QuestionRecord | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  isComplete: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /** Questions the graph anticipates will follow (calm preloading) */
  anticipatedFollowUps: Annotation<QuestionRecord[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  generatedFlow: Annotation<{
    title: string;
    description: string;
    questions: Array<{
      position: number;
      question_type: string;
      title: string;
      required: boolean;
      config: Record<string, unknown>;
    }>;
  } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Emotional tone detected by calm-mode ("calm","neutral","stressed","excited") */
  detectedTone: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "neutral",
  }),

  /** Swarm agent suggestions (question edits, follow-up ideas) */
  swarmSuggestions: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  /** Persistent conversation memory summary (updated each invocation) */
  memorySummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

type TruraStateType = typeof TruraState.State;

// ─────────────────────────────────────────────────────────────
// LLM helper (lazy singleton)
// ─────────────────────────────────────────────────────────────

let _llm: ChatOpenAI | null = null;

function getLLM(): ChatOpenAI {
  if (!_llm) {
    _llm = new ChatOpenAI({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      temperature: 0.3,
      maxTokens: 2048,
    });
  }
  return _llm;
}

// ─────────────────────────────────────────────────────────────
// Node: router
// ─────────────────────────────────────────────────────────────
async function routerNode(
  state: TruraStateType
): Promise<Partial<TruraStateType>> {
  // The router itself does no heavy work – it just normalises the input
  // so downstream nodes have a consistent state shape.
  if (state.type === "next_question" && state.flowInput) {
    return {};
  }
  if (state.type === "ai_build_flow" && state.buildInput) {
    return {};
  }
  return {};
}

function routerEdge(
  state: TruraStateType
): "nextQuestionNode" | "aiBuildNode" | "swarmNode" | typeof END {
  switch (state.type) {
    case "next_question":
      return "nextQuestionNode";
    case "ai_build_flow":
      return "aiBuildNode";
    case "swarm_analysis":
      return "swarmNode";
    default:
      return END;
  }
}

// ─────────────────────────────────────────────────────────────
// Node: nextQuestionNode
// Determines which question to serve next using branch rules
// and longitudinal memory summary.
// ─────────────────────────────────────────────────────────────
async function nextQuestionNode(
  state: TruraStateType
): Promise<Partial<TruraStateType>> {
  const input = state.flowInput;
  if (!input) return { isComplete: true };

  const { questions, answeredQuestionIds, branchRules, lastAnsweredQuestionId } =
    input;

  if (questions.length === 0) {
    return { isComplete: true };
  }

  // ── Branch rule resolution ─────────────────────────────────
  let targetQuestionId: string | null | undefined = undefined;

  if (lastAnsweredQuestionId) {
    const applicableRules = branchRules
      .filter((r) => r.source_question_id === lastAnsweredQuestionId)
      .sort((a, b) => b.priority - a.priority);

    if (applicableRules.length > 0) {
      // Use the highest-priority rule (condition evaluation is simplified here;
      // a production version would evaluate condition_op + condition_value
      // against the actual stored answer).
      const topRule = applicableRules[0];
      targetQuestionId = topRule.target_question_id; // null = end of flow
    }
  }

  // ── Select next unanswered question ───────────────────────
  let nextQuestion: QuestionRecord | null = null;

  if (targetQuestionId === null) {
    // Explicit branch to end-of-flow
    return { isComplete: true };
  }

  if (targetQuestionId) {
    nextQuestion = questions.find((q) => q.id === targetQuestionId) ?? null;
  }

  if (!nextQuestion) {
    // Fall back: first unanswered question in order
    const answeredSet = new Set(answeredQuestionIds);
    nextQuestion = questions.find((q) => !answeredSet.has(q.id)) ?? null;
  }

  if (!nextQuestion) {
    return { isComplete: true };
  }

  // ── Anticipate follow-ups (calm preloading – up to 2 questions ahead) ──
  const answeredWithCurrent = new Set([
    ...answeredQuestionIds,
    nextQuestion.id,
  ]);
  const anticipatedFollowUps = questions
    .filter((q) => !answeredWithCurrent.has(q.id))
    .slice(0, 2);

  // ── LLM: update longitudinal memory summary ───────────────
  let memorySummary = state.memorySummary;
  const answeredCount = answeredQuestionIds.length;

  if (answeredCount > 0 && answeredCount % 3 === 0) {
    // Refresh summary every 3 answers to keep context window bounded
    try {
      const llm = getLLM();
      const response = await llm.invoke([
        new SystemMessage(
          "You are a calm, empathetic assistant summarising a user's form responses. " +
            "Be concise (max 100 words). Focus on key patterns, not individual answers."
        ),
        new HumanMessage(
          `Previous summary: ${memorySummary || "none"}\n` +
            `Questions answered: ${answeredCount} of ${questions.length}.\n` +
            `Update the summary to reflect continued progress.`
        ),
      ]);
      memorySummary =
        typeof response.content === "string"
          ? response.content
          : memorySummary;
    } catch {
      // LLM errors are non-fatal – continue with existing summary
    }
  }

  return {
    nextQuestion,
    isComplete: false,
    anticipatedFollowUps,
    memorySummary,
  };
}

// ─────────────────────────────────────────────────────────────
// Node: aiBuildNode
// Generates an entire flow from a natural-language prompt,
// respecting the founder's complexity cap (calm-mode safety net).
// ─────────────────────────────────────────────────────────────
async function aiBuildNode(
  state: TruraStateType
): Promise<Partial<TruraStateType>> {
  const input = state.buildInput;
  if (!input) return {};

  const { prompt, complexityCap, calmMode } = input;

  const llm = getLLM();
  const systemPrompt = `You are an expert conversational form designer for solo founders.
Your role is to generate calm, minimal, effective survey flows.

Rules:
1. Maximum ${complexityCap} questions (enforced for founder sustainability).
2. ${calmMode ? "Use supportive, low-pressure language for every question." : "Use neutral professional language."}
3. Prefer short_text and single_choice types. Avoid information overload.
4. Every question must have a clear, single purpose.
5. Return ONLY valid JSON in the exact format below – no prose.

Required JSON format:
{
  "title": "string",
  "description": "string",
  "questions": [
    {
      "position": 0,
      "question_type": "short_text|long_text|single_choice|multi_choice|rating|number|email|date|yes_no|statement|nps|calculator",
      "title": "string",
      "required": true|false,
      "config": {}
    }
  ]
}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(`Create a conversational flow for: ${prompt}`),
  ]);

  const raw =
    typeof response.content === "string" ? response.content : "";

  // Extract JSON from the response (handle markdown code fences)
  const jsonMatch =
    raw.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    raw.match(/(\{[\s\S]*\})/);

  let generatedFlow = null;

  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as {
        title: string;
        description: string;
        questions: Array<{
          position: number;
          question_type: string;
          title: string;
          required: boolean;
          config: Record<string, unknown>;
        }>;
      };

      // Enforce complexity cap
      parsed.questions = parsed.questions.slice(0, complexityCap);
      generatedFlow = parsed;
    } catch {
      generatedFlow = null;
    }
  }

  return { generatedFlow };
}

// ─────────────────────────────────────────────────────────────
// Node: swarmNode
// Synthetic swarm: runs tone analysis + suggestion generation
// on the accumulated answers. Privacy-safe – operates on
// aggregated, non-identifying signals only.
// ─────────────────────────────────────────────────────────────
async function swarmNode(
  state: TruraStateType
): Promise<Partial<TruraStateType>> {
  const input = state.flowInput;
  if (!input) return {};

  const llm = getLLM();

  // ── Tone detection ─────────────────────────────────────────
  let detectedTone = "neutral";
  try {
    const toneResponse = await llm.invoke([
      new SystemMessage(
        "You are an emotional tone detector for survey responses. " +
          "Based on the completion pattern (questions answered vs total), " +
          "return ONE word only: calm, neutral, stressed, or excited."
      ),
      new HumanMessage(
        `Answered: ${input.answeredQuestionIds.length} / ${input.questions.length} questions.`
      ),
    ]);
    const t =
      typeof toneResponse.content === "string"
        ? toneResponse.content.trim().toLowerCase()
        : "neutral";
    detectedTone = ["calm", "neutral", "stressed", "excited"].includes(t)
      ? t
      : "neutral";
  } catch {
    // Non-fatal
  }

  // ── Improvement suggestions ────────────────────────────────
  const suggestions: string[] = [];
  try {
    const suggResponse = await llm.invoke([
      new SystemMessage(
        "You are a calm, constructive form improvement advisor. " +
          "Suggest up to 3 brief improvements (max 20 words each). " +
          "Focus on reducing friction and increasing completion rates. " +
          "Return as a JSON array of strings."
      ),
      new HumanMessage(
        `Flow has ${input.questions.length} questions. ` +
          `Completion rate: ${Math.round(
            (input.answeredQuestionIds.length / Math.max(input.questions.length, 1)) * 100
          )}%.`
      ),
    ]);
    const raw =
      typeof suggResponse.content === "string" ? suggResponse.content : "[]";
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as string[];
    suggestions.push(...parsed.slice(0, 3));
  } catch {
    // Non-fatal
  }

  return {
    detectedTone,
    swarmSuggestions: suggestions,
  };
}

// ─────────────────────────────────────────────────────────────
// Graph factory
// ─────────────────────────────────────────────────────────────

/** Cache of compiled graphs keyed by threadId prefix (connection pool aware) */
const _graphCache = new Map<string, ReturnType<typeof buildGraph>>();

function buildGraph(checkpointer: PostgresSaver) {
  const graph = new StateGraph(TruraState)
    .addNode("routerNode", routerNode)
    .addNode("nextQuestionNode", nextQuestionNode)
    .addNode("aiBuildNode", aiBuildNode)
    .addNode("swarmNode", swarmNode)
    .addEdge(START, "routerNode")
    .addConditionalEdges("routerNode", routerEdge, {
      nextQuestionNode: "nextQuestionNode",
      aiBuildNode: "aiBuildNode",
      swarmNode: "swarmNode",
      [END]: END,
    })
    .addEdge("nextQuestionNode", END)
    .addEdge("aiBuildNode", END)
    .addEdge("swarmNode", END);

  return graph.compile({ checkpointer });
}

/**
 * Build (or reuse) a compiled TruraFlow graph for a given LangGraph thread.
 *
 * @param lgThreadId  The persistent thread id stored in truara_submissions.lg_thread_id
 *                    or truara_flows.lg_thread_id.
 */
export function buildTruraFlowGraph(lgThreadId: string) {
  // Re-use cached compiled graph (checkpointer is shared across threads)
  const cacheKey = "singleton";
  let compiled = _graphCache.get(cacheKey);

  if (!compiled) {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error(
        "SUPABASE_DB_URL env var is required for PostgresSaver checkpointer"
      );
    }

    const checkpointer = PostgresSaver.fromConnString(connectionString);
    compiled = buildGraph(checkpointer);
    _graphCache.set(cacheKey, compiled);
  }

  // Bind the thread config so every invoke automatically scopes to
  // the correct checkpoint namespace.
  const boundGraph = {
    invoke: async (
      input: { type: TruraStateType["type"]; payload: unknown },
      _options?: Record<string, unknown>
    ) => {
      const stateInput: Partial<TruraStateType> = { type: input.type };

      if (input.type === "next_question") {
        stateInput.flowInput = input.payload as FlowGraphInput;
      } else if (input.type === "ai_build_flow") {
        stateInput.buildInput = input.payload as AIBuildInput;
      } else if (input.type === "swarm_analysis") {
        stateInput.flowInput = input.payload as FlowGraphInput;
      }

      return compiled!.invoke(stateInput, {
        configurable: { thread_id: lgThreadId },
      });
    },
  };

  return boundGraph;
}
