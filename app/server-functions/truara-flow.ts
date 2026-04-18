// app/server-functions/truara-flow.ts

/**
 * Truara Flow – Edge-first server functions
 *
 * These are TanStack Start server functions (createServerFn) that run on the
 * edge and interface with Supabase + the LangGraph agent.
 *
 * Design goals
 * ─────────────
 * • Private-by-default: all sensitive data is encrypted before storage.
 * • Calm-mode: the server enforces a complexity cap so founders never hit
 *   burnout from over-engineered flows.
 * • Longitudinal memory: every submission advances a persistent LangGraph
 *   thread so the flow "learns" over time.
 * • Swarm-ready: after each submission a background swarm task is queued
 *   for AI analysis and auto-refinement.
 */

import { createServerFn } from "@tanstack/start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  buildTruraFlowGraph,
  type FlowGraphInput,
} from "@/src/lib/graphs/truara-flow-graph";

// ─────────────────────────────────────────────────────────────
// Supabase client (service-role for edge functions)
// ─────────────────────────────────────────────────────────────
function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ─────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────
const CreateFlowSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  calmMode: z.boolean().default(true),
  branding: z
    .object({
      primaryColor: z.string().optional(),
      fontFamily: z.string().optional(),
      logoUrl: z.string().url().optional(),
    })
    .optional()
    .default({}),
});

const AddQuestionSchema = z.object({
  flowId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  questionType: z.enum([
    "short_text",
    "long_text",
    "single_choice",
    "multi_choice",
    "rating",
    "number",
    "email",
    "date",
    "yes_no",
    "statement",
    "file_upload",
    "ranking",
    "nps",
    "calculator",
  ]),
  title: z.string().min(1).max(500),
  description: z.string().max(1000).optional(),
  placeholder: z.string().max(200).optional(),
  required: z.boolean().default(false),
  config: z.record(z.unknown()).optional().default({}),
});

const SubmitAnswerSchema = z.object({
  submissionId: z.string().uuid(),
  questionId: z.string().uuid(),
  value: z.string(),
  score: z.number().optional(),
});

const StartSubmissionSchema = z.object({
  flowId: z.string().uuid(),
  respondentFingerprint: z.string().optional(),
});

const CompleteSubmissionSchema = z.object({
  submissionId: z.string().uuid(),
});

const AIBuildFlowSchema = z.object({
  naturalLanguagePrompt: z.string().min(10).max(2000),
  founderComplexityCap: z.number().int().min(1).max(100).default(20),
  calmMode: z.boolean().default(true),
});

const GetFlowWithQuestionsSchema = z.object({
  flowId: z.string().uuid(),
});

const GetNextQuestionSchema = z.object({
  submissionId: z.string().uuid(),
  lastAnsweredQuestionId: z.string().uuid().optional(),
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Deterministic HMAC-SHA256 fingerprint – no raw PII stored */
async function fingerprintValue(raw: string): Promise<string> {
  const secret = process.env.TRUARA_FINGERPRINT_SECRET;
  if (!secret) throw new Error("TRUARA_FINGERPRINT_SECRET env var is required");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  return Buffer.from(sig).toString("hex");
}

/** Symmetric encryption of sensitive text with AES-GCM + env key */
async function encryptValue(plaintext: string): Promise<Uint8Array> {
  const secret = process.env.TRUARA_ENCRYPTION_KEY;
  if (!secret) throw new Error("TRUARA_ENCRYPTION_KEY env var is required");
  const keyBytes = new TextEncoder().encode(secret).slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    new TextEncoder().encode(plaintext)
  );
  // Prefix iv (12 bytes) before ciphertext for decryption
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result;
}

/** Check complexity cap before persisting flow changes */
async function assertComplexityCap(
  supabase: ReturnType<typeof getServiceClient>,
  flowId: string,
  newQuestionCount: number
) {
  const { data: flow } = await supabase
    .from("truara_flows")
    .select("complexity_score, founder_id")
    .eq("id", flowId)
    .single();

  if (!flow) throw new Error("Flow not found");

  const { data: founder } = await supabase
    .from("truara_founders")
    .select("complexity_cap")
    .eq("id", flow.founder_id)
    .single();

  const cap = founder?.complexity_cap ?? 20;
  if (newQuestionCount > cap) {
    throw new Error(
      `Calm-mode complexity cap of ${cap} questions reached. ` +
        `Simplify the flow to stay sustainable.`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Create a new flow
// ─────────────────────────────────────────────────────────────
export const createFlow = createServerFn({ method: "POST" })
  .validator(CreateFlowSchema)
  .handler(async ({ data, context }) => {
    const supabase = getServiceClient();
    const { userId } = context as { userId: string };

    // Resolve founder row
    const { data: founder, error: founderErr } = await supabase
      .from("truara_founders")
      .select("id")
      .eq("auth_user_id", userId)
      .single();

    if (founderErr || !founder) {
      throw new Error("Founder profile not found. Please complete onboarding.");
    }

    const lgThreadId = `flow-${crypto.randomUUID()}`;

    const { data: flow, error } = await supabase
      .from("truara_flows")
      .insert({
        founder_id: founder.id,
        title: data.title,
        description: data.description ?? null,
        calm_mode: data.calmMode,
        lg_thread_id: lgThreadId,
        branding: data.branding ?? {},
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create flow: ${error.message}`);
    return { flow };
  });

// ─────────────────────────────────────────────────────────────
// 2. Retrieve a flow with all its questions
// ─────────────────────────────────────────────────────────────
export const getFlowWithQuestions = createServerFn({ method: "GET" })
  .validator(GetFlowWithQuestionsSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const [{ data: flow, error: flowErr }, { data: questions, error: qErr }] =
      await Promise.all([
        supabase
          .from("truara_flows")
          .select("*")
          .eq("id", data.flowId)
          .single(),
        supabase
          .from("truara_questions")
          .select("*")
          .eq("flow_id", data.flowId)
          .order("position"),
      ]);

    if (flowErr) throw new Error(flowErr.message);
    if (qErr) throw new Error(qErr.message);

    return { flow, questions: questions ?? [] };
  });

// ─────────────────────────────────────────────────────────────
// 3. Add a question to a flow (complexity-capped)
// ─────────────────────────────────────────────────────────────
export const addQuestion = createServerFn({ method: "POST" })
  .validator(AddQuestionSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const { count } = await supabase
      .from("truara_questions")
      .select("id", { count: "exact", head: true })
      .eq("flow_id", data.flowId);

    await assertComplexityCap(supabase, data.flowId, (count ?? 0) + 1);

    const { data: question, error } = await supabase
      .from("truara_questions")
      .insert({
        flow_id: data.flowId,
        position: data.position,
        question_type: data.questionType,
        title: data.title,
        description: data.description ?? null,
        placeholder: data.placeholder ?? null,
        required: data.required,
        config: data.config ?? {},
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return { question };
  });

// ─────────────────────────────────────────────────────────────
// 4. Start a new submission session
// ─────────────────────────────────────────────────────────────
export const startSubmission = createServerFn({ method: "POST" })
  .validator(StartSubmissionSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    // Upsert anonymous respondent via fingerprint
    const fp = data.respondentFingerprint
      ? await fingerprintValue(data.respondentFingerprint)
      : null;

    let respondentId: string;

    if (fp) {
      const { data: existing } = await supabase
        .from("truara_respondents")
        .select("id")
        .eq("fingerprint", fp)
        .maybeSingle();

      if (existing) {
        respondentId = existing.id;
      } else {
        const { data: r, error } = await supabase
          .from("truara_respondents")
          .insert({ fingerprint: fp })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        respondentId = r.id;
      }
    } else {
      const { data: r, error } = await supabase
        .from("truara_respondents")
        .insert({})
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      respondentId = r.id;
    }

    const lgThreadId = `sub-${crypto.randomUUID()}`;

    const { data: submission, error: subErr } = await supabase
      .from("truara_submissions")
      .insert({
        flow_id: data.flowId,
        respondent_id: respondentId,
        lg_thread_id: lgThreadId,
      })
      .select()
      .single();

    if (subErr) throw new Error(subErr.message);

    // Upsert memory thread (non-fatal: submission is already created)
    const { error: memErr } = await supabase.from("truara_memory_threads").upsert(
      {
        flow_id: data.flowId,
        respondent_id: respondentId,
        last_active_at: new Date().toISOString(),
      },
      { onConflict: "flow_id,respondent_id", ignoreDuplicates: false }
    );
    if (memErr) {
      console.error("Memory thread upsert failed:", memErr.message);
    }

    return { submissionId: submission.id, lgThreadId };
  });

// ─────────────────────────────────────────────────────────────
// 5. Determine next question via LangGraph (longitudinal memory)
// ─────────────────────────────────────────────────────────────
export const getNextQuestion = createServerFn({ method: "POST" })
  .validator(GetNextQuestionSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const { data: submission } = await supabase
      .from("truara_submissions")
      .select("flow_id, lg_thread_id, variable_snapshot")
      .eq("id", data.submissionId)
      .single();

    if (!submission) throw new Error("Submission not found");

    const [{ data: allQuestions }, { data: answeredRows }] = await Promise.all([
      supabase
        .from("truara_questions")
        .select("id, position, title, question_type, config, required")
        .eq("flow_id", submission.flow_id)
        .order("position"),
      supabase
        .from("truara_answers")
        .select("question_id")
        .eq("submission_id", data.submissionId),
    ]);

    const answeredIds = new Set((answeredRows ?? []).map((r) => r.question_id));
    const branchRules = await supabase
      .from("truara_branch_rules")
      .select("*")
      .eq("flow_id", submission.flow_id)
      .order("priority", { ascending: false });

    // Use LangGraph to determine next question with full memory context
    const graph = buildTruraFlowGraph(submission.lg_thread_id ?? "default");
    const graphInput: FlowGraphInput = {
      submissionId: data.submissionId,
      flowId: submission.flow_id,
      questions: allQuestions ?? [],
      answeredQuestionIds: Array.from(answeredIds),
      branchRules: branchRules.data ?? [],
      variableSnapshot: (submission.variable_snapshot as Record<string, number>) ?? {},
      lastAnsweredQuestionId: data.lastAnsweredQuestionId,
    };

    const result = await graph.invoke({ type: "next_question", payload: graphInput });

    return {
      nextQuestion: result.nextQuestion ?? null,
      isComplete: result.isComplete ?? false,
      anticipatedFollowUps: result.anticipatedFollowUps ?? [],
    };
  });

// ─────────────────────────────────────────────────────────────
// 6. Submit an answer (encrypted at rest)
// ─────────────────────────────────────────────────────────────
export const submitAnswer = createServerFn({ method: "POST" })
  .validator(SubmitAnswerSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const encryptedValue = await encryptValue(data.value);

    const { data: answer, error } = await supabase
      .from("truara_answers")
      .upsert(
        {
          submission_id: data.submissionId,
          question_id: data.questionId,
          value_enc: Buffer.from(encryptedValue),
          score: data.score ?? null,
        },
        { onConflict: "submission_id,question_id" }
      )
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Update submission timestamp
    await supabase
      .from("truara_submissions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", data.submissionId);

    return { answerId: answer.id };
  });

// ─────────────────────────────────────────────────────────────
// 7. Complete a submission + queue swarm analysis
// ─────────────────────────────────────────────────────────────
export const completeSubmission = createServerFn({ method: "POST" })
  .validator(CompleteSubmissionSchema)
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const { data: submission } = await supabase
      .from("truara_submissions")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", data.submissionId)
      .select("flow_id")
      .single();

    if (!submission) throw new Error("Submission not found");

    // Update memory thread
    await supabase
      .from("truara_memory_threads")
      .update({ last_active_at: new Date().toISOString() })
      .eq("flow_id", submission.flow_id);

    // Queue all swarm agent tasks in parallel
    const taskTypes: Array<
      | "tone_analysis"
      | "insight_summary"
      | "question_suggestion"
      | "follow_up_generation"
      | "swarm_refinement"
    > = [
      "tone_analysis",
      "insight_summary",
      "question_suggestion",
      "follow_up_generation",
      "swarm_refinement",
    ];

    await supabase.from("truara_swarm_tasks").insert(
      taskTypes.map((tt) => ({
        flow_id: submission.flow_id,
        submission_id: data.submissionId,
        task_type: tt,
      }))
    );

    return { success: true };
  });

// ─────────────────────────────────────────────────────────────
// 8. AI co-pilot: build an entire flow from natural language
// ─────────────────────────────────────────────────────────────
export const aiBuildFlow = createServerFn({ method: "POST" })
  .validator(AIBuildFlowSchema)
  .handler(async ({ data, context }) => {
    const supabase = getServiceClient();
    const { userId } = context as { userId: string };

    const { data: founder } = await supabase
      .from("truara_founders")
      .select("id, complexity_cap")
      .eq("auth_user_id", userId)
      .single();

    if (!founder) throw new Error("Founder profile not found.");

    const effectiveCap = Math.min(
      data.founderComplexityCap,
      founder.complexity_cap
    );

    // Build the LangGraph with an ephemeral thread for this generation
    const genThreadId = `gen-${crypto.randomUUID()}`;
    const graph = buildTruraFlowGraph(genThreadId);
    const result = await graph.invoke({
      type: "ai_build_flow",
      payload: {
        prompt: data.naturalLanguagePrompt,
        complexityCap: effectiveCap,
        calmMode: data.calmMode,
      },
    });

    const generatedFlow = result.generatedFlow as {
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

    if (!generatedFlow?.title || !generatedFlow?.questions?.length) {
      throw new Error("AI failed to generate a valid flow. Try a more specific prompt.");
    }

    // Persist the generated flow
    const lgThreadId = `flow-${crypto.randomUUID()}`;
    const { data: flow, error: flowErr } = await supabase
      .from("truara_flows")
      .insert({
        founder_id: founder.id,
        title: generatedFlow.title,
        description: generatedFlow.description,
        calm_mode: data.calmMode,
        lg_thread_id: lgThreadId,
        complexity_score: generatedFlow.questions.length,
      })
      .select()
      .single();

    if (flowErr) throw new Error(flowErr.message);

    // Insert generated questions
    if (generatedFlow.questions.length > 0) {
      const { error: qErr } = await supabase.from("truara_questions").insert(
        generatedFlow.questions.map((q) => ({
          flow_id: flow.id,
          position: q.position,
          question_type: q.question_type,
          title: q.title,
          required: q.required,
          config: q.config,
        }))
      );
      if (qErr) throw new Error(qErr.message);
    }

    return { flow, questionCount: generatedFlow.questions.length };
  });

// ─────────────────────────────────────────────────────────────
// 9. Publish / unpublish a flow
// ─────────────────────────────────────────────────────────────
export const setFlowStatus = createServerFn({ method: "POST" })
  .validator(
    z.object({
      flowId: z.string().uuid(),
      status: z.enum(["draft", "published", "archived", "paused"]),
    })
  )
  .handler(async ({ data }) => {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("truara_flows")
      .update({ status: data.status })
      .eq("id", data.flowId);

    if (error) throw new Error(error.message);
    return { success: true };
  });

// ─────────────────────────────────────────────────────────────
// 10. Retrieve swarm insights for a flow
// ─────────────────────────────────────────────────────────────
export const getSwarmInsights = createServerFn({ method: "GET" })
  .validator(z.object({ flowId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const supabase = getServiceClient();

    const { data: tasks } = await supabase
      .from("truara_swarm_tasks")
      .select("task_type, status, completed_at")
      .eq("flow_id", data.flowId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(50);

    return { insights: tasks ?? [] };
  });
